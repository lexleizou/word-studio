// Word Studio 服务端入口：静态服务 + /api 路由（裸 node:http，零框架）
import http from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { importDocx } from './doc-import.js';
import { exportDocx } from './docx-export.js';
import { initRepo, commitAll, checkout as gitCheckout, log as gitLog } from './git-store.js';
import { getProviders, saveProviders, getActiveProviderId, setActiveProviderId, getActiveProvider, getSession, appendSession } from './config-store.js';
import { chatCompletions } from './llm.js';
import { openAiTools, getOpenAiTools, executeTool, applyProposal, buildSystemPrompt } from './tools.js';
import { addRef, listRefs, buildAttachment } from './refs.js';
import { scanSkills, setSkillEnabled, importSkill } from './skills.js';
import { reloadMcp, loadConfig as loadMcpConfig, saveConfig as saveMcpConfig, getStatus as getMcpStatus } from './mcp-manager.js';
import { startDeviceLogin, pollDeviceLogin, copilotStatus, copilotLogout } from './copilot-auth.js';
import { exportPdf } from './pdf-export.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// React 构建产物优先（antd 版 UI），旧版 web/ 兜底
const DIST_DIR = join(ROOT, 'web-dist');
const WEB_DIR = join(ROOT, 'web');
const DATA_DIR = join(ROOT, 'data');
const PORT = Number(process.env.PORT || 4173);

let staticDir = WEB_DIR;
try {
  const { existsSync } = await import('node:fs');
  if (existsSync(join(DIST_DIR, 'index.html'))) staticDir = DIST_DIR;
} catch { /* 用兜底目录 */ }
const WORKSPACES = join(DATA_DIR, 'workspaces');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 极简 multipart 解析：仅支持 v1 的单文件上传场景
function parseMultipart(body, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (!boundary) throw new Error('multipart 缺 boundary');
  const sep = Buffer.from('--' + boundary);
  const files = [];
  let pos = body.indexOf(sep);
  while (pos !== -1) {
    const next = body.indexOf(sep, pos + sep.length);
    if (next === -1) break;
    const part = body.subarray(pos + sep.length, next);
    pos = next;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const header = part.subarray(0, headerEnd).toString('utf8');
    const name = /name="([^"]+)"/.exec(header)?.[1];
    const filename = /filename="([^"]*)"/.exec(header)?.[1];
    // 去掉尾部 \r\n
    let content = part.subarray(headerEnd + 4);
    if (content.subarray(-2).toString() === '\r\n') content = content.subarray(0, -2);
    if (filename) files.push({ field: name, filename, content });
  }
  return files;
}

const newDocId = () => 'd' + Date.now().toString(36) + randomBytes(3).toString('hex');
const safeDocId = (id) => /^[a-zA-Z0-9_-]+$/.test(id || '');

// 待确认的写工具提案：proposalId -> { resolve }
const pendingProposals = new Map();
let proposalSeq = 0;

function waitConfirm(proposalId, timeoutMs = 180000) {
  return new Promise((resolve) => {
    pendingProposals.set(proposalId, { resolve });
    setTimeout(() => {
      if (pendingProposals.delete(proposalId)) resolve(false); // 超时按拒绝处理
    }, timeoutMs);
  });
}

