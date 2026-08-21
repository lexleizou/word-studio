// 表格单元格就地编辑测试：编辑模式 → 点单元格段落 → 改字 → 提交 → 校验模型
// 前置：服务已启动，文档 dmt223x7n0ecd1d（URS v7，含签批表）
import { spawn } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9560;
const DOC = 'dmt223x7n0ecd1d';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };

// 拿模型里第一个表格的首个有文本的单元格段落 id
const model = (await (await fetch(`http://127.0.0.1:4173/api/docs/${DOC}/model`)).json()).model;
// 记录当前 head，测试结束回滚（单元格编辑会产生真实 commit）
const headBefore = (await (await fetch(`http://127.0.0.1:4173/api/docs/${DOC}/history`)).json()).history?.[0]?.hash;
const tbl = model.blocks.find(b => b.type === 'table' && b.rows.length > 2);
let target = null;
outer: for (const row of tbl.rows) {
  for (const cell of row) {
    const b = cell.blocks.find(x => (x.runs || []).some(r => r.text?.trim()));
    if (b) { target = { id: b.id, text: b.runs.map(r => r.text).join('') }; break outer; }
  }
}
console.log('目标单元格块:', JSON.stringify(target));

// 清场：同端口僵尸 Chrome 会让 /json/list 连到旧实例（带着旧页面缓存）
try { (await import('node:child_process')).execSync(`lsof -ti :${PORT} | xargs kill 2>/dev/null || true`); await sleep(500); } catch {}

const chrome = spawn(CHROME, ['--headless', '--disable-gpu', `--remote-debugging-port=${PORT}`, '--window-size=1500,1000', '--user-data-dir=/tmp/ws-cdp-cell', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  for (const host of ['[::1]', '127.0.0.1']) {
    try { wsUrl = (await (await fetch(`http://${host}:${PORT}/json/list`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl; } catch {}
  }
  if (!wsUrl) await sleep(250);
}
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
let msgId = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') pageErrors.push((m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 800));
};
const send = (method, params = {}) => new Promise(r => { const id = ++msgId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:4173/#doc=${DOC}` });
// 渲染慢（逐页页眉注入）：等到目标块出现为止，而不是只等第一页
for (let i = 0; i < 90; i++) {
  await sleep(500);
  if (await evalJs(`!!document.querySelector('[data-block-id="${target.id}"]')`)) break;
}
await sleep(1000);

// 开启编辑模式
await evalJs(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent.includes('编') && b.textContent.includes('辑'))?.click(); return true; })()`);
await sleep(800);

console.log('页面错误:', pageErrors.join(' | ') || '(无)');
console.log('b4 等待后存在:', await evalJs(`!!document.querySelector('[data-block-id="${target.id}"]')`), 'pages:', await evalJs(`document.querySelectorAll('.pagedjs_page').length`));
console.log('编辑模式点击后:', await evalJs(`JSON.stringify({
  pages: document.querySelectorAll('.pagedjs_page').length,
  blockEls: document.querySelectorAll('[data-block-id]').length,
  hasB4: !!document.querySelector('[data-block-id="${target.id}"]'),
  skeleton: !!document.querySelector('.ant-skeleton'),
})`));

// 点击目标单元格段落进入编辑
const clicked = await evalJs(`(() => {
  const el = document.querySelector('[data-block-id="${target.id}"]');
  if (!el) return 'not-found';
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return el.tagName;
})()`);
await sleep(500);
const editing = await evalJs(`(() => {
  const el = document.querySelector('[data-block-id="${target.id}"]');
  return { isEditable: el ? el.contentEditable : null, cls: el ? el.className : null };
})()`);
console.log('点击结果:', clicked, '编辑态:', JSON.stringify(editing));
assert('单元格段落可进入编辑态（contentEditable）', editing.isEditable === 'true');

// 修改文本（在末尾追加标记）并回车提交
const MARK = '单元格编辑验证' + Date.now() % 10000;
await evalJs(`(() => {
  const el = document.querySelector('[data-block-id="${target.id}"]');
  const sp = el.querySelector('[data-run-idx]');
  sp.innerText = sp.innerText + '${MARK}';
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return true;
})()`);
await sleep(2500);

const after = (await (await fetch(`http://127.0.0.1:4173/api/docs/${DOC}/model`)).json()).model;
const flat = [];
const walk = (bs) => { for (const b of bs || []) { flat.push(b); if (b.type === 'table') b.rows.flat().forEach(c => walk(c.blocks)); } };
walk(after.blocks);
const nb = flat.find(b => b.id === target.id);
const newText = (nb?.runs || []).map(r => r.text).join('');
assert('单元格文本已写回模型', newText.includes(MARK));

console.log(`\nRESULT pass=${pass} fail=${fail}`);
// 回滚测试编辑（checkout 本身是"回退式新 commit"，不改变历史）
if (headBefore) {
  await fetch(`http://127.0.0.1:4173/api/docs/${DOC}/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hash: headBefore }),
  });
}
ws.close();
chrome.kill();
process.exit(fail ? 1 : 0);
