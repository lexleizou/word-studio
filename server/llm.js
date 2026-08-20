// LLM 抽象：OpenAI 兼容 endpoint（流式 chat completions + tool_calls）
// Copilot provider 在阶段 12 接入（同样输出这个统一事件形态）

// 回调：onDelta(text) / onToolCallDone(toolCall) / onDone() / onError(err)
export async function chatCompletions({ provider, messages, tools, signal, onDelta, onToolCallDone, onDone }) {
  let url, headers;
  if (provider.type === 'copilot') {
    // Copilot：用 Copilot token + VS Code 风格头（非公开 API，政策变动风险见设置面板标注）
    const { getCopilotToken, COPILOT_API_BASE } = await import('./copilot-auth.js');
    const token = await getCopilotToken();
    url = COPILOT_API_BASE + '/chat/completions';
    headers = {
      Authorization: `Bearer ${token}`,
      'Editor-Version': 'vscode/1.95.0',
      'Copilot-Chat-Version': '0.26.7',
      'User-Agent': 'GitHubCopilotChat/0.26.7',
    };
  } else {
    url = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    headers = provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {};
  }
  const body = {
    model: provider.model,
    messages,
    stream: true,
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM 请求失败 ${res.status}: ${text.slice(0, 200)}`);
  }

  // 解析 SSE 流
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const toolCalls = new Map(); // index -> { id, name, arguments }
  let finished = false;

  const flushToolCalls = () => {
    const done = [...toolCalls.values()].filter(tc => tc.id && tc.name);
    toolCalls.clear();
    return done;
  };

  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') { finished = true; break; }
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) onDelta?.(delta.content);
      for (const tc of delta.tool_calls || []) {
        const idx = tc.index ?? 0;
        const cur = toolCalls.get(idx) || { id: '', name: '', arguments: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        toolCalls.set(idx, cur);
      }
      if (chunk.choices?.[0]?.finish_reason === 'tool_calls') {
        for (const tc of flushToolCalls()) await onToolCallDone?.(tc);
      }
    }
  }
  for (const tc of flushToolCalls()) await onToolCallDone?.(tc); // finish_reason 缺失时兜底
  onDone?.();
}
