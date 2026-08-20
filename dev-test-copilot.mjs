// Copilot provider 链路测试：假 token + COPILOT_API_BASE 指向 mock
process.env.COPILOT_API_BASE = 'http://127.0.0.1:4100';
import { kvSet } from './server/config-store.js';
import { chatCompletions } from './server/llm.js';
import http from 'node:http';

let pass = 0, fail = 0;
const assert = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name); };

// mock 捕获请求头
let captured = null;
const mock = http.createServer(async (req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    captured = { auth: req.headers.authorization, editor: req.headers['editor-version'], ua: req.headers['user-agent'], body: JSON.parse(body) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"copilot ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    res.end();
  });
});
mock.listen(4100);
await new Promise(r => setTimeout(r, 300));

// 种一个未来过期的假 Copilot token
await kvSet('copilot', { oauthToken: 'fake-oauth', copilotToken: 'fake-copilot-token', expiresAt: Date.now() + 3600000 });

let got = '';
await chatCompletions({
  provider: { id: 'copilot', type: 'copilot', model: 'gpt-4o' },
  messages: [{ role: 'user', content: 'hi' }],
  onDelta: (t) => got += t,
});
assert('流式回复', got === 'copilot ok');
assert('Copilot token 头', captured.auth === 'Bearer fake-copilot-token');
assert('Editor-Version 头', !!captured.editor);
assert('UA 头', (captured.ua || '').includes('GitHubCopilotChat'));
assert('模型透传', captured.body.model === 'gpt-4o');

console.log(`\nRESULT pass=${pass} fail=${fail}`);
mock.close();
process.exit(fail ? 1 : 0);
