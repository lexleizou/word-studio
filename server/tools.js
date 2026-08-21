// AI 工具注册表 + 服务端工具循环
// 写工具一律「提案 → diff 预览 → 用户确认 → 执行 + git commit」：
// 执行时先在模型深拷贝上试算，diff 给用户看；确认后才写盘。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, log as gitLog } from './git-store.js';

// ---------- 模型辅助 ----------
export function flattenBlocks(model) {
  const out = [];
  const walk = (blocks) => {
    for (const b of blocks || []) {
      out.push(b);
      if (b.type === 'table') b.rows.flat().forEach(cell => walk(cell.blocks));
    }
  };
  walk(model?.blocks);
  return out;
}

export function blockText(block) {
  if (!block) return '';
  if (block.type === 'table') {
    return block.rows.map(row => row.map(cell => cell.blocks.map(blockText).join(' ')).join(' | ')).join('\n');
  }
  if (block.type === 'toc') return '[目录]';
  if (block.type === 'image') return `[图片 ${block.src}]`;
  if (block.type === 'pageBreak') return '[分页符]';
  return (block.runs || []).map(r => r.text).join('');
}

function outlineText(model) {
  return flattenBlocks(model)
    .filter(b => b.type === 'heading')
    .map(b => `${'  '.repeat(b.level - 1)}${blockText(b)} (${b.id})`)
    .join('\n') || '（无标题）';
}

function maxBlockNum(model) {
  return flattenBlocks(model).reduce((mx, b) => Math.max(mx, Number((b.id || '').slice(1)) || 0), 0);
}

