// 设置面板：Provider（列表 → 详情/添加）/ Skills / MCP + 密度开关
import { useState, useEffect, useRef } from 'react';
import { Modal, Tabs, Input, Radio, Button, Checkbox, Select, Tag, Segmented, Switch, message } from 'antd';
import { PlusOutlined, DeleteOutlined, ImportOutlined, CheckCircleOutlined, ArrowLeftOutlined, ThunderboltOutlined, DownloadOutlined, RightOutlined } from '@ant-design/icons';
import { store, useStore } from '../store.js';
import * as api from '../api.js';

// 供应商类型预设（OpenAI 兼容 + OAuth 账号型：GitHub Copilot / Codex）
const PRESETS = [
  { key: 'custom', name: 'OpenAI 兼容端点（自定义）', baseUrl: '' },
  { key: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { key: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  { key: 'moonshot', name: 'Moonshot（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1' },
  { key: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { key: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { key: 'copilot', name: 'GitHub Copilot', baseUrl: '(api.githubcopilot.com)', oauth: 'copilot' },
  { key: 'codex', name: 'Codex（ChatGPT 账号）', baseUrl: '(chatgpt.com codex)', oauth: 'codex' },
];
const presetOfProvider = (p) => {
  if (p.type === 'copilot') return 'copilot';
  if (p.type === 'codex') return 'codex';
  return PRESETS.find(x => x.baseUrl && x.baseUrl === p.baseUrl)?.key || 'custom';
};

// ---------- GitHub Copilot OAuth（设备码，按 accountId 多账号） ----------
function CopilotAuth({ accountId }) {
  const [loggedIn, setLoggedIn] = useState(false);
  const [account, setAccount] = useState('');
  const [device, setDevice] = useState(null);
  const [pollState, setPollState] = useState('');
  useEffect(() => { api.copilotStatus(accountId).then(d => { if (d.ok) { setLoggedIn(d.loggedIn); setAccount(d.account || ''); } }); }, [accountId]);
  const login = async () => {
    const r = await api.copilotStart(accountId);
    if (!r.ok) { setPollState('发起失败: ' + (r.message || r.error)); return; }
    setDevice(r);
    setPollState('等待授权…');
    const timer = setInterval(async () => {
      const p = await api.copilotPoll(accountId);
      if (p.status === 'ok') {
        clearInterval(timer);
        setDevice(null);
        setLoggedIn(true);
        setAccount(p.account || '');
        setPollState('');
        message.success(`Copilot 登录成功${p.account ? `：@${p.account}` : ''}`);
        window.dispatchEvent(new CustomEvent('providers-changed'));
      } else if (p.status === 'error') {
        clearInterval(timer);
        setPollState('登录失败: ' + p.message);
      }
    }, 5500);
  };
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {loggedIn
          ? <Tag color="success" icon={<CheckCircleOutlined />}>已登录{account ? ` @${account}` : ''}</Tag>
          : <Tag>未登录</Tag>}
        <Button size="small" disabled={loggedIn} onClick={login}>设备码登录</Button>
        <Button size="small" disabled={!loggedIn} onClick={async () => {
          await api.copilotLogout(accountId);
          setLoggedIn(false);
          setAccount('');
          window.dispatchEvent(new CustomEvent('providers-changed'));
        }}>登出</Button>
      </div>
      {device && (
        <p style={{ marginTop: 8, fontSize: 12 }}>
          请打开 <a href={device.verificationUri} target="_blank" rel="noreferrer">{device.verificationUri}</a> 并输入验证码：
          <b style={{ fontSize: 15 }}>{device.userCode}</b>
        </p>
      )}
      {pollState && <p style={{ color: '#b91c1c', fontSize: 12, marginTop: 4 }}>{pollState}</p>}
      <p style={{ color: '#a1a1aa', fontSize: 12, marginTop: 6 }}>使用 GitHub 非公开 API 方案，政策变动可能导致失效。</p>
    </div>
  );
}

// ---------- Codex OAuth（PKCE 浏览器登录 + 本地 1455 回调） ----------
function CodexAuth({ accountId }) {
  const [loggedIn, setLoggedIn] = useState(false);
  const [account, setAccount] = useState('');
  const [pollState, setPollState] = useState('');
  useEffect(() => { api.codexStatus(accountId).then(d => { if (d.ok) { setLoggedIn(d.loggedIn); setAccount(d.account || ''); } }); }, [accountId]);
  const login = async () => {
    const r = await api.codexStart(accountId);
    if (!r.ok) { setPollState('发起失败: ' + (r.message || r.error)); return; }
    window.open(r.verificationUrl, '_blank'); // 浏览器完成 ChatGPT 登录，本地 1455 收回调
    setPollState('等待浏览器完成登录…');
    const t0 = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - t0 > 180000) { clearInterval(timer); setPollState('登录超时，请重试'); return; }
      const p = await api.codexPoll(accountId);
      if (p.status === 'ok') {
        clearInterval(timer);
        setLoggedIn(true);
        setAccount(p.account || '');
        setPollState('');
        message.success(`Codex 登录成功${p.account ? `：${p.account}` : ''}`);
        window.dispatchEvent(new CustomEvent('providers-changed'));
      } else if (p.status === 'error') {
        clearInterval(timer);
        setPollState('登录失败: ' + p.message);
      }
    }, 3000);
  };
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {loggedIn
          ? <Tag color="success" icon={<CheckCircleOutlined />}>已登录{account ? ` ${account}` : ''}</Tag>
          : <Tag>未登录</Tag>}
        <Button size="small" disabled={loggedIn} onClick={login}>浏览器登录</Button>
        <Button size="small" disabled={!loggedIn} onClick={async () => {
          await api.codexLogout(accountId);
          setLoggedIn(false);
          setAccount('');
          window.dispatchEvent(new CustomEvent('providers-changed'));
        }}>登出</Button>
      </div>
      {pollState && <p style={{ color: '#71717a', fontSize: 12, marginTop: 4 }}>{pollState}</p>}
      <p style={{ color: '#a1a1aa', fontSize: 12, marginTop: 6 }}>ChatGPT 账号 OAuth（PKCE），对话走 Codex Responses API。</p>
    </div>
  );
}

