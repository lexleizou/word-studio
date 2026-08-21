// 页面 DOM 测量：node dev-measure.mjs <url>
import { spawn } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9224;
const url = process.argv[2];

const chrome = spawn(CHROME, [
  '--headless', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--window-size=1500,1000', '--user-data-dir=/tmp/ws-cdp-measure', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    for (const host of ['[::1]', '127.0.0.1']) {
      try {
        const list = await (await fetch(`http://${host}:${PORT}/json/list`)).json();
        const page = list.find(t => t.type === 'page');
        if (page) return page.webSocketDebuggerUrl;
      } catch { /* retry */ }
    }
    await sleep(250);
  }
  throw new Error('CDP 连接失败');
}

let msgId = 0;
const pending = new Map();
function send(ws, method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  const ws = new WebSocket(await getWsUrl());
  await new Promise(r => ws.onopen = r);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }
  };
  await send(ws, 'Page.enable');
  await send(ws, 'Page.navigate', { url });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const r = await send(ws, 'Runtime.evaluate', { expression: `document.querySelectorAll('.pagedjs_page').length`, returnByValue: true });
    if ((r?.result?.value || 0) > 0) break;
  }
  await sleep(3500);
  const expr = `(() => {
    const MM = 25.4 / 96;
    const page1 = document.querySelector('.pagedjs_page');
    const area = page1.querySelector('.pagedjs_page_content');
    const areaR = area.getBoundingClientRect();
    const tbl = page1.querySelector('.doc-content table');
    const rows = [...tbl.querySelectorAll('tr')].slice(0, 4).map(tr => Math.round(tr.getBoundingClientRect().height * MM * 10) / 10);
    const firstTd = tbl.querySelector('td');
    const tdP = firstTd.querySelector('p');
    const cs = tdP ? getComputedStyle(tdP) : null;
    const marginBox = page1.querySelector('.pagedjs_margin-top-center');
    const hf = page1.querySelector('.doc-hf');
    return JSON.stringify({
      pageCount: document.querySelectorAll('.pagedjs_page').length,
      bodyAreaTopMm: Math.round((areaR.top - page1.getBoundingClientRect().top) * MM * 10) / 10,
      bodyAreaHeightMm: Math.round(areaR.height * MM * 10) / 10,
      marginBoxHeightMm: Math.round(marginBox.getBoundingClientRect().height * MM * 10) / 10,
      hfHeightMm: hf ? Math.round(hf.getBoundingClientRect().height * MM * 10) / 10 : null,
      hfTopMm: hf ? Math.round((hf.getBoundingClientRect().top - page1.getBoundingClientRect().top) * MM * 10) / 10 : null,
      approvalRowHeightsMm: rows,
      tdFontSize: cs?.fontSize, tdLineHeight: cs?.lineHeight, tdMargin: cs?.margin,
    });
  })()`;
  const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(r?.result?.value || '(无结果)');
  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch(e => { console.error(e.message); chrome.kill(); process.exit(1); });
