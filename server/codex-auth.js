// Codex（ChatGPT 账号）OAuth：PKCE 授权码流程 + 本地 1455 回调 + token 刷新
// 复用 Codex CLI 公开 client_id；对话走 Responses API（chatgpt.com/backend-api/codex/responses）
// 与设备码不同：用户在浏览器完成登录，本地端口收回调
import http from 'node:http';
import crypto from 'node:crypto';
import { kvGet, kvSet } from './config-store.js';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'; // Codex CLI 当前 client_id（旧 id 尾号 hrgnz 已被轮换）
const ORIGINATOR = 'codex_cli_rs'; // authorize 必须带 originator，否则 invalid_client
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = (port) => `http://localhost:${port}/auth/callback`; // 1455/1457 均在 codex 白名单
const SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
export const CODEX_API_BASE = 'https://chatgpt.com/backend-api/codex';

const slotKey = (accountId) => `codex:${accountId || 'codex'}`;
const pendingLogins = new Map(); // accountId -> { verifier, state }

let callbackServer = null;
let callbackPort = 0;
const callbackWaiters = new Map(); // state -> resolve(code)

function ensureCallbackServer() {
  if (callbackServer) return callbackPort;
  callbackServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname !== '/auth/callback') { res.writeHead(404); res.end(); return; }
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body style="font-family:sans-serif;padding:40px"><h2>登录成功</h2><p>可以关闭这个页面，回到 Word Studio。</p></body></html>');
    const waiter = state && callbackWaiters.get(state);
    if (waiter) { callbackWaiters.delete(state); waiter(code); }
  });
  // codex 的 redirect_uri 白名单允许 1455 / 1457 两个端口，被占就换
  callbackServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && callbackPort === 1455) {
      callbackPort = 1457;
      callbackServer.listen(1457, '127.0.0.1');
    }
  });
  callbackPort = 1455;
  callbackServer.listen(1455, '127.0.0.1');
  return callbackPort;
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

// 第一步：生成授权 URL（前端用浏览器打开）；本地回调监听就绪
export async function startCodexLogin(accountId = 'codex') {
  const port = ensureCallbackServer();
  const redirectUri = REDIRECT_URI(port);
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const record = { verifier, state, redirectUri, error: null, createdAt: Date.now() };
  pendingLogins.set(accountId, record);
  // 关键：回调 waiter 在发起时就注册（不是首次 poll 时）——登录快的时候回调可能先于 poll 到达
  callbackWaiters.set(state, async (code) => {
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: CLIENT_ID,
          code, code_verifier: verifier, redirect_uri: redirectUri,
        }),
      });
      const data = await res.json();
      if (!data.access_token) throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
      // id_token 里拿账号信息（邮箱 + chatgpt_account_id）
      const claims = decodeJwt(data.id_token || '');
      await kvSet(slotKey(accountId), {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || '',
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
        account: claims.email || '',
        chatgptAccountId: claims.chatgpt_account_id
          || claims['https://api.openai.com/auth']?.organizations?.[0]?.id || '',
      });
    } catch (err) {
      record.error = 'token 交换失败: ' + err.message; // 让 poll 把真实错误带回 UI
      console.error('[codex] token 交换失败:', err.message);
    }
  });
  const url = `${AUTHORIZE_URL}?response_type=code&client_id=${CLIENT_ID}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPE)}`
    + `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`
    + '&id_token_add_organizations=true&codex_cli_simplified_flow=true'
    + `&originator=${ORIGINATOR}`;
  return { verificationUrl: url };
}

// 第二步：轮询登录结果（回调到达即已交换完 token）
export async function pollCodexLogin(accountId = 'codex') {
  const p = pendingLogins.get(accountId);
  if (!p) {
    const c = await kvGet(slotKey(accountId), null);
    if (c?.accessToken) return { status: 'ok', account: c.account || '' };
    return { status: 'error', message: '没有进行中的登录' };
  }
  if (p.error) { pendingLogins.delete(accountId); return { status: 'error', message: p.error }; }
  if (Date.now() - p.createdAt > 600000) { pendingLogins.delete(accountId); return { status: 'error', message: '登录超时' }; }
  const c = await kvGet(slotKey(accountId), null);
  if (c?.accessToken) { pendingLogins.delete(accountId); return { status: 'ok', account: c.account || '' }; }
  return { status: 'pending' };
}

export async function codexStatus(accountId = 'codex') {
  const c = await kvGet(slotKey(accountId), null);
  return { loggedIn: !!c?.accessToken, account: c?.account || '' };
}

export async function codexLogout(accountId = 'codex') {
  await kvSet(slotKey(accountId), null);
}

// 取有效 access token（过期自动刷新）
export async function getCodexToken(accountId = 'codex') {
  const c = await kvGet(slotKey(accountId), null);
  if (!c?.accessToken) throw new Error('该账号未登录 Codex');
  if (c.expiresAt > Date.now() + 60000) return c;
  if (!c.refreshToken) throw new Error('Codex token 已过期且无 refresh token，请重新登录');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: c.refreshToken }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Codex token 刷新失败: ' + (data.error || res.status));
  const next = { ...c, accessToken: data.access_token, refreshToken: data.refresh_token || c.refreshToken, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  await kvSet(slotKey(accountId), next);
  return next;
}

// 拉取该账号可用的 Codex 模型：优先 backend /models；空目录时回落到 Codex CLI 随包目录
//（models-manager/models.json 的 vendored 副本 —— 部分账号远端目录为空但模型实际可用）
export async function listCodexModels(accountId = 'codex') {
  const rec = await getCodexToken(accountId);
  const res = await fetch(`${CODEX_API_BASE}/models?client_version=0.55.0`, {
    headers: {
      Authorization: `Bearer ${rec.accessToken}`,
      ...(rec.chatgptAccountId ? { 'chatgpt-account-id': rec.chatgptAccountId } : {}),
      originator: 'codex_cli_rs',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  let models = (data.models || []).filter(m => (m.visibility || 'list') === 'list');
  if (!models.length) {
    const { readFile } = await import('node:fs/promises');
    const bundled = JSON.parse(await readFile(new URL('./vendor/codex-models.json', import.meta.url), 'utf8'));
    models = (bundled.models || []).filter(m => m.visibility === 'list' && m.supported_in_api !== false);
  }
  return models
    .sort((a, b) => (a.priority || 99) - (b.priority || 99))
    .map(m => ({ id: m.slug, label: m.display_name || m.slug }));
}