// ---------- 工具定义（OpenAI function calling schema） ----------
export const toolSchemas = [
  { name: 'read_outline', description: '读取文档大纲（标题树，含块 id）', parameters: { type: 'object', properties: {} } },
  { name: 'read_block', description: '读取指定块的完整文本', parameters: { type: 'object', properties: { id: { type: 'string', description: '块 id，如 b12' } }, required: ['id'] } },
  { name: 'read_range', description: '读取一段范围内的块文本（按文档顺序）', parameters: { type: 'object', properties: { fromId: { type: 'string' }, toId: { type: 'string' } }, required: ['fromId', 'toId'] } },
  { name: 'patch_blocks', description: '【写】修改若干块的文本（整段替换，保留原首个 run 格式）', parameters: { type: 'object', properties: { patches: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, newText: { type: 'string' } }, required: ['id', 'newText'] } } }, required: ['patches'] } },
  { name: 'apply_style', description: '【写】给若干块应用段落样式或 run 级格式', parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, styleId: { type: 'string' }, inline: { type: 'object', description: 'run 级格式 {bold,italic,underline,color,size,font}' } }, required: ['id'] } } }, required: ['items'] } },
  { name: 'insert_block', description: '【写】在指定块之后插入新块', parameters: { type: 'object', properties: { afterId: { type: 'string' }, block: { type: 'object', description: '{type: heading|paragraph|list, text, level?}' } }, required: ['afterId', 'block'] } },
  { name: 'delete_blocks', description: '【写】删除若干顶层块', parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] } },
  { name: 'search_replace', description: '【写】全文或指定范围内查找替换', parameters: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' }, scope: { type: 'array', items: { type: 'string' }, description: '限定块 id 集合（来自用户选区）' } }, required: ['find', 'replace'] } },
  { name: 'update_style', description: '【写】修改样式表中的样式定义（字号/加粗/对齐/段距等）', parameters: { type: 'object', properties: { styleId: { type: 'string' }, props: { type: 'object' } }, required: ['styleId', 'props'] } },
  { name: 'update_page_setup', description: '【写】修改页面设置（纸张/边距/页眉/页脚/页码）', parameters: { type: 'object', properties: { props: { type: 'object' } }, required: ['props'] } },
  { name: 'git_commit', description: '提交一个 git 版本（自定义提交说明）', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
  { name: 'git_history', description: '查看最近提交历史', parameters: { type: 'object', properties: {} } },
  { name: 'import_file', description: '【写】把 @ 引用文件的内容导入文档（插入为若干段落）', parameters: { type: 'object', properties: { fileId: { type: 'string' }, afterId: { type: 'string', description: '插入位置（在该块之后）' } }, required: ['fileId', 'afterId'] } },
  { name: 'generate_image', description: '【写】用 AI 生成插图并插入文档（需要已登录的 Codex provider）。给出画面描述，可指定插入位置', parameters: { type: 'object', properties: { prompt: { type: 'string', description: '插图的画面描述（中文即可）' }, afterId: { type: 'string', description: '插入位置（在该块之后；省略则插到文档末尾）' }, widthMm: { type: 'number', description: '插图宽度 mm（可选，默认按内容区宽度的 80%）' } }, required: ['prompt'] } },
  { name: 'use_skill', description: '获取指定技能（SKILL.md）的完整指导文本', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
];

export const openAiTools = toolSchemas.map(t => ({ type: 'function', function: t }));

// 完整工具表 = 内置工具 + MCP 外部工具（mcp__ 命名空间）
export async function getOpenAiTools() {
  const { mcpToolSchemas } = await import('./mcp-manager.js');
  return [...openAiTools, ...mcpToolSchemas()];
}

// ---------- 读工具 ----------
async function execRead(name, args, ctx) {
  const { model, dir } = ctx;
  switch (name) {
    case 'read_outline': return outlineText(model);
    case 'use_skill': {
      const { getSkillBody } = await import('./skills.js');
      const body = await getSkillBody(args.name);
      return body ?? `技能 ${args.name} 不存在`;
    }
    case 'read_block': {
      const b = flattenBlocks(model).find(x => x.id === args.id);
      return b ? blockText(b) : `块 ${args.id} 不存在`;
    }
    case 'read_range': {
      const flat = flattenBlocks(model);
      const ia = flat.findIndex(x => x.id === args.fromId);
      const ib = flat.findIndex(x => x.id === args.toId);
      if (ia === -1 || ib === -1) return '范围 id 不存在';
      const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
      return flat.slice(lo, hi + 1).map(b => `[${b.id}] ${blockText(b)}`).join('\n');
    }
    case 'git_history': return gitLog(dir, 10).then(h => h.map(x => `${x.hash.slice(0, 7)} ${x.message}`).join('\n') || '（无提交）');
    default: return `未知读工具 ${name}`;
  }
}

// ---------- 写工具（在模型拷贝上试算） ----------
function execWrite(name, args, modelCopy) {
  const flat = flattenBlocks(modelCopy);
  switch (name) {
    case 'patch_blocks':
      for (const p of args.patches || []) {
        const b = flat.find(x => x.id === p.id);
        if (!b || !b.runs) continue;
        b.runs = [{ ...(b.runs[0] || {}), text: p.newText }];
      }
      return `已修改 ${(args.patches || []).length} 个块`;
    case 'apply_style':
      for (const it of args.items || []) {
        const b = flat.find(x => x.id === it.id);
        if (!b) continue;
        if (it.styleId) b.styleId = it.styleId;
        if (it.inline && b.runs) b.runs = b.runs.map(r => ({ ...r, ...it.inline }));
      }
      return `已设置 ${(args.items || []).length} 个块的格式`;
    case 'insert_block': {
      const spec = args.block || {};
      const newBlock = {
        id: 'b' + (maxBlockNum(modelCopy) + 1),
        type: ['heading', 'paragraph', 'list'].includes(spec.type) ? spec.type : 'paragraph',
        styleId: spec.type === 'heading' ? `Heading${Math.min(spec.level || 1, 4)}` : 'Normal',
        ...(spec.type === 'heading' ? { level: Math.min(spec.level || 1, 4) } : {}),
        ...(spec.type === 'list' ? { ordered: false, level: 0, index: 1 } : {}),
        runs: [{ text: spec.text || '' }],
      };
      const top = modelCopy.blocks;
      const idx = top.findIndex(x => x.id === args.afterId);
      if (idx === -1) top.push(newBlock); else top.splice(idx + 1, 0, newBlock);
      return `已插入块 ${newBlock.id}`;
    }
    case 'delete_blocks': {
      const ids = new Set(args.ids || []);
      modelCopy.blocks = modelCopy.blocks.filter(b => !ids.has(b.id));
      return `已删除 ${ids.size} 个块`;
    }
    case 'search_replace': {
      if (!args.find) return 'find 不能为空';
      const scope = args.scope?.length ? new Set(args.scope) : null;
      let count = 0;
      for (const b of flat) {
        if (scope && !scope.has(b.id)) continue;
        for (const r of b.runs || []) {
          if (r.text?.includes(args.find)) {
            count += r.text.split(args.find).length - 1;
            r.text = r.text.split(args.find).join(args.replace ?? '');
          }
        }
      }
      return `已替换 ${count} 处`;
    }
    case 'update_style': {
      const st = modelCopy.styles[args.styleId];
      if (!st) return `样式 ${args.styleId} 不存在`;
      Object.assign(st, args.props || {});
      return `已更新样式 ${args.styleId}`;
    }
    case 'update_page_setup': {
      deepMerge(modelCopy.pageSetup, args.props || {});
      return '已更新页面设置';
    }
    case 'git_commit':
      return '将在确认后提交: ' + args.message;
    case 'generate_image': {
      // 图片已在 executeTool 阶段生成并落地 assets，这里只插入 image 块
      const newBlock = {
        id: 'b' + (maxBlockNum(modelCopy) + 1),
        type: 'image',
        src: args._asset,
        ...(args.widthMm ? { widthMm: args.widthMm } : {}),
      };
      const top = modelCopy.blocks;
      const idx = top.findIndex(x => x.id === args.afterId);
      if (idx === -1) top.push(newBlock); else top.splice(idx + 1, 0, newBlock);
      return `已生成插图并插入（${newBlock.id}）`;
    }
    case 'import_file': {
      const paras = (args._refText || '').split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
      if (!paras.length) return '引用文件没有可导入的文本';
      const top = modelCopy.blocks;
      let idx = top.findIndex(x => x.id === args.afterId);
      if (idx === -1) idx = top.length - 1;
      let num = maxBlockNum(modelCopy);
      const newBlocks = paras.map(text => ({ id: 'b' + (++num), type: 'paragraph', styleId: 'Normal', runs: [{ text }] }));
      top.splice(idx + 1, 0, ...newBlocks);
      return `已导入 ${newBlocks.length} 个段落`;
    }
    default:
      return `未知写工具 ${name}`;
  }
}

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && target[k]) deepMerge(target[k], v);
    else target[k] = v;
  }
}

