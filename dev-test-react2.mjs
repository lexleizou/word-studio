// React 版 UI 交互测试（第二批）：格式操作 / 编辑模式 / 历史 / 文件面板
import { spawn } from 'node:child_process';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9668;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const DOC = 'dmt1bpm0p283231';

const chrome = spawn(CHROME, ['--headless', '--disable-gpu', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/ws-react-test2', 'about:blank'], { stdio: 'ignore' });
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
const getModel = async () => (await (await fetch(`http://127.0.0.1:4173/api/docs/${DOC}/model`)).json()).model;

await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:4173/#doc=${DOC}` });
for (let i = 0; i < 40; i++) {
  await sleep(500);
  if (await evalJs(`document.querySelectorAll('.pagedjs_page').length`) >= 6) break;
}
assert('分页渲染完成', await evalJs(`document.querySelectorAll('.pagedjs_page').length`) >= 6);

// --- 格式操作：块选 → 粗体（切换语义，跑多次会开/关交替，验证 run 结构变化 + commit 即可） ---
const bid = await evalJs(`(() => { const el = document.querySelector('.viewer-scroll p[data-block-id]'); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return el.dataset.blockId; })()`);
await sleep(300);
const runsBefore = JSON.stringify((await getModel()).blocks.find(b => b.id === bid)?.runs);
await evalJs(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent === 'B')?.click(); return true; })()`);
await sleep(1500);
const m1 = await getModel();
assert('粗体格式已应用（run 变化）', JSON.stringify(m1.blocks.find(b => b.id === bid)?.runs) !== runsBefore);
const h1 = await (await fetch(`http://127.0.0.1:4173/api/docs/${DOC}/history`)).json();
assert('产生 format: 粗体 commit', h1.history[0].message.startsWith('format:'));

// --- 对齐：居中 ---
await evalJs(`(() => { const el = document.querySelector('.viewer-scroll p[data-block-id]'); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
await sleep(300);
await evalJs(`(() => { const btns = [...document.querySelectorAll('button[role="img"], button')]; document.querySelector('.anticon-align-center')?.closest('button')?.click(); return true; })()`);
await sleep(1500);
const m2 = await getModel();
assert('居中写回模型', m2.blocks.find(b => b.id === bid)?.alignment === 'center');

// --- 编辑模式 ---
await evalJs(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent === '编辑')?.click(); return true; })()`);
await sleep(400);
const editBid = await evalJs(`(() => {
  const el = document.querySelector('.viewer-scroll p[data-block-id]');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return document.querySelector('.editing')?.dataset.blockId || null; })()`);
assert('进入就地编辑', !!editBid);
const uniq = Date.now().toString(36);
await evalJs(`(() => { const el = document.querySelector('.editing'); el.innerText = 'React 编辑测试 ${uniq}'; el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
await sleep(1800);
const m3 = await getModel();
assert('编辑内容写回', (m3.blocks.find(b => b.id === editBid)?.runs || []).map(r => r.text).join('').includes('React 编辑测试'));
const h2 = await (await fetch(`http://127.0.0.1:4173/api/docs/${DOC}/history`)).json();
assert('产生 manual: commit', h2.history[0].message.startsWith('manual:'));
// 退出编辑模式
await evalJs(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent === '完成编辑')?.click(); return true; })()`);

// --- 历史面板 ---
await evalJs(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent === '历史')?.click(); return true; })()`);
await sleep(800);
const histItems = await evalJs(`document.querySelectorAll('.ant-drawer .ant-timeline-item').length`);
assert('历史 Drawer 打开且有提交', histItems >= 2);
await evalJs(`(() => { document.querySelector('.ant-drawer .ant-drawer-close')?.click(); return true; })()`);

// --- 文件面板 ---
await evalJs(`(() => { [...document.querySelectorAll('.ant-tabs-tab')].find(t => t.textContent === '文件')?.click(); return true; })()`);
await sleep(800);
const fileKinds = await evalJs(`JSON.stringify([...document.querySelectorAll('.ant-list-item .ant-tag')].map(t => t.textContent))`);
assert('文件面板列出主文档/引用/导出', fileKinds.includes('主文档') && fileKinds.includes('引用') && fileKinds.includes('导出'));

// --- 页面设置弹窗 ---
await evalJs(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent === '页面设置')?.click(); return true; })()`);
await sleep(600);
assert('页面设置弹窗打开', await evalJs(`!!document.querySelector('.ant-modal') && document.querySelector('.ant-modal')?.textContent.includes('页码')`));
await evalJs(`(() => { [...document.querySelectorAll('.ant-modal button')].find(b => b.textContent === '取 消' || b.textContent === '取消')?.click(); return true; })()`);

console.log(`\nRESULT pass=${pass} fail=${fail}`);
ws.close();
chrome.kill();
process.exit(fail ? 1 : 0);
