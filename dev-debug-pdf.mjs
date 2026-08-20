// 排查 PDF 打印：统计 pdf 模式下的页面数与文档高度
import { spawn } from 'node:child_process';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9444;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless', '--disable-gpu', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/ws-dbg-profile', 'about:blank'], { stdio: 'ignore' });
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
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const id = ++msgId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });

await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:4173/?pdf=1#doc=dmt1bpm0p283231' });
const t0 = Date.now();
for (;;) {
  await sleep(500);
  const r = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  if (r?.result?.value === 'PDF_READY' || Date.now() - t0 > 20000) break;
}
const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    pages: document.querySelectorAll('.pagedjs_page').length,
    bodyScrollH: document.body.scrollHeight,
    viewerH: document.getElementById('viewer')?.scrollHeight,
    pageHeights: [...document.querySelectorAll('.pagedjs_page')].map(p => p.offsetHeight),
    layoutDisplay: getComputedStyle(document.getElementById('layout')).display,
    viewerOverflow: getComputedStyle(document.getElementById('viewer')).overflow,
  })`,
  returnByValue: true,
});
console.log(r?.result?.value);
ws.close();
chrome.kill();
process.exit(0);
