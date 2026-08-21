// 添加模型配置页截图：设置 → Provider → 添加模型
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9557;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless', '--disable-gpu', `--remote-debugging-port=${PORT}`, '--window-size=1400,950', '--user-data-dir=/tmp/ws-cdp-addp', 'about:blank'], { stdio: 'ignore' });
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
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const id = ++msgId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;

await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:4173/' });
await sleep(4000);
// 打开设置
await evalJs(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent.includes('设') || b.querySelector('.anticon-setting'))?.click(); return true; })()`);
await sleep(800);
// 点"添加模型"
await evalJs(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent.includes('添加模型'))?.click(); return true; })()`);
await sleep(800);
// 选供应商类型 = DeepSeek（演示预设地址固定）
await evalJs(`(() => { const s = document.querySelector('.ant-modal .ant-select'); if (s) { const r = s.getBoundingClientRect(); s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } return true; })()`);
await sleep(500);
await evalJs(`(() => { [...document.querySelectorAll('.ant-select-item-option')].find(o => o.textContent.includes('DeepSeek'))?.click(); return true; })()`);
await sleep(500);
let shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/ws-addmodel.png', Buffer.from(shot.data, 'base64'));
console.log('saved /tmp/ws-addmodel.png');
ws.close();
chrome.kill();
process.exit(0);