// ---------- Provider 表单（添加 / 编辑共用，复刻参考截图布局） ----------
function ProviderForm({ initial, onBack, onSave, onDelete }) {
  const isEdit = !!initial;
  const [formId] = useState(() => initial?.id || ('p' + Date.now().toString(36)));
  const [preset, setPreset] = useState(() => initial ? presetOfProvider(initial) : 'custom');
  const [name, setName] = useState(initial?.name || '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || '');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(initial?.enabled !== false);
  const [models, setModels] = useState(initial?.models || []);              // 已启用 [{id,label}]
  const [available, setAvailable] = useState(initial?.availableModels || []); // 已拉取 [{id,label}]
  const [newId, setNewId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [testing, setTesting] = useState(null);
  const [fetching, setFetching] = useState(false);

  const presetDef = PRESETS.find(p => p.key === preset);
  const oauthKind = presetDef.oauth; // 'copilot' | 'codex' | undefined
  const effectiveBaseUrl = preset === 'custom' ? baseUrl : presetDef.baseUrl;
  const probeArgs = { baseUrl: effectiveBaseUrl, apiKey, type: oauthKind, accountId: formId };

  const testConnection = async () => {
    setTesting('loading');
    const r = await api.probeProvider(probeArgs);
    setTesting(r.ok ? { ok: true, count: r.models.length, latencyMs: r.latencyMs } : { error: r.error });
  };

  const fetchModels = async () => {
    setFetching(true);
    const r = await api.probeProvider(probeArgs);
    setFetching(false);
    if (!r.ok) { message.error(r.error); return; }
    if (r.warning) message.warning(r.warning);
    if (!r.models.length) return;
    // 合并进可用列表（保留手工条目的显示名）；条目可能是字符串或 {id,label}
    setAvailable(prev => {
      const map = new Map(prev.map(m => [m.id, m]));
      for (const m of r.models) {
        const id = typeof m === 'string' ? m : m.id;
        const label = typeof m === 'string' ? '' : (m.label || '');
        if (!map.has(id)) map.set(id, { id, label });
        else if (label && !map.get(id).label) map.set(id, { id, label });
      }
      return [...map.values()];
    });
  };

  const setModelEnabled = (id, on) => {
    if (on) {
      const src = available.find(m => m.id === id);
      if (!models.some(m => m.id === id)) setModels([...models, { id, label: src?.label || '' }]);
    } else {
      setModels(models.filter(m => m.id !== id));
    }
  };

  const addManual = () => {
    const id = newId.trim();
    if (!id) return;
    const entry = { id, label: newLabel.trim() };
    if (!available.some(m => m.id === id)) setAvailable([...available, entry]);
    if (!models.some(m => m.id === id)) setModels([...models, entry]);
    setNewId(''); setNewLabel('');
  };

  const save = () => {
    const finalName = name.trim() || (oauthKind ? presetDef.name : '');
    if (!finalName) { message.warning('请填供应商名称'); return; }
    if (!effectiveBaseUrl) { message.warning('请填 API 地址'); return; }
    onSave({
      id: formId,
      name: finalName,
      type: oauthKind || 'openai-compat',
      baseUrl: effectiveBaseUrl,
      apiKey, // 留空 = 服务端沿用原值
      model: models[0]?.id || initial?.model || '',
      models,
      availableModels: available,
      enabled,
    });
  };

  const labelStyle = { fontSize: 13, fontWeight: 600, margin: '14px 0 6px' };
  const hintStyle = { fontSize: 12, color: '#a1a1aa', marginTop: 4 };
  // 可用列表 = 已拉取 ∪ 已启用（已启用但没在可用里的也要显示开关）
  const listRows = (() => {
    const map = new Map(available.map(m => [m.id, m]));
    for (const m of models) if (!map.has(m.id)) map.set(m.id, m);
    return [...map.values()];
  })();

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
        <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={onBack} />
        <b style={{ fontSize: 15 }}>{isEdit ? '编辑模型配置' : '添加模型配置'}</b>
        <div style={{ flex: 1 }} />
        {isEdit && <Button danger size="small" icon={<DeleteOutlined />} onClick={onDelete} style={{ marginRight: 8 }}>删除</Button>}
        <Button type="primary" onClick={save}>{isEdit ? '保存' : '创建'}</Button>
      </div>

      <div style={{ fontSize: 14, fontWeight: 600, margin: '12px 0 2px' }}>基本信息</div>
      <div style={labelStyle}>供应商类型</div>
      <Select
        style={{ width: '100%' }}
        value={preset}
        disabled={isEdit && !!oauthKind}
        options={PRESETS.map(p => ({ value: p.key, label: p.name }))}
        onChange={setPreset}
      />
      <div style={labelStyle}>供应商名称</div>
      <Input value={name} onChange={e => setName(e.target.value)} placeholder={oauthKind ? presetDef.name : '例如：我的 DeepSeek'} />
      {oauthKind === 'copilot' && (
        <>
          <div style={labelStyle}>OAuth 登录</div>
          <CopilotAuth accountId={formId} />
        </>
      )}
      {oauthKind === 'codex' && (
        <>
          <div style={labelStyle}>OAuth 登录</div>
          <CodexAuth accountId={formId} />
        </>
      )}
      {!oauthKind && (
        <>
          <div style={labelStyle}>官方 API 地址</div>
          {preset === 'custom' ? (
            <Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://…（OpenAI 兼容端点，不带 /chat/completions）" />
          ) : (
            <>
              <div className="mono" style={{ fontSize: 13 }}>{presetDef.baseUrl}</div>
              <div style={hintStyle}>该供应商类型使用官方地址，不可修改。</div>
            </>
          )}
          <div style={{ ...labelStyle, display: 'flex', alignItems: 'center' }}>
            API Key
            <div style={{ flex: 1 }} />
            <Button size="small" icon={<ThunderboltOutlined />} loading={testing === 'loading'} onClick={testConnection}>测试连接</Button>
          </div>
          <Input.Password value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={isEdit ? '已配置（留空不变）' : '输入 API Key'} />
          {testing && testing !== 'loading' && (
            <div style={{ fontSize: 12, marginTop: 4, color: testing.ok ? '#16a34a' : '#b91c1c' }}>
              {testing.ok ? `连接成功（${testing.latencyMs}ms，${testing.count} 个模型）` : testing.error}
            </div>
          )}
        </>
      )}
      <div style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 10 }}>
        启用此配置
        <Switch checked={enabled} onChange={setEnabled} />
      </div>
      <div style={hintStyle}>关闭后该配置的模型不会在选择列表中出现</div>

      <div style={{ fontSize: 14, fontWeight: 600, margin: '20px 0 6px', display: 'flex', alignItems: 'center' }}>
        模型
        <div style={{ flex: 1 }} />
        <Button size="small" icon={<DownloadOutlined />} loading={fetching} onClick={fetchModels}>从供应商获取</Button>
      </div>
      {listRows.length === 0 ? (
        <div style={{ color: '#a1a1aa', fontSize: 13, textAlign: 'center', padding: '14px 0' }}>还没有可用模型，点右上角"从供应商获取"，或手动添加</div>
      ) : (
        <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 6 }}>
          {listRows.map(m => {
            const on = models.some(x => x.id === m.id);
            return (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', fontSize: 13, borderBottom: '1px solid #fafafa' }}>
                <Switch size="small" checked={on} onChange={v => setModelEnabled(m.id, v)} />
                <span className="mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.label || m.id}</span>
                {m.label && <span className="mono" style={{ color: '#a1a1aa', fontSize: 11 }}>{m.id}</span>}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Input value={newId} onChange={e => setNewId(e.target.value)} placeholder="模型 ID（如 claude-opus-4-6）" style={{ flex: 1 }} />
        <Input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="显示名称（可选）" style={{ width: 170 }} />
        <Button icon={<PlusOutlined />} onClick={addManual} />
      </div>
    </div>
  );
}

// ---------- Provider 列表（一行一个，点行进详情） ----------
function ProviderTab() {
  const [providers, setProviders] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [view, setView] = useState(null); // null | { initial? }
  const [accounts, setAccounts] = useState({}); // oauth 账号名：providerId -> account

  const load = () => api.getProviders().then(async d => {
    if (!d.ok) return;
    setProviders(d.providers);
    setActiveId(prev => prev || d.activeProviderId || d.providers[0]?.id);
    // oauth 类 provider 拉账号名用于行内显示
    const acc = {};
    for (const p of d.providers) {
      if (p.type === 'copilot' || p.type === 'codex') {
        const st = await (p.type === 'copilot' ? api.copilotStatus(p.id) : api.codexStatus(p.id));
        if (st.loggedIn && st.account) acc[p.id] = st.account;
      }
    }
    setAccounts(acc);
  });
  useEffect(() => { load(); }, []);

  const persist = async (nextProviders, nextActive) => {
    const body = nextProviders.map(p => ({
      id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, model: p.model,
      apiKey: p.apiKey || '', models: p.models || [], availableModels: p.availableModels || [],
      enabled: p.enabled !== false,
    })).filter(p => p.baseUrl || p.type === 'copilot' || p.type === 'codex');
    await api.saveProviders(body, nextActive);
    window.dispatchEvent(new CustomEvent('providers-changed'));
  };

  if (view) {
    return (
      <ProviderForm
        initial={view.initial}
        onBack={() => setView(null)}
        onSave={async (np) => {
          const exists = providers.some(p => p.id === np.id);
          const next = exists ? providers.map(p => p.id === np.id ? { ...p, ...np } : p) : [...providers, np];
          setProviders(next);
          setView(null);
          await persist(next, activeId || np.id);
          message.success('已保存');
        }}
        onDelete={async () => {
          const next = providers.filter(p => p.id !== view.initial.id);
          setProviders(next);
          setView(null);
          await persist(next, activeId === view.initial.id ? next[0]?.id : activeId);
          message.success('已删除');
        }}
      />
    );
  }

  return (
    <div>
      {providers.map(p => (
        <div
          key={p.id}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid #e4e4e7', borderRadius: 8, marginBottom: 8, cursor: 'pointer' }}
          onClick={() => setView({ initial: p })}
        >
          <span onClick={e => e.stopPropagation()}>
            <Radio checked={p.id === activeId} onChange={async () => { setActiveId(p.id); await persist(providers, p.id); }} />
          </span>
          <b style={{ fontSize: 13 }}>{p.name}</b>
          {p.type === 'copilot' && <Tag color="blue" style={{ marginLeft: 2 }}>Copilot</Tag>}
          {p.type === 'codex' && <Tag color="purple" style={{ marginLeft: 2 }}>Codex</Tag>}
          {accounts[p.id] && <span style={{ fontSize: 12, color: '#71717a' }}>@{accounts[p.id]}</span>}
          {p.enabled === false && <Tag>已停用</Tag>}
          <div style={{ flex: 1 }} />
          {(p.models || []).length > 0 && <span style={{ fontSize: 12, color: '#71717a' }}>{p.models.length} 个模型</span>}
          <span onClick={e => e.stopPropagation()}>
            <Switch size="small" checked={p.enabled !== false} onChange={async (v) => {
              const next = providers.map(x => x.id === p.id ? { ...x, enabled: v } : x);
              setProviders(next);
              await persist(next, activeId);
            }} />
          </span>
          <RightOutlined style={{ fontSize: 11, color: '#a1a1aa' }} />
        </div>
      ))}
      <Button type="dashed" block icon={<PlusOutlined />} onClick={() => setView({})}>
        添加模型
      </Button>
    </div>
  );
}

function SkillsTab() {
  const [skills, setSkills] = useState([]);
  const fileRef = useRef(null);
  const load = () => api.getSkills().then(d => d.ok && setSkills(d.skills));
  useEffect(() => { load(); }, []);
  return (
    <div>
      {skills.length === 0 && <div style={{ color: '#a1a1aa', padding: 12 }}>暂无技能，导入 .md 文件即可添加</div>}
      {skills.map(s => (
        <div key={s.name} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '6px 0' }}>
          <Checkbox checked={s.enabled} onChange={e => { api.toggleSkill(s.name, e.target.checked); load(); }}>
            <b>{s.name}</b>
          </Checkbox>
          <span style={{ color: '#71717a', fontSize: 12 }}>{s.description}</span>
        </div>
      ))}
      <Button type="dashed" block icon={<ImportOutlined />} style={{ marginTop: 8 }} onClick={() => fileRef.current?.click()}>导入技能 .md</Button>
      <input ref={fileRef} type="file" accept=".md" hidden onChange={async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f) return;
        const res = await api.importSkill(f.name, await f.text());
        if (res.ok) { message.success(`已导入技能 ${res.name}`); load(); }
        else message.error('导入失败');
      }} />
    </div>
  );
}