const WRITE_TOOLS = new Set(['patch_blocks', 'apply_style', 'insert_block', 'delete_blocks', 'search_replace', 'update_style', 'update_page_setup', 'git_commit', 'import_file', 'generate_image']);
export const isWriteTool = (name) => WRITE_TOOLS.has(name);

// ---------- diff ----------
export function diffModels(before, after) {
  const changes = [];
  const bf = new Map(flattenBlocks(before).map(b => [b.id, b]));
  const af = new Map(flattenBlocks(after).map(b => [b.id, b]));
  for (const [id, b] of af) {
    if (!bf.has(id)) changes.push({ type: 'add', id, after: blockText(b) });
    else if (blockText(bf.get(id)) !== blockText(b)) changes.push({ type: 'modify', id, before: blockText(bf.get(id)), after: blockText(b) });
    else if (JSON.stringify(bf.get(id)) !== JSON.stringify(b)) changes.push({ type: 'modify', id, before: '(格式变化)', after: '(格式变化)' });
  }
  for (const [id, b] of bf) if (!af.has(id)) changes.push({ type: 'remove', id, before: blockText(b) });
  if (JSON.stringify(before.styles) !== JSON.stringify(after.styles)) changes.push({ type: 'styles', before: '样式表有变化', after: '样式表有变化' });
  if (JSON.stringify(before.pageSetup) !== JSON.stringify(after.pageSetup)) changes.push({ type: 'pageSetup', before: '页面设置有变化', after: '页面设置有变化' });
  return changes;
}

