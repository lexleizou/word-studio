// 设置面板：Provider / Skills / MCP / Copilot + 密度开关（label 在上的竖排表单）
import { useState, useEffect, useRef } from 'react';
import { Modal, Tabs, Input, Radio, Button, Checkbox, Select, Tag, Segmented, message } from 'antd';
import { PlusOutlined, DeleteOutlined, ImportOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { store, useStore } from '../store.js';
import * as api from '../api.js';

function ProviderCard({ p, active, onChange, onDelete }) {
  const set = (k, v) => onChange({ ...p, [k]: v });
  return (
    <div style={{ border: '1px solid #e4e4e7', borderRadius: 8, padding: '12px 14px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <Radio checked={active} onChange={() => onChange({ ...p, __activate: true })}>作为当前激活</Radio>
        {p.type === 'copilot' && <Tag color="blue" style={{ marginLeft: 8 }}>Copilot OAuth</Tag>}
        <div style={{ flex: 1 }} />
        <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={onDelete} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <div style={{ fontSize: 12, color: '#71717a', marginBottom: 4 }}>名称</div>
          <Input size="small" value={p.name} onChange={e => set('name', e.target.value)} />
        </div>
        <div>
          <div style={{ fontSize: 12, color: '#71717a', marginBottom: 4 }}>模型名</div>
          <Input size="small" value={p.model} onChange={e => set('model', e.target.value)} />
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <div style={{ fontSize: 12, color: '#71717a', marginBottom: 4 }}>baseURL</div>
          <Input size="small" value={p.baseUrl} disabled={p.type === 'copilot'} onChange={e => set('baseUrl', e.target.value)} />
        </div>
        {p.type !== 'copilot' && (
          <div style={{ gridColumn: '1 / -1' }}>
            <div style={{ fontSize: 12, color: '#71717a', marginBottom: 4 }}>API Key</div>
            <Input.Password size="small" placeholder={p.hasKey ? '已配置（留空不变）' : 'API Key'} value={p.apiKey || ''} onChange={e => set('apiKey', e.target.value)} />
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderTab() {
  const [providers, setProviders] = useState([]);
  const [activeId, setActiveId] = useState(null);

  useEffect(() => {
    api.getProviders().then(d => {
      if (!d.ok) return;
      setProviders(d.providers);
      setActiveId(d.activeProviderId || d.providers[0]?.id);
    });
  }, []);

  const save = async (nextProviders, nextActive) => {
    const body = nextProviders.map(p => ({
      id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey || '',
    })).filter(p => p.baseUrl || p.type === 'copilot');
    await api.saveProviders(body, nextActive);
    window.dispatchEvent(new CustomEvent('providers-changed'));
    message.success('已保存');
  };

  return (
    <div>
      {providers.map(p => (
        <ProviderCard key={p.id} p={p} active={p.id === activeId}
          onChange={(np) => {
            const next = providers.map(x => x.id === np.id ? np : x);
            setProviders(next);
            if (np.__activate) setActiveId(np.id);
          }}
          onDelete={() => setProviders(providers.filter(x => x.id !== p.id))} />
      ))}
      <Button type="dashed" block icon={<PlusOutlined />}
        onClick={() => setProviders([...providers, { id: 'p' + Date.now().toString(36), name: '', type: 'openai-compat', baseUrl: '', model: '' }])}>
        添加 endpoint
      </Button>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <Button type="primary" onClick={() => save(providers, activeId)}>保存</Button>
      </div>
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

function CopilotTab() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [device, setDevice] = useState(null);
  const [pollState, setPollState] = useState('');
  useEffect(() => { api.copilotStatus().then(d => d.ok && setLoggedIn(d.loggedIn)); }, []);
  const login = async () => {
    const r = await api.copilotStart();
    if (!r.ok) { setPollState('发起失败: ' + (r.message || r.error)); return; }
    setDevice(r);
    setPollState('等待授权…');
    const timer = setInterval(async () => {
      const p = await api.copilotPoll();
      if (p.status === 'ok') {
        clearInterval(timer);
        setDevice(null);
        setLoggedIn(true);
        setPollState('');
        message.success('Copilot 登录成功');
        window.dispatchEvent(new CustomEvent('providers-changed'));
      } else if (p.status === 'error') {
        clearInterval(timer);
        setPollState('登录失败: ' + p.message);
      }
    }, 5500);
  };
  return (
    <div>
      <p>
        {loggedIn
          ? <Tag color="success" icon={<CheckCircleOutlined />}>已登录</Tag>
          : <Tag>未登录</Tag>}
        GitHub Copilot（登录后可作为 provider 激活）
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button disabled={loggedIn} onClick={login}>设备码登录</Button>
        <Button disabled={!loggedIn} onClick={async () => {
          await api.copilotLogout();
          setLoggedIn(false);
          window.dispatchEvent(new CustomEvent('providers-changed'));
        }}>登出</Button>
      </div>
      {device && (
        <p style={{ marginTop: 8 }}>
          请打开 <a href={device.verificationUri} target="_blank" rel="noreferrer">{device.verificationUri}</a> 并输入验证码：
          <b style={{ fontSize: 16 }}>{device.userCode}</b>
        </p>
      )}
      {pollState && <p style={{ color: '#b91c1c', fontSize: 12 }}>{pollState}</p>}
      <p style={{ color: '#71717a', fontSize: 12, marginTop: 12 }}>使用 GitHub 非公开 API 方案，政策变动可能导致失效。</p>
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
          { key: 'copilot', label: 'Copilot', children: <CopilotTab /> },
        ]}
      />
    </Modal>
  );
}
