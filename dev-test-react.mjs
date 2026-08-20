// React 版 UI 交互测试：选区 / 模型栏 / 设置面板 / 密度
import { spawn } from 'node:child_process';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9667;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };

const chrome = spawn(CHROME, ['--headless', '--disable-gpu', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/ws-react-test', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  for (const host of ['[::1]', '127.0.0.1']) {
    try {
      const list = await (await fetch(`http://${host}:${PORT}/json/list`)).json();
      wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl;
    } catch {}
    if (wsUrl) break;
  }
  if (!wsUrl) await sleep(250);
}
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
let id = 0;
const pend = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } };
const send = (me, pa = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: me, params: pa })) });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;

await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:4173/#doc=dmt1bpm0p283231' });
// 等分页完成
for (let i = 0; i < 40; i++) {
  await sleep(500);
  if (await evalJs(`document.querySelectorAll('.pagedjs_page').length`) >= 4) break;
}
assert('分页渲染完成（≥4 页，行距收紧后页数减少）', await evalJs(`document.querySelectorAll('.pagedjs_page').length`) >= 4);

// 块点选
await evalJs(`(() => { const el = document.querySelector('#root .viewer-scroll p[data-block-id]'); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return el.dataset.blockId; })()`);
await sleep(400);
const sel1 = await evalJs(`JSON.stringify({
  highlighted: document.querySelectorAll('.doc-content .selected').length,
  tag: document.querySelector('.ant-tag')?.textContent || '',
})`);
const d1 = JSON.parse(sel1 || '{}');
assert('块点选高亮 + 选区 Tag', d1.highlighted >= 1 && d1.tag.includes('个块'));

// Shift 连选
await evalJs(`(() => {
  const els = [...document.querySelectorAll('.viewer-scroll [data-block-id]')];
  els[els.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
  return true; })()`);
await sleep(400);
const tag2 = await evalJs(`document.querySelector('.ant-tag')?.textContent || ''`);
assert('Shift 连选范围扩大', /等 \d+ 个块|\d+ 个块/.test(tag2) && !tag2.startsWith('1 个块'));

// 大纲选章
await evalJs(`(() => { const n = document.querySelectorAll('.ant-tree-title')[3]; n.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
await sleep(400);
const tag3 = await evalJs(`document.querySelector('.ant-tag')?.textContent || ''`);
assert('大纲选章', tag3.includes('个块'));

// 设置面板 + 密度开关
await evalJs(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent === '设置')?.click(); return true; })()`);
await sleep(600);
assert('设置面板打开（含密度 Segmented）', await evalJs(`!!document.querySelector('.ant-segmented')`));
await evalJs(`(() => { [...document.querySelectorAll('.ant-segmented-item')].find(s => s.textContent === '紧凑')?.click(); return true; })()`);
await sleep(400);
assert('密度切换生效', await evalJs(`localStorage.getItem('ws.density')`) === 'compact');
await evalJs(`(() => { document.querySelector('.ant-modal-close')?.click(); return true; })()`);

console.log(`\nRESULT pass=${pass} fail=${fail}`);
ws.close();
chrome.kill();
process.exit(fail ? 1 : 0);
