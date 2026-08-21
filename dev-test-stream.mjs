// 流式输出 UI 测试：mock LLM 单 chunk 突发长文本 → 打字机逐字输出 + 结束 footer（模型/tokens/工具）
// 前置：服务已启动。会临时把 provider 指到 mock，结束恢复。
import { spawn } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9556;
const DOC = 'dmt1bpm0p283231';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };

// 保存真实 provider 配置
const savedConf = await (await fetch('http://127.0.0.1:4173/api/config/providers')).json();

const mock = spawn('node', ['dev-mock-llm.mjs'], { stdio: 'ignore' });
await sleep(600);
await fetch('http://127.0.0.1:4173/api/config/providers', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ providers: [{ id: 'mock', name: 'mock', type: 'openai-compat', baseUrl: 'http://127.0.0.1:4100', apiKey: 'x', model: 'mock-model' }], activeProviderId: 'mock' }),
});

const chrome = spawn(CHROME, ['--headless', '--disable-gpu', `--remote-debugging-port=${PORT}`, '--window-size=1500,1000', '--user-data-dir=/tmp/ws-cdp-stream', 'about:blank'], { stdio: 'ignore' });
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
await send('Page.navigate', { url: `http://127.0.0.1:4173/#doc=${DOC}` });
await sleep(5000);

// 输入并发送（React 受控组件要用 native setter）
await evalJs(`(() => {
  const ta = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '把 b4 改一下');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(300);
await evalJs(`(() => { const btns = [...document.querySelectorAll('button')]; const b = btns.find(x => x.textContent.includes('发送')); b.click(); return true; })()`);

// 等提案卡出现并点确认（第二轮的长文本是打字机观察对象）
let midLen = 0;
for (let i = 0; i < 40; i++) {
  await sleep(400);
  const has = await evalJs(`!![...document.querySelectorAll('.ant-card')].find(c => c.textContent.includes('确认落盘'))`);
  if (has) break;
}
await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('确认落盘')); b && b.click(); return true; })()`);
// 第二轮开始流出后，抓中间态
await sleep(700);
midLen = await evalJs(`(() => { const ms = [...document.querySelectorAll('.chat-stream > div')]; const t = ms.map(x => x.textContent).join(''); const i = t.indexOf('已完成修改'); return i === -1 ? 0 : t.length - t.indexOf('已完成修改并落盘。'); })()`);
// 等 footer 出现
let footer = '';
for (let i = 0; i < 40; i++) {
  await sleep(500);
  footer = await evalJs(`(() => { const el = [...document.querySelectorAll('.chat-stream .mono')].pop(); return el ? el.textContent : ''; })()`);
  if (footer.includes('mock-model')) break;
}
const finalText = await evalJs(`document.querySelector('.chat-stream').textContent`);

console.log('中间态文本长度:', midLen, '| footer:', footer);
assert('打字机中间态（未一次到位）', midLen > 0 && midLen < 90);
assert('footer 含模型名', footer.includes('mock-model'));
assert('footer 含 tokens 用量', /1,944 tokens/.test(footer));
assert('footer 含工具次数与名称', footer.includes('工具 1 次') && footer.includes('patch_blocks'));
assert('最终文本完整', finalText.includes('请继续描述需求'));

console.log(`\nRESULT pass=${pass} fail=${fail}`);
await fetch('http://127.0.0.1:4173/api/config/providers', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ providers: savedConf.providers || [], activeProviderId: savedConf.activeProviderId }),
});
ws.close();
chrome.kill();
mock.kill();
process.exit(fail ? 1 : 0);
