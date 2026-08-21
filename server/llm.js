// LLM 抽象：OpenAI 兼容 endpoint（流式 chat completions + tool_calls）
// Copilot provider：Copilot token + VS Code 风格头（非公开 API，政策变动风险见设置面板标注）
// Codex provider：ChatGPT 账号 OAuth，走 Responses API（backend-api/codex/responses），事件形态不同，单独解析

// 回调：onDelta(text) / onToolCallDone(toolCall) / onDone(usage) / onError(err)
export async function chatCompletions({ provider, messages, tools, signal, onDelta, onToolCallDone, onDone }) {
  if (provider.type === 'codex') return codexResponses({ provider, messages, tools, signal, onDelta, onToolCallDone, onDone });

  let url, headers;
  if (provider.type === 'copilot') {
    // 多账号：token 按 provider 实例分槽
    const { getCopilotToken, COPILOT_API_BASE } = await import('./copilot-auth.js');
    const token = await getCopilotToken(provider.id);
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
    // 流式末包带 usage（prompt/completion tokens）；不支持的端点会忽略或不给，前端容错
    stream_options: { include_usage: true },
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
  let usage = null; // stream_options.include_usage 的末包（choices 为空、只带 usage）
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
      if (chunk.usage) usage = chunk.usage;
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
  onDone?.(usage);
}

// ---------- Codex Responses API 适配 ----------
// chat completions 形态 → responses 形态；SSE 事件 response.output_text.delta / output_item.done / completed
async function codexResponses({ provider, messages, signal, onDelta, onToolCallDone, onDone, tools }) {
  const { getCodexToken, CODEX_API_BASE } = await import('./codex-auth.js');
  const rec = await getCodexToken(provider.id);

  const instructions = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const input = [];
  for (const m of messages.filter(x => x.role !== 'system')) {
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: String(m.content) });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
      if (m.content) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      continue;
    }
    const text = typeof m.content === 'string' ? m.content
      : (m.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'); // 图片内容 v1 不下发 codex
    input.push({ type: 'message', role: m.role, content: [{ type: m.role === 'user' ? 'input_text' : 'output_text', text }] });
  }

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
      model: provider.model || 'gpt-5',
      instructions,
      input,
      ...(tools?.length ? {
        tools: tools.map(t => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters })),
        tool_choice: 'auto',
      } : {}),
      stream: true,
      store: false,
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Codex 请求失败 ${res.status}: ${text.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let usage = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') break;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === 'response.output_text.delta' && ev.delta) onDelta?.(ev.delta);
      else if (ev.type === 'response.output_item.done' && ev.item?.type === 'function_call') {
        await onToolCallDone?.({ id: ev.item.call_id, name: ev.item.name, arguments: ev.item.arguments || '{}' });
      } else if (ev.type === 'response.completed' && ev.response?.usage) {
        const u = ev.response.usage;
        usage = { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0) };
      } else if (ev.type === 'response.failed') {
        throw new Error('Codex 响应失败: ' + JSON.stringify(ev.response?.error || ev).slice(0, 200));
      }
    }
  }
  onDone?.(usage);
}