// ---------- 系统 prompt ----------
export async function buildSystemPrompt(model, scope) {
  const { enabledSkillsPrompt } = await import('./skills.js');
  let prompt = `你是 Word Studio 的文档编辑助手。你可以读取和修改当前文档《${model.meta?.title || '未命名'}》。

文档大纲：
${outlineText(model)}

规则：
- 读工具随时可用；写工具（标注【写】的）会产生 diff 预览，用户确认后才真正落盘
- 修改文本用 patch_blocks（整段替换）；局部措辞调整也可用 search_replace
- 块 id 在大纲和 read_range 结果中标注
- 回复用中文，简洁说明做了什么`;
  prompt += await enabledSkillsPrompt();
  if (scope?.blockIds?.length) {
    const scopeSet = new Set(scope.blockIds);
    const texts = flattenBlocks(model).filter(b => scopeSet.has(b.id)).map(b => `[${b.id}] ${blockText(b)}`).join('\n');
    prompt += `

⚠️ 用户当前选中了以下范围，本轮所有写操作必须只落在这些块内（${scope.blockIds.join(', ')}）：
${texts}`;
  }
  return prompt;
}

// scope 校验：写工具涉及的块 id 必须在选区内
function scopeCheck(name, args, scope) {
  if (!scope?.blockIds?.length) return null;
  const allowed = new Set(scope.blockIds);
  const idsOf = {
    patch_blocks: (args.patches || []).map(p => p.id),
    apply_style: (args.items || []).map(i => i.id),
    insert_block: [args.afterId],
    generate_image: [args.afterId].filter(Boolean),
    delete_blocks: args.ids || [],
    search_replace: args.scope?.length ? args.scope : [...allowed],
  }[name];
  if (!idsOf) return null; // update_style / update_page_setup / git_commit 不限
  const bad = idsOf.filter(id => id && !allowed.has(id));
  return bad.length ? `选区限制：只能操作选区内的块（越界: ${bad.join(', ')}）` : null;
}

// ---------- 工具执行入口 ----------
// 读工具直接执行；写工具在拷贝上试算并产出提案 { toolName, args, modelCopy, diff, summary }
export async function executeTool(name, args, ctx) {
  const { model } = ctx;
  // MCP 外部工具：直通调用，作为读类结果反馈
  if (name.startsWith('mcp__')) {
    const { callMcpTool } = await import('./mcp-manager.js');
    return { kind: 'read', result: await callMcpTool(name, args) };
  }
  if (!isWriteTool(name)) {
    return { kind: 'read', result: await execRead(name, args, ctx) };
  }
  const err = scopeCheck(name, args, ctx.scope);
  if (err) return { kind: 'read', result: err }; // 越界按普通工具结果反馈给模型
  // generate_image 先生成图片落地 assets（拒绝提案时图片文件残留，容忍）
  if (name === 'generate_image') {
    const { generateImage } = await import('./image-gen.js');
    const buf = await generateImage(args.prompt || '');
    if (!buf) return { kind: 'read', result: '图片生成失败：未配置 Codex provider，或后端未返回图片' };
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(ctx.dir, 'assets'), { recursive: true });
    const fileName = 'gen-' + Date.now().toString(36) + '.png';
    await writeFile(join(ctx.dir, 'assets', fileName), buf);
    args._asset = 'assets/' + fileName;
  }
  // import_file 先取出引用文本
  if (name === 'import_file') {
    const { refText } = await import('./refs.js');
    const text = await refText(ctx.dir, args.fileId);
    if (!text) return { kind: 'read', result: '引用文件不存在或是图片（图片不能导入为文本）' };
    args._refText = text;
  }
  const modelCopy = JSON.parse(JSON.stringify(model));
  const summary = execWrite(name, args, modelCopy);
  const diff = diffModels(model, modelCopy);
  return { kind: 'proposal', toolName: name, args, modelCopy, diff, summary };
}

// 提案确认后落盘：写 model.json + git commit
export async function applyProposal(dir, proposal) {
  const message = proposal.toolName === 'git_commit' && proposal.args.message
    ? `ai: ${proposal.args.message}`
    : `ai: ${proposal.summary}`;
  await import('node:fs/promises').then(fs => fs.writeFile(join(dir, 'model.json'), JSON.stringify(proposal.modelCopy, null, 2)));
  const r = await commitAll(dir, message);
  return { committed: r.changed, message };
}

export { commitAll };