// ---------- AI 对话工具循环 ----------
async function runChatLoop(docId, dir, body, send) {
  const provider = await getActiveProvider();
  if (!provider) { send('error', { message: '未配置 LLM provider：请在右上角「设置」里添加并激活一个 endpoint' }); return; }
  if (!provider.model) { send('error', { message: `provider「${provider.name}」未填写模型名` }); return; }

  let model;
  try {
    model = JSON.parse(await readFile(join(dir, 'model.json'), 'utf8'));
  } catch {
    send('error', { message: '文档不存在' });
    return;
  }
  const selection = body.selection && (body.selection.blockIds?.length || body.selection.blockId) ? body.selection : null;

  // @ 引用文件：文本注入上下文，图片走多模态附件
  let userContent = body.message;
  const images = [];
  for (const refId of body.refIds || []) {
    const att = await buildAttachment(dir, refId);
    if (!att) continue;
    if (att.type === 'text') userContent += `\n\n<附件 name="${att.name}">\n${att.text}\n</附件>`;
    else images.push(att);
  }
  const userMessage = images.length
    ? { role: 'user', content: [{ type: 'text', text: userContent }, ...images.map(i => ({ type: 'image_url', image_url: { url: i.dataUrl } }))] }
    : { role: 'user', content: userContent };

  const session = await getSession(docId);
  const messages = [
    { role: 'system', content: await buildSystemPrompt(model, selection) },
    ...session,
    userMessage,
  ];
  const ctx = { dir, model, scope: selection };

  let iterations = 0;
  let assistantText = '';
  const usageSum = { prompt: 0, completion: 0, rounds: 0 }; // 工具循环每轮都是一次完整上下文，累计
  const toolNames = [];
  const doneMeta = () => ({
    model: provider.model || '',
    usage: usageSum.rounds ? { prompt: usageSum.prompt, completion: usageSum.completion, total: usageSum.prompt + usageSum.completion } : null,
    tools: { count: toolNames.length, names: toolNames.slice(0, 2), all: toolNames },
  });
  while (iterations++ < 8) {
    assistantText = '';
    const toolResults = [];
    await chatCompletions({
      provider,
      messages,
      tools: await getOpenAiTools(),
      onDelta: (t) => { assistantText += t; send('delta', { text: t }); },
      onDone: (u) => {
        if (u) {
          usageSum.prompt += u.prompt_tokens || 0;
          usageSum.completion += u.completion_tokens || 0;
          usageSum.rounds++;
        }
      },
      onToolCallDone: async (tc) => {
        toolNames.push(tc.name);
        send('tool', { name: tc.name });
        let args;
        try { args = JSON.parse(tc.arguments || '{}'); } catch { args = {}; }
        const out = await executeTool(tc.name, args, ctx);
        if (out.kind === 'read') {
          toolResults.push({ tc, result: String(out.result) });
          return;
        }
        // 写工具：出 diff 预览，等待用户确认
        const proposalId = 'p' + (++proposalSeq);
        send('proposal', { proposalId, toolName: out.toolName, summary: out.summary, diff: out.diff });
        const accepted = await waitConfirm(proposalId);
        if (accepted) {
          const applied = await applyProposal(dir, out);
          ctx.model = out.modelCopy;
          send('applied', { summary: out.summary, message: applied.message });
          toolResults.push({ tc, result: '用户已确认，改动已落盘并提交 git。' });
        } else {
          send('rejected', { summary: out.summary });
          toolResults.push({ tc, result: '用户拒绝了这次修改。' });
        }
      },
    });

    if (toolResults.length) {
      messages.push({
        role: 'assistant',
        content: assistantText || null,
        tool_calls: toolResults.map(r => ({ id: r.tc.id, type: 'function', function: { name: r.tc.name, arguments: r.tc.arguments } })),
      });
      for (const r of toolResults) messages.push({ role: 'tool', tool_call_id: r.tc.id, content: r.result });
      continue; // 把工具结果喂回去继续循环
    }
    // 纯文本回复 → 收尾
    await appendSession(docId, [{ role: 'user', content: body.message }, { role: 'assistant', content: assistantText }]);
    send('done', doneMeta());
    return;
  }
  send('done', { ...doneMeta(), maxIterations: true });
}

// .doc → .docx（LibreOffice headless；缺失时给出明确指引）
async function convertDocToDocx(srcPath, destDir) {
  try {
    await run('soffice', ['--headless', '--convert-to', 'docx', '--outdir', destDir, srcPath], { timeout: 120000 });
  } catch (err) {
    if (err.code === 'ENOENT') {
      const e = new Error('导入 .doc 需要 LibreOffice：请安装后重试（brew install --cask libreoffice），或直接上传 .docx');
      e.status = 400;
      throw e;
    }
    throw err;
  }
  return join(destDir, basename(srcPath, '.doc') + '.docx');
}

