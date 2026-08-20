// 无依赖 CDP 驱动器：真实时间跑浏览器集成测试
// 用法: node dev-cdp.mjs <url> <等待标题或超时秒>
import { spawn } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9222;
const url = process.argv[2];
const timeoutSec = Number(process.argv[3] || 30);

const chrome = spawn(CHROME, [
  '--headless', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--window-size=1400,900', '--user-data-dir=/tmp/ws-cdp-profile', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    for (const host of ['[::1]', '127.0.0.1']) {
      try {
        const list = await (await fetch(`http://${host}:${PORT}/json/list`)).json();
        const page = list.find(t => t.type === 'page');
        if (page) return page.webSocketDebuggerUrl;
      } catch { /* chrome 还没起 */ }
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

  // 等待测试跑完：标题变为 ALL_PASS / HAS_FAIL / ERROR，或超时
  const t0 = Date.now();
  let title = '';
  while (Date.now() - t0 < timeoutSec * 1000) {
    await sleep(500);
    const r = await send(ws, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    title = r?.result?.value || '';
    if (['ALL_PASS', 'HAS_FAIL', 'ERROR'].includes(title)) break;
  }
  const r = await send(ws, 'Runtime.evaluate', {
    expression: `document.getElementById('log') ? document.getElementById('log').textContent : '(no log element)'`,
    returnByValue: true,
  });
  console.log(r?.result?.value || '(无输出)');
  ws.close();
  chrome.kill();
  process.exit(title === 'ALL_PASS' ? 0 : 1);
}

main().catch(e => { console.error(e.message); chrome.kill(); process.exit(1); });
