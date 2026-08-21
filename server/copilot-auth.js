// GitHub Copilot OAuth：设备码登录 → OAuth token → Copilot token → api.githubcopilot.com
// 多账号：token 按 provider 实例分槽（kv: copilot:<accountId>），老单账号 kv 'copilot' 无缝迁移
// 注意：复用公开的 VS Code client_id 惯例，属 GitHub 非公开 API 方案，政策变动可能失效（UI 有标注）
import { kvGet, kvSet } from './config-store.js';

const VSCODE_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const GITHUB_DEVICE_CODE = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_USER = 'https://api.github.com/user';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
export const COPILOT_API_BASE = process.env.COPILOT_API_BASE || 'https://api.githubcopilot.com';

const pendingDevices = new Map(); // accountId -> { deviceCode, interval, expiresAt, lastPoll }

const slotKey = (accountId) => `copilot:${accountId || 'copilot'}`;

async function readSlot(accountId) {
  const id = accountId || 'copilot';
  let c = await kvGet(slotKey(id), null);
  if (!c && id === 'copilot') c = await kvGet('copilot', null); // 老单账号槽位兼容
  return c;
}
const writeSlot = (accountId, v) => kvSet(slotKey(accountId), v);

async function postForm(url, params, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
    body: new URLSearchParams(params),
  });
  return res.json();
}

// 第一步：取设备码
export async function startDeviceLogin(accountId = 'copilot') {
  const data = await postForm(GITHUB_DEVICE_CODE, { client_id: VSCODE_CLIENT_ID, scope: 'read:user' });
  if (!data.device_code) throw new Error('设备码申请失败: ' + JSON.stringify(data).slice(0, 200));
  pendingDevices.set(accountId, {
    deviceCode: data.device_code,
    interval: (data.interval || 5) * 1000,
    expiresAt: Date.now() + (data.expires_in || 900) * 1000,
    lastPoll: 0,
  });
  return { userCode: data.user_code, verificationUri: data.verification_uri, interval: data.interval || 5 };
}

// 第二步：轮询授权状态（返回 pending / ok / error）
export async function pollDeviceLogin(accountId = 'copilot') {
  const p = pendingDevices.get(accountId);
  if (!p) return { status: 'error', message: '没有进行中的登录' };
  if (Date.now() > p.expiresAt) { pendingDevices.delete(accountId); return { status: 'error', message: '设备码已过期，请重新发起' }; }
  if (Date.now() - p.lastPoll < p.interval) return { status: 'pending' };
  p.lastPoll = Date.now();
  const data = await postForm(GITHUB_ACCESS_TOKEN, {
    client_id: VSCODE_CLIENT_ID,
    device_code: p.deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (data.error === 'authorization_pending' || data.error === 'slow_down') return { status: 'pending' };
  if (data.error) { pendingDevices.delete(accountId); return { status: 'error', message: data.error_description || data.error }; }
  pendingDevices.delete(accountId);
  // 授权成功：拉 GitHub 用户名（多账号界面要显示是谁），存 OAuth token，并换一次 Copilot token 验证可用
  let account = '';
  try {
    const u = await fetch(GITHUB_USER, { headers: { Authorization: `token ${data.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'word-studio' } });
    if (u.ok) account = (await u.json()).login || '';
  } catch { /* 用户名拉不到不阻塞登录 */ }
  await writeSlot(accountId, { oauthToken: data.access_token, account });
  try {
    await getCopilotToken(accountId);
    return { status: 'ok', account };
  } catch (err) {
    return { status: 'error', message: 'Copilot token 交换失败（账号可能没有 Copilot 订阅）: ' + err.message };
  }
}

export async function copilotStatus(accountId = 'copilot') {
  const c = await readSlot(accountId);
  return { loggedIn: !!c?.oauthToken, account: c?.account || '' };
}

export async function copilotLogout(accountId = 'copilot') {
  await writeSlot(accountId, null);
  if ((accountId || 'copilot') === 'copilot') await kvSet('copilot', null); // 清掉老槽位
}

// 取有效 Copilot token（过期自动用 OAuth token 重换）
export async function getCopilotToken(accountId = 'copilot') {
  const c = await readSlot(accountId);
  if (!c?.oauthToken) throw new Error('该账号未登录 GitHub Copilot');
  if (c.copilotToken && c.expiresAt && c.expiresAt > Date.now() + 60000) return c.copilotToken;
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: { Authorization: `token ${c.oauthToken}`, Accept: 'application/json', 'User-Agent': 'GitHubCopilotChat/0.26.7' },
  });
  if (!res.ok) throw new Error(`Copilot token 交换失败 ${res.status}`);
  const data = await res.json();
  if (!data.token) throw new Error('Copilot token 响应为空');
  await writeSlot(accountId, { ...c, copilotToken: data.token, expiresAt: (data.expires_at || 0) * 1000 });
  return data.token;
}
