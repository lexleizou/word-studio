// 网络层：/api 调用的唯一出口
export async function health() {
  const res = await fetch('/api/health');
  return res.json();
}

export async function listDocs() {
  const res = await fetch('/api/docs');
  return res.json();
}

export async function importDoc(file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/docs/import', { method: 'POST', body: form });
  return res.json();
}

export async function getModel(docId) {
  const res = await fetch(`/api/docs/${docId}/model`);
  return res.json();
}

export async function saveModel(docId, modelData, message) {
  const res = await fetch(`/api/docs/${docId}/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelData, message }),
  });
  return res.json();
}

export async function getHistory(docId) {
  const res = await fetch(`/api/docs/${docId}/history`);
  return res.json();
}

export async function checkoutDoc(docId, hash) {
  const res = await fetch(`/api/docs/${docId}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
  });
  return res.json();
}
