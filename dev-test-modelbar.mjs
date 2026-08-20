// 验证模型栏：provider 切换 + 模型下拉填充
import { spawn } from 'node:child_process';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9555;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };

const chrome = spawn(CHROME, ['--headless', '--disable-gpu', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/ws-mb-profile', 'about:blank'], { stdio: 'ignore' });
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
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;

await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:4173/#doc=dmt1bpm0p283231' });
await sleep(4000);

const r1 = await evalJs(`JSON.stringify({
  providers: [...document.querySelectorAll('#provider-select option')].map(o => o.value),
  models: [...document.querySelectorAll('#model-select option')].map(o => o.value),
  sel: document.getElementById('model-select').value,
})`);
const d1 = JSON.parse(r1 || '{}');
console.log('初始:', r1);
assert('provider 下拉有 mock 和 copilot', d1.providers?.includes('mock') && d1.providers?.includes('copilot'));
assert('模型下拉填充候选', d1.models?.includes('mock-model') && d1.models?.includes('mock-model-pro'));
assert('包含自定义入口', d1.models?.includes('__custom__'));

// 切到 copilot（其 /models 指向同一 mock，也应有候选）
await evalJs(`(async()=>{const s=document.getElementById('provider-select');s.value='copilot';s.dispatchEvent(new Event('change'));return true})()`);
await sleep(1500);
const r2 = await evalJs(`JSON.stringify({
  models: [...document.querySelectorAll('#model-select option')].map(o => o.value),
  sel: document.getElementById('model-select').value,
})`);
console.log('切 copilot 后:', r2);
const d2 = JSON.parse(r2 || '{}');
assert('copilot 模型下拉有候选', d2.models?.length >= 2);
assert('copilot 默认模型 gpt-4o 在列表', d2.models?.includes('gpt-4o'));

// 选另一个模型，确认写回配置
await evalJs(`(async()=>{const s=document.getElementById('model-select');s.value='mock-model-pro';s.dispatchEvent(new Event('change'));return true})()`);
await sleep(1000);
const conf = await (await fetch('http://127.0.0.1:4173/api/config/providers')).json();
const cop = conf.providers.find(p => p.id === 'copilot');
assert('模型切换写回 provider 配置', cop?.model === 'mock-model-pro');

console.log(`\nRESULT pass=${pass} fail=${fail}`);
ws.close();
chrome.kill();
process.exit(fail ? 1 : 0);
