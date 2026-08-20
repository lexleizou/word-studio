// 配置存储：node:sqlite（provider 配置 / 会话 / skills 启用态）
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = fileURLToPath(new URL('../data', import.meta.url));
let db = null;

async function getDb() {
  if (db) return db;
  await mkdir(DATA_DIR, { recursive: true });
  db = new DatabaseSync(join(DATA_DIR, 'studio.db'));
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
  return db;
}

export async function kvGet(key, fallback = null) {
  const d = await getDb();
  const row = d.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export async function kvSet(key, value) {
  const d = await getDb();
  d.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// ---------- provider 配置 ----------
const DEFAULT_PROVIDERS = [{
  id: 'openai-compat',
  name: 'OpenAI 兼容端点',
  type: 'openai-compat',
  baseUrl: 'http://127.0.0.1:4000',
  apiKey: '',
  model: '',
}];

export async function getProviders() {
  const providers = await kvGet('providers', null);
  if (providers) return providers;
  await kvSet('providers', DEFAULT_PROVIDERS);
  return DEFAULT_PROVIDERS;
}

export async function saveProviders(providers) {
  await kvSet('providers', providers);
}

export async function getActiveProviderId() {
  return kvGet('activeProviderId', null);
}

export async function setActiveProviderId(id) {
  await kvSet('activeProviderId', id);
}

export async function getActiveProvider() {
  const id = await getActiveProviderId();
  const providers = await getProviders();
  return providers.find(p => p.id === id) || null;
}

// ---------- 会话（每个文档一份，保留最近 40 条） ----------
export async function getSession(docId) {
  return kvGet(`session:${docId}`, []);
}

export async function appendSession(docId, messages) {
  const session = await getSession(docId);
  session.push(...messages);
  await kvSet(`session:${docId}`, session.slice(-40));
}
