// 阶段 8 服务端链路测试：mock LLM + 对话 SSE + 提案确认
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const assert = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name); };

const mock = spawn('node', ['dev-mock-llm.mjs'], { stdio: 'ignore' });
await sleep(600);

// 0. 保存用户真实 provider 配置，测试结束后恢复（测试要用 mock endpoint，不能污染用户配置）
const savedConf = await (await fetch('http://127.0.0.1:4173/api/config/providers')).json();
const restoreConf = async () => {
  // apiKey 不回传明文：mock 条目不涉及真 key，直接回写；activeProviderId 一并恢复
  await fetch('http://127.0.0.1:4173/api/config/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providers: savedConf.providers || [], activeProviderId: savedConf.activeProviderId }),
  });
};

// 1. 配置 provider 指向 mock
let r = await fetch('http://127.0.0.1:4173/api/config/providers', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    providers: [{ id: 'mock', name: 'mock', type: 'openai-compat', baseUrl: 'http://127.0.0.1:4100', apiKey: 'x', model: 'mock-model' }],
    activeProviderId: 'mock',
  }),
});
assert('provider 配置保存', (await r.json()).ok);

// 2. 发对话，读 SSE
const docId = 'dmt1bpm0p283231';
const chatRes = await fetch(`http://127.0.0.1:4173/api/docs/${docId}/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: '把 b4 改一下' }),
});
assert('chat SSE 建立', chatRes.ok && chatRes.headers.get('content-type').includes('event-stream'));

const reader = chatRes.body.getReader();
const decoder = new TextDecoder();
let buf = '', proposalId = null, gotDelta = false, gotApplied = false, gotDone = false, doneData = null;
const t0 = Date.now();
while (Date.now() - t0 < 20000 && !gotDone) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const parts = buf.split('\n\n');
  buf = parts.pop();
  for (const part of parts) {
    const event = /event: (.+)/.exec(part)?.[1];
    const data = JSON.parse(/data: ([\s\S]+)/.exec(part)?.[1] || '{}');
    if (event === 'delta') gotDelta = true;
    if (event === 'proposal' && !proposalId) {
      proposalId = data.proposalId;
      assert('收到提案（含 diff）', Array.isArray(data.diff) && data.diff.length > 0 && data.diff[0].after.includes('AI 修订'));
      // 3. 确认提案
      const cr = await fetch('http://127.0.0.1:4173/api/chat/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId, accept: true }),
      });
      assert('提案确认响应', (await cr.json()).ok);
    }
    if (event === 'applied') gotApplied = true;
    if (event === 'done') { gotDone = true; doneData = data; }
  }
}
assert('流式文本 delta', gotDelta);
assert('改动已落盘 applied', gotApplied);
assert('对话收尾 done', gotDone);
// done 元信息：模型 / 累计 usage（两轮 908+1036）/ 工具统计（1 次 patch_blocks）
assert('done 带模型名', doneData?.model === 'mock-model');
assert('done 带累计 tokens', doneData?.usage?.total === 908 + 1036);
assert('done 带工具统计（次数+名称）', doneData?.tools?.count === 1 && doneData.tools.all?.[0] === 'patch_blocks');

// 4. 验证模型与 git
const m = await (await fetch(`http://127.0.0.1:4173/api/docs/${docId}/model`)).json();
const b4 = m.model.blocks.find(b => b.id === 'b4');
assert('模型已更新（AI 修订）', (b4.runs[0].text || '').includes('AI 修订'));
const h = await (await fetch(`http://127.0.0.1:4173/api/docs/${docId}/history`)).json();
assert('产生 ai: commit', h.history[0].message.startsWith('ai:'));

console.log(`\nRESULT pass=${pass} fail=${fail}`);
await restoreConf();
mock.kill();
process.exit(fail ? 1 : 0);
