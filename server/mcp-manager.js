// MCP Client：stdio（子进程，换行 JSON-RPC）+ streamable-http 两种通道
// 配置存 data/mcp.json；外部工具以 mcp__<服务>__<工具> 命名空间并入 AI 工具表
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = fileURLToPath(new URL('../data', import.meta.url));
const MCP_CONFIG = join(DATA_DIR, 'mcp.json');
const PROTOCOL_VERSION = '2025-03-26';
const CLIENT_INFO = { name: 'word-studio', version: '0.1.0' };

// ---------- stdio 通道 ----------
class StdioChannel {
  constructor(command, args) {
    this.pending = new Map();
    this.seq = 0;
    this.buf = '';
    this.proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk.toString();
      const lines = this.buf.split('\n');
      this.buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(msg.error.message || 'MCP error')) : resolve(msg.result);
        }
      }
    });
    this.proc.on('error', (err) => this.failAll(err));
    this.proc.on('exit', (code) => this.failAll(new Error(`进程退出 code=${code}`)));
  }
  failAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
  request(method, params, timeoutMs = 30000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('MCP 请求超时'));
      }, timeoutMs);
    });
  }
  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  close() { try { this.proc.kill(); } catch { /* 忽略 */ } }
}

// ---------- streamable-http 通道 ----------
class HttpChannel {
  constructor(url) {
    this.url = url;
    this.seq = 0;
    this.sessionId = null;
  }
  async request(method, params) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.seq, method, params }),
    });
    if (res.headers.get('mcp-session-id')) this.sessionId = res.headers.get('mcp-session-id');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      // 取 SSE 流里第一个 JSON-RPC 响应
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const msg = JSON.parse(line.slice(5).trim());
          if (msg.id != null) {
            if (msg.error) throw new Error(msg.error.message || 'MCP error');
            return msg.result;
          }
        } catch (e) { if (e.message !== 'MCP error') continue; throw e; }
      }
      throw new Error('SSE 流中没有响应');
    }
    const msg = await res.json();
    if (msg.error) throw new Error(msg.error.message || 'MCP error');
    return msg.result;
  }
  notify() { /* streamable-http 通知可省 */ }
  close() { /* 无长连接 */ }
}

// ---------- 管理器 ----------
let clients = new Map(); // serverName -> { channel, tools: [{name, description, inputSchema}] }
let status = new Map();  // serverName -> { ok, error?, toolCount }

export async function loadConfig() {
  try { return JSON.parse(await readFile(MCP_CONFIG, 'utf8')); } catch { return { servers: {} }; }
}

export async function saveConfig(cfg) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(MCP_CONFIG, JSON.stringify(cfg, null, 2));
}

export function getStatus() {
  return Object.fromEntries(status);
}

async function connectOne(name, cfg) {
  const channel = cfg.type === 'http' ? new HttpChannel(cfg.url) : new StdioChannel(cfg.command, cfg.args || []);
  await channel.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });
  channel.notify('notifications/initialized', {});
  const { tools } = await channel.request('tools/list', {});
  return { channel, tools: tools || [] };
}

// 连接全部启用的 server（配置变更后调用）
export async function reloadMcp() {
  for (const { channel } of clients.values()) channel.close();
  clients = new Map();
  status = new Map();
  const cfg = await loadConfig();
  for (const [name, server] of Object.entries(cfg.servers || {})) {
    if (server.enabled === false) { status.set(name, { ok: false, disabled: true }); continue; }
    try {
      const { channel, tools } = await connectOne(name, server);
      clients.set(name, { channel, tools });
      status.set(name, { ok: true, toolCount: tools.length });
    } catch (err) {
      status.set(name, { ok: false, error: err.message });
      console.error(`[mcp] ${name} 连接失败:`, err.message);
    }
  }
}

// 并入 AI 工具表的外部工具 schema
export function mcpToolSchemas() {
  const out = [];
  for (const [serverName, { tools }] of clients) {
    for (const t of tools) {
      out.push({
        type: 'function',
        function: {
          name: `mcp__${serverName}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
          description: `[MCP:${serverName}] ${t.description || t.name}`,
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      });
    }
  }
  return out;
}

export function isMcpTool(name) {
  return name.startsWith('mcp__');
}

export async function callMcpTool(prefixedName, args) {
  for (const [serverName, { channel, tools }] of clients) {
    const prefix = `mcp__${serverName}__`;
    if (!prefixedName.startsWith(prefix)) continue;
    const toolName = prefixedName.slice(prefix.length);
    if (!tools.some(t => t.name.replace(/[^a-zA-Z0-9_-]/g, '_') === toolName || `mcp__${serverName}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) === prefixedName)) {
      return `工具 ${prefixedName} 不存在`;
    }
    const result = await channel.request('tools/call', { name: toolName, arguments: args || {} });
    // MCP 返回 content 数组，拼成文本
    return (result?.content || []).map(c => c.text ?? JSON.stringify(c)).join('\n') || '（无输出）';
  }
  return `MCP 服务未连接: ${prefixedName}`;
}
