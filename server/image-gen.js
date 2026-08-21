// 图片生成：走 Codex（ChatGPT 账号）Responses API 的 image_generation 内置工具
// 返回 PNG Buffer；无可用 Codex provider 时返回 null
import { getProviders } from './config-store.js';

export async function generateImage(prompt) {
  const providers = await getProviders();
  const codex = providers.find(p => p.type === 'codex' && p.enabled !== false);
  if (!codex) return null;
  const { getCodexToken, CODEX_API_BASE } = await import('./codex-auth.js');
  const rec = await getCodexToken(codex.id);

  const res = await fetch(CODEX_API_BASE + '/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${rec.accessToken}`,
      ...(rec.chatgptAccountId ? { 'chatgpt-account-id': rec.chatgptAccountId } : {}),
      'OpenAI-Beta': 'responses=experimental',
      originator: 'codex_cli_rs',
    },
    body: JSON.stringify({
      model: codex.model || 'gpt-5.6-luna',
      instructions: '你是文档插图绘制助手。用户要图片时直接调用 image_generation 工具绘制，不要输出文字解释。',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `请绘制：${prompt}` }] }],
      tools: [{ type: 'image_generation' }],
      tool_choice: 'auto',
      stream: true,
      store: false,
    }),
    signal: AbortSignal.timeout(180000), // 生图较慢
  });
  if (!res.ok) throw new Error(`生图请求失败 ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let b64 = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const d = t.slice(5).trim();
      if (d === '[DONE]') break;
      let ev;
      try { ev = JSON.parse(d); } catch { continue; }
      // 成品在 output_item.done 的 image_generation_call.result（base64 PNG）
      if (ev.type === 'response.output_item.done' && ev.item?.type === 'image_generation_call' && ev.item.result) {
        b64 = ev.item.result;
      }
    }
  }
  return b64 ? Buffer.from(b64, 'base64') : null;
}