function McpTab() {
  const [servers, setServers] = useState({});
  const [status, setStatus] = useState({});
  useEffect(() => {
    api.getMcp().then(d => {
      if (d.ok) { setServers(d.config.servers || {}); setStatus(d.status || {}); }
    });
  }, []);
  const setServer = (name, cfg) => setServers(prev => ({ ...prev, [name]: cfg }));
  return (
    <div>
      {Object.entries(servers).map(([name, s]) => {
        const st = status[name];
        return (
          <div key={name} style={{ border: '1px solid #e4e4e7', borderRadius: 8, padding: '12px 14px', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <b>{name}</b>
              {st?.ok && <Tag color="success" icon={<CheckCircleOutlined />}>{st.toolCount} 个工具</Tag>}
              {st?.error && <Tag color="error">{st.error}</Tag>}
              {st?.disabled && <Tag>已停用</Tag>}
              <div style={{ flex: 1 }} />
              <Checkbox checked={s.enabled !== false} onChange={e => setServer(name, { ...s, enabled: e.target.checked })}>启用</Checkbox>
              <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => {
                const next = { ...servers };
                delete next[name];
                setServers(next);
              }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 10 }}>
              <div>
                <div style={{ fontSize: 12, color: '#71717a', marginBottom: 4 }}>类型</div>
                <Select size="small" value={s.type || 'stdio'} style={{ width: '100%' }}
                  options={[{ value: 'stdio' }, { value: 'http' }]}
                  onChange={v => setServer(name, { ...s, type: v })} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: '#71717a', marginBottom: 4 }}>{s.type === 'http' ? 'URL' : '命令'}</div>
                {s.type === 'http'
                  ? <Input size="small" value={s.url || ''} onChange={e => setServer(name, { ...s, url: e.target.value })} />
                  : <Input size="small" value={[s.command || '', ...(s.args || [])].join(' ')}
                      onChange={e => {
                        const parts = e.target.value.trim().split(/\s+/).filter(Boolean);
                        setServer(name, { ...s, command: parts[0] || '', args: parts.slice(1) });
                      }} />}
              </div>
            </div>
          </div>
        );
      })}
      <Button type="dashed" block icon={<PlusOutlined />}
        onClick={() => setServer('server' + (Object.keys(servers).length + 1), { type: 'stdio', command: '', args: [], enabled: true })}>
        添加 MCP 服务
      </Button>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <Button type="primary" onClick={async () => {
          const res = await api.saveMcp({ servers });
          if (res.ok) { setStatus(res.status || {}); message.success('已保存并重连'); }
        }}>保存并重连</Button>
      </div>
    </div>
  );
}

export default function SettingsModal() {
  const open = useStore('settingsOpen');
  const density = useStore('density');
  return (
    <Modal open={open} title="设置" width={680} footer={null} onCancel={() => store.set({ settingsOpen: false })}>
      <Segmented
        options={[{ value: 'comfortable', label: '舒适' }, { value: 'standard', label: '标准' }, { value: 'compact', label: '紧凑' }]}
        value={density}
        onChange={(v) => {
          localStorage.setItem('ws.density', v);
          store.set({ density: v });
        }}
      />
      <span style={{ fontSize: 12, color: '#71717a', marginLeft: 10 }}>界面密度（全局即时生效）</span>
      <Tabs
        style={{ marginTop: 8 }}
        items={[
          { key: 'provider', label: 'Provider', children: <ProviderTab /> },
          { key: 'skills', label: 'Skills 技能', children: <SkillsTab /> },
          { key: 'mcp', label: 'MCP 服务', children: <McpTab /> },
        ]}
      />
    </Modal>
  );
}
