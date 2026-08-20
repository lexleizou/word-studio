// 截图工具：node dev-shot.mjs <url> <输出png> [额外等待ms]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9223;
const url = process.argv[2];
const out = process.argv[3] || '/tmp/ws-shot.png';
const extraWait = Number(process.argv[4] || 3000);

const chrome = spawn(CHROME, [
  '--headless', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--window-size=1500,1000', '--user-data-dir=/tmp/ws-cdp-shot', 'about:blank',
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
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg.result);
      pending.delete(msg.id);
    }
  };
  await send(ws, 'Page.enable');
  await send(ws, 'Page.navigate', { url });
  // 等分页渲染完成
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const r = await send(ws, 'Runtime.evaluate', {
      expression: `document.querySelectorAll('.pagedjs_page').length`,
      returnByValue: true,
    });
    if ((r?.result?.value || 0) > 0) break;
  }
  await sleep(extraWait);
  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out);
  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch(e => { console.error(e.message); chrome.kill(); process.exit(1); });