async function handleApi(req, res, url) {
  // GET /api/health
  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, name: 'word-studio', version: '0.1.0', time: new Date().toISOString() });
    return;
  }

  // GET /api/docs —— 文档列表
  if (url.pathname === '/api/docs' && req.method === 'GET') {
    let docs = [];
    try {
      for (const id of await readdir(WORKSPACES)) {
        if (!safeDocId(id)) continue;
        try {
          const model = JSON.parse(await readFile(join(WORKSPACES, id, 'model.json'), 'utf8'));
          const st = await stat(join(WORKSPACES, id, 'model.json'));
          docs.push({ id, name: model.meta?.title || id, mtime: st.mtimeMs });
        } catch { /* 半成品 workspace 跳过 */ }
      }
    } catch { /* workspaces 目录还不存在 */ }
    docs.sort((a, b) => b.mtime - a.mtime);
    sendJson(res, 200, { ok: true, docs });
    return;
  }

  // POST /api/docs/import —— 上传 docx/doc 导入
  if (url.pathname === '/api/docs/import' && req.method === 'POST') {
    const files = parseMultipart(await readBody(req), req.headers['content-type'] || '');
    const file = files[0];
    if (!file) { sendJson(res, 400, { ok: false, error: 'missing_file', message: '请求里没有文件' }); return; }
    if (!/\.(docx|doc)$/i.test(file.filename)) {
      sendJson(res, 400, { ok: false, error: 'bad_type', message: '只支持 .docx / .doc 文件' });
      return;
    }
    const docId = newDocId();
    const dir = join(WORKSPACES, docId);
    await import('node:fs/promises').then(fs => fs.mkdir(dir, { recursive: true }));
    let docxPath = join(dir, 'upload' + extname(file.filename));
    await import('node:fs/promises').then(fs => fs.writeFile(docxPath, file.content));
    try {
      if (/\.doc$/i.test(file.filename)) docxPath = await convertDocToDocx(docxPath, dir);
      const model = await importDocx(dir, docxPath, file.filename);
      await initRepo(dir);
      sendJson(res, 200, { ok: true, id: docId, name: model.meta.title, blocks: model.blocks.length });
    } catch (err) {
      console.error('[import] 失败:', err);
      sendJson(res, err.status || 500, { ok: false, error: 'import_failed', message: err.message });
    }
    return;
  }

  // /api/docs/:id/...
  const m = /^\/api\/docs\/([a-zA-Z0-9_-]+)(\/.*)?$/.exec(url.pathname);
  if (m && safeDocId(m[1])) {
    const docId = m[1];
    const sub = m[2] || '/';
    const dir = join(WORKSPACES, docId);

    if (sub === '/model' && req.method === 'GET') {
      try {
        const model = JSON.parse(await readFile(join(dir, 'model.json'), 'utf8'));
        sendJson(res, 200, { ok: true, id: docId, model });
      } catch {
        sendJson(res, 404, { ok: false, error: 'not_found' });
      }
      return;
    }

    // POST /api/docs/:id/model —— 模型写回（手动编辑 / 格式调整 / AI 改动共用），写盘后 git commit
    if (sub === '/model' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch {
        sendJson(res, 400, { ok: false, error: 'bad_json' });
        return;
      }
      const model = body.model;
      if (!model || !Array.isArray(model.blocks) || typeof model.styles !== 'object' || !model.pageSetup) {
        sendJson(res, 400, { ok: false, error: 'bad_model', message: 'model 必须包含 blocks/styles/pageSetup' });
        return;
      }
      try {
        await import('node:fs/promises').then(fs => fs.writeFile(join(dir, 'model.json'), JSON.stringify(model, null, 2)));
        const result = await commitAll(dir, body.message || 'update: 模型更新');
        sendJson(res, 200, { ok: true, committed: result.changed });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: 'write_failed', message: err.message });
      }
      return;
    }

    if (sub === '/history' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, history: await gitLog(dir) });
      return;
    }

    // POST /api/docs/:id/checkout —— 回退到指定 commit（回退本身也是一个新 commit）
    if (sub === '/checkout' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch {
        sendJson(res, 400, { ok: false, error: 'bad_json' });
        return;
      }
      if (!/^[0-9a-f]{7,40}$/.test(body.hash || '')) {
        sendJson(res, 400, { ok: false, error: 'bad_hash' });
        return;
      }
      try {
        await gitCheckout(dir, body.hash);
        const model = JSON.parse(await readFile(join(dir, 'model.json'), 'utf8'));
        sendJson(res, 200, { ok: true, model });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: 'checkout_failed', message: err.message });
      }
      return;
    }

    // GET /api/docs/:id/export.docx —— 从模型生成并下载 docx
    if (sub === '/export.docx' && req.method === 'GET') {
      try {
        const model = JSON.parse(await readFile(join(dir, 'model.json'), 'utf8'));
        const { buffer, fileName } = await exportDocx(dir, model);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        });
        res.end(buffer);
      } catch (err) {
        console.error('[export] 失败:', err);
        sendJson(res, 500, { ok: false, error: 'export_failed', message: err.message });
      }
      return;
    }

    // GET /api/docs/:id/refs —— 引用文件清单
    if (sub === '/refs' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, refs: await listRefs(dir) });
      return;
    }

    // POST /api/docs/:id/refs —— 上传引用文件
    if (sub === '/refs' && req.method === 'POST') {
      const files = parseMultipart(await readBody(req), req.headers['content-type'] || '');
      const file = files[0];
      if (!file) { sendJson(res, 400, { ok: false, error: 'missing_file' }); return; }
      try {
        const meta = await addRef(dir, file.filename, file.content);
        sendJson(res, 200, { ok: true, ref: meta });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: 'ref_failed', message: err.message });
      }
      return;
    }

    // GET /api/docs/:id/files —— 文件面板：主文档 / 引用 / 导出产物
    if (sub === '/files' && req.method === 'GET') {
      let model = null;
      try { model = JSON.parse(await readFile(join(dir, 'model.json'), 'utf8')); } catch { /* 无模型 */ }
      let exports = [];
      try {
        exports = (await readdir(join(dir, 'exports'))).map(name => ({ name, kind: 'export' }));
      } catch { /* 无导出目录 */ }
      sendJson(res, 200, {
        ok: true,
        files: [
          { name: model?.meta?.sourceFile || '主文档', kind: 'main' },
          ...(await listRefs(dir)).map(r => ({ name: r.name, kind: 'ref', id: r.id })),
          ...exports,
        ],
      });
      return;
    }

    // GET /api/docs/:id/export.pdf —— 预览页打印为 PDF
    if (sub === '/export.pdf' && req.method === 'GET') {
      try {
        const model = JSON.parse(await readFile(join(dir, 'model.json'), 'utf8'));
        const buffer = await exportPdf(docId, `http://127.0.0.1:${PORT}`);
        const fileName = `${(model.meta?.title || 'document').replace(/[\\/:*?"<>|]/g, '_')}.pdf`;
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        });
        res.end(buffer);
      } catch (err) {
        console.error('[export pdf] 失败:', err);
        sendJson(res, 500, { ok: false, error: 'pdf_failed', message: err.message });
      }
      return;
    }

    if (sub.startsWith('/assets/') && req.method === 'GET') {
      const name = basename(sub); // 防穿越
      try {
        const content = await readFile(join(dir, 'assets', name));
        res.writeHead(200, { 'Content-Type': MIME[extname(name).toLowerCase()] || 'application/octet-stream' });
        res.end(content);
      } catch {
        sendJson(res, 404, { ok: false, error: 'not_found' });
      }
      return;
    }
  }

  // GET /api/config/providers —— provider 列表 + 当前激活
  if (url.pathname === '/api/config/providers' && req.method === 'GET') {
    const providers = await getProviders();
    // Copilot 已登录但列表里没有对应 provider 时自动补入
    if ((await copilotStatus()).loggedIn && !providers.some(p => p.type === 'copilot')) {
      providers.push({ id: 'copilot', name: 'GitHub Copilot', type: 'copilot', baseUrl: '(api.githubcopilot.com)', apiKey: '', model: 'gpt-4o' });
      await saveProviders(providers);
    }
    // apiKey 不回传明文，只回传是否已配置
    sendJson(res, 200, {
      ok: true,
      providers: providers.map(p => ({ ...p, apiKey: undefined, hasKey: !!p.apiKey })),
      activeProviderId: await getActiveProviderId(),
    });
    return;
  }

  // POST /api/config/providers —— 保存 provider 列表 + 激活项
  if (url.pathname === '/api/config/providers' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      sendJson(res, 400, { ok: false, error: 'bad_json' });
      return;
    }
    const old = await getProviders();
    const providers = (body.providers || []).map(p => {
      // apiKey 留空表示沿用原值；models/enabled 未传时沿用
      const prev = old.find(o => o.id === p.id);
      return {
        id: p.id, name: p.name, type: p.type || 'openai-compat', baseUrl: p.baseUrl,
        apiKey: p.apiKey || prev?.apiKey || '', model: p.model,
        models: Array.isArray(p.models) ? p.models : (prev?.models || []),
        availableModels: Array.isArray(p.availableModels) ? p.availableModels : (prev?.availableModels || []),
        enabled: p.enabled ?? prev?.enabled ?? true,
      };
    });
    await saveProviders(providers);
    if (body.activeProviderId) await setActiveProviderId(body.activeProviderId);
    sendJson(res, 200, { ok: true });
    return;
  }

  // POST /api/chat/confirm —— 提案确认/拒绝
  if (url.pathname === '/api/chat/confirm' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      sendJson(res, 400, { ok: false, error: 'bad_json' });
      return;
    }
    const pending = pendingProposals.get(body.proposalId);
    if (!pending) { sendJson(res, 404, { ok: false, error: 'proposal_not_found' }); return; }
    pendingProposals.delete(body.proposalId);
    pending.resolve(!!body.accept);
    sendJson(res, 200, { ok: true });
    return;
  }

  // POST /api/docs/:id/chat —— SSE 对话（工具循环在服务端）
  const chatMatch = /^\/api\/docs\/([a-zA-Z0-9_-]+)\/chat$/.exec(url.pathname);
  if (chatMatch && req.method === 'POST') {
    const docId = chatMatch[1];
    const dir = join(WORKSPACES, docId);
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      sendJson(res, 400, { ok: false, error: 'bad_json' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      await runChatLoop(docId, dir, body, send);
    } catch (err) {
      console.error('[chat] 失败:', err);
      send('error', { message: err.message });
    }
    res.end();
    return;
  }

  // GET /api/skills —— 技能清单
  if (url.pathname === '/api/skills' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, skills: await scanSkills() });
    return;
  }

  // POST /api/skills/toggle —— 启停
  if (url.pathname === '/api/skills/toggle' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    await setSkillEnabled(body.name, body.enabled);
    sendJson(res, 200, { ok: true });
    return;
  }

  // POST /api/skills/import —— 导入 .md（JSON {fileName, content}）
  if (url.pathname === '/api/skills/import' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const r = await importSkill(body.fileName || 'skill.md', body.content || '');
      sendJson(res, 200, { ok: true, name: r.name });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: 'import_failed', message: err.message });
    }
    return;
  }

  // GET /api/mcp —— MCP 配置 + 连接状态
  if (url.pathname === '/api/mcp' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, config: await loadMcpConfig(), status: getMcpStatus() });
    return;
  }

  // POST /api/mcp —— 保存配置并重连
  if (url.pathname === '/api/mcp' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    await saveMcpConfig(body.config || { servers: {} });
    await reloadMcp();
    sendJson(res, 200, { ok: true, status: getMcpStatus() });
    return;
  }

  // Copilot OAuth（多账号：accountId = provider 实例 id）：状态 / 设备码发起 / 轮询 / 登出
  if (url.pathname === '/api/copilot/status' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, ...(await copilotStatus(url.searchParams.get('accountId') || 'copilot')) });
    return;
  }
  if (url.pathname === '/api/copilot/login/start' && req.method === 'POST') {
    const body = await readBody(req).catch(() => '{}');
    const accountId = JSON.parse(body || '{}').accountId || 'copilot';
    try {
      sendJson(res, 200, { ok: true, ...(await startDeviceLogin(accountId)) });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: 'device_code_failed', message: err.message });
    }
    return;
  }
  if (url.pathname === '/api/copilot/login/poll' && req.method === 'POST') {
    const body = await readBody(req).catch(() => '{}');
    const accountId = JSON.parse(body || '{}').accountId || 'copilot';
    sendJson(res, 200, { ok: true, ...(await pollDeviceLogin(accountId)) });
    return;
  }
  if (url.pathname === '/api/copilot/logout' && req.method === 'POST') {
    const body = await readBody(req).catch(() => '{}');
    await copilotLogout(JSON.parse(body || '{}').accountId || 'copilot');
    // 只清该账号 token；provider 条目由用户在界面上自行删除
    sendJson(res, 200, { ok: true });
    return;
  }

  // Codex（ChatGPT 账号）OAuth：状态 / 发起（授权 URL + 本地回调）/ 轮询 / 登出
  if (url.pathname === '/api/codex/status' && req.method === 'GET') {
    const { codexStatus } = await import('./codex-auth.js');
    sendJson(res, 200, { ok: true, ...(await codexStatus(url.searchParams.get('accountId') || 'codex')) });
    return;
  }
  if (url.pathname === '/api/codex/login/start' && req.method === 'POST') {
    const body = await readBody(req).catch(() => '{}');
    const accountId = JSON.parse(body || '{}').accountId || 'codex';
    const { startCodexLogin } = await import('./codex-auth.js');
    try {
      sendJson(res, 200, { ok: true, ...(await startCodexLogin(accountId)) });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: 'codex_login_failed', message: err.message });
    }
    return;
  }
  if (url.pathname === '/api/codex/login/poll' && req.method === 'POST') {
    const body = await readBody(req).catch(() => '{}');
    const accountId = JSON.parse(body || '{}').accountId || 'codex';
    const { pollCodexLogin } = await import('./codex-auth.js');
    sendJson(res, 200, { ok: true, ...(await pollCodexLogin(accountId)) });
    return;
  }
  if (url.pathname === '/api/codex/logout' && req.method === 'POST') {
    const body = await readBody(req).catch(() => '{}');
    const { codexLogout } = await import('./codex-auth.js');
    await codexLogout(JSON.parse(body || '{}').accountId || 'codex');
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /api/config/models?providerId=xx —— 从 provider 拉可用模型列表（/models）
  if (url.pathname === '/api/config/models' && req.method === 'GET') {
    const providerId = url.searchParams.get('providerId');
    const providers = await getProviders();
    const p = providers.find(x => x.id === providerId);
    if (!p) { sendJson(res, 404, { ok: false, error: 'provider_not_found' }); return; }
    try {
      let models;
      if (p.type === 'copilot') {
        const { getCopilotToken, COPILOT_API_BASE } = await import('./copilot-auth.js');
        const token = await getCopilotToken(p.id); // 多账号：按 provider 实例取 token
        const r = await fetch(COPILOT_API_BASE + '/models', {
          headers: { Authorization: `Bearer ${token}`, 'Editor-Version': 'vscode/1.95.0', 'User-Agent': 'GitHubCopilotChat/0.26.7' },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        models = (await r.json()).data?.map(m => m.id) || [];
      } else if (p.type === 'codex') {
        const { listCodexModels } = await import('./codex-auth.js');
        models = await listCodexModels(p.id); // 真实后端列表（{id,label}）
      } else {
        const r = await fetch(p.baseUrl.replace(/\/+$/, '') + '/models', {
          headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        models = (await r.json()).data?.map(m => m.id) || [];
      }
      sendJson(res, 200, { ok: true, models });
    } catch (err) {
      sendJson(res, 200, { ok: true, models: [], warning: `模型列表拉取失败: ${err.message}` });
    }
    return;
  }

  // POST /api/config/probe —— 未保存的端点探测：测试连接 + 拉可用模型列表（添加模型配置页用）
  if (url.pathname === '/api/config/probe' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { sendJson(res, 400, { ok: false, error: 'bad_json' }); return; }
    const t0 = Date.now();
    try {
      let models;
      if (body.type === 'copilot') {
        // Copilot：用该账号槽位的 OAuth token 拉 /models（未登录在 getCopilotToken 抛错）
        const { getCopilotToken, COPILOT_API_BASE } = await import('./copilot-auth.js');
        const token = await getCopilotToken(body.accountId || 'copilot');
        const r = await fetch(COPILOT_API_BASE + '/models', {
          headers: { Authorization: `Bearer ${token}`, 'Editor-Version': 'vscode/1.95.0', 'User-Agent': 'GitHubCopilotChat/0.26.7' },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        models = (await r.json()).data?.map(m => m.id) || [];
      } else if (body.type === 'codex') {
        const { listCodexModels } = await import('./codex-auth.js');
        models = await listCodexModels(body.accountId || 'codex'); // 真实后端列表（{id,label}）
        if (!models.length) {
          sendJson(res, 200, { ok: true, models, latencyMs: Date.now() - t0, warning: '该账号的 Codex 模型目录为空：通常表示此 ChatGPT 账号未开通 Codex 权限（需 Plus/Pro/Team 等计划）' });
          return;
        }
      } else {
        if (!body.baseUrl) { sendJson(res, 200, { ok: false, error: 'baseUrl 为空' }); return; }
        const r = await fetch(String(body.baseUrl).replace(/\/+$/, '') + '/models', {
          headers: body.apiKey ? { Authorization: `Bearer ${body.apiKey}` } : {},
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        models = (await r.json()).data?.map(m => m.id) || [];
      }
      sendJson(res, 200, { ok: true, models, latencyMs: Date.now() - t0 });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: `连接失败: ${err.message}` });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not_found', path: url.pathname });
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = normalize(join(staticDir, pathname)); // 防目录穿越
  if (!filePath.startsWith(staticDir)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    sendJson(res, 404, { ok: false, error: 'not_found', path: pathname });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (err) {
    console.error('[server] 未捕获错误:', err);
    sendJson(res, 500, { ok: false, error: 'internal_error', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[word-studio] 已启动: http://127.0.0.1:${PORT}`);
  reloadMcp().catch(err => console.error('[mcp] 初始化失败:', err.message));
});
