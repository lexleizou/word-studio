// API 层：/api 调用的唯一出口 + 对话 SSE
export async function health() {
  return (await fetch('/api/health')).json();
}

export async function listDocs() {
  return (await fetch('/api/docs')).json();
}

export async function importDoc(file) {
  const form = new FormData();
  form.append('file', file);
  return (await fetch('/api/docs/import', { method: 'POST', body: form })).json();
}

export async function getModel(docId) {
  return (await fetch(`/api/docs/${docId}/model`)).json();
}

export async function saveModel(docId, modelData, message) {
  return (await fetch(`/api/docs/${docId}/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelData, message }),
  })).json();
}

export async function getHistory(docId) {
  return (await fetch(`/api/docs/${docId}/history`)).json();
}

export async function checkoutDoc(docId, hash) {
  return (await fetch(`/api/docs/${docId}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
  })).json();
}

export async function getProviders() {
  return (await fetch('/api/config/providers')).json();
}

export async function saveProviders(providers, activeProviderId) {
  return (await fetch('/api/config/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providers, activeProviderId }),
  })).json();
}

export async function getModels(providerId) {
  return (await fetch(`/api/config/models?providerId=${encodeURIComponent(providerId)}`)).json();
}

export async function getSkills() {
  return (await fetch('/api/skills')).json();
}

export async function toggleSkill(name, enabled) {
  return (await fetch('/api/skills/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, enabled }),
  })).json();
}

export async function importSkill(fileName, content) {
  return (await fetch('/api/skills/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName, content }),
  })).json();
}

export async function getMcp() {
  return (await fetch('/api/mcp')).json();
}

export async function saveMcp(config) {
  return (await fetch('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  })).json();
}

export async function copilotStatus() {
  return (await fetch('/api/copilot/status')).json();
}

export async function copilotStart() {
  return (await fetch('/api/copilot/login/start', { method: 'POST' })).json();
}

export async function copilotPoll() {
  return (await fetch('/api/copilot/login/poll', { method: 'POST' })).json();
}

export async function copilotLogout() {
  return (await fetch('/api/copilot/logout', { method: 'POST' })).json();
}

export async function listRefs(docId) {
  return (await fetch(`/api/docs/${docId}/refs`)).json();
}

export async function uploadRef(docId, file) {
  const form = new FormData();
  form.append('file', file);
  return (await fetch(`/api/docs/${docId}/refs`, { method: 'POST', body: form })).json();
}

export async function confirmProposal(proposalId, accept) {
  return (await fetch('/api/chat/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposalId, accept }),
  })).json();
}

// 对话 SSE：onEvent(event, data)
export async function chatStream(docId, { message, selection, refIds }, onEvent) {
  const res = await fetch(`/api/docs/${docId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, selection, refIds }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const event = /event: (.+)/.exec(part)?.[1];
      const data = /data: ([\s\S]+)/.exec(part)?.[1];
      if (event && data) {
        try { onEvent(event, JSON.parse(data)); } catch { /* 忽略坏包 */ }
      }
    }
  }
}
