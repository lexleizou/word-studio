// 右栏对话：模型栏 / 消息流 / 工具时间轴 / diff 确认卡 / @ 引用 / 选区 Tag
import { useState, useRef, useEffect } from 'react';
import { Layout, Tabs, Tag, Select, Input, Button, Popover, Alert, Card, List, message } from 'antd';
import { SendOutlined, PaperClipOutlined, ToolOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { store, useStore } from '../store.js';
import * as api from '../api.js';

// ---------- 模型栏 ----------
function ModelBar() {
  const [providers, setProviders] = useState([]);
  const [models, setModels] = useState([]);
  const [providerId, setProviderId] = useState(null);
  const [modelName, setModelName] = useState('');
  const [warning, setWarning] = useState('');

  const refresh = async () => {
    const data = await api.getProviders();
    if (!data.ok) return;
    setProviders(data.providers);
    const active = data.providers.find(p => p.id === data.activeProviderId) || data.providers[0];
    if (active) {
      setProviderId(active.id);
      setModelName(active.model || '');
      loadModels(active);
    }
  };

  const loadModels = async (p) => {
    setWarning('');
    const data = await api.getModels(p.id);
    if (data.ok) {
      setModels(data.models || []);
      if (data.warning) setWarning(data.warning);
      else if (!data.models?.length && p.type !== 'copilot' && !p.hasKey) setWarning('该 provider 未配置 API Key');
    }
  };

  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const h = () => refresh();
    window.addEventListener('providers-changed', h);
    return () => window.removeEventListener('providers-changed', h);
  }, []);

  const save = async (pid, mname) => {
    await api.saveProviders(providers.map(p => p.id === pid ? { ...p, model: mname } : p), pid);
  };

  return (
    <div style={{ display: 'flex', gap: 6, padding: '6px 12px 0', alignItems: 'center' }}>
      <Select
        size="small"
        style={{ width: 128 }}
        value={providerId}
        options={providers.map(p => ({ value: p.id, label: p.name }))}
        placeholder="provider"
        onChange={async (v) => {
          setProviderId(v);
          const p = providers.find(x => x.id === v);
          setModelName(p?.model || '');
          await save(v, p?.model || '');
          if (p) loadModels(p);
        }}
      />
      <Select
        size="small"
        style={{ flex: 1 }}
        value={modelName || undefined}
        placeholder="模型名"
        showSearch
        options={[...new Set([...(modelName ? [modelName] : []), ...models])].map(m => ({ value: m }))}
        onChange={async (v) => { setModelName(v); await save(providerId, v); }}
      />
      {warning && <span style={{ fontSize: 11, color: '#b91c1c' }} title={warning}>⚠</span>}
    </div>
  );
}

// ---------- 工具时间轴 ----------
function ToolItem({ name, ok, rejected }) {
  const Icon = rejected ? CloseCircleOutlined : ok ? CheckCircleOutlined : ToolOutlined;
  const color = rejected ? '#b91c1c' : ok ? '#16a34a' : '#71717a';
  return (
    <div style={{ fontSize: 12, color, borderLeft: '2px solid #e4e4e7', paddingLeft: 8, margin: '0 0 6px 4px', display: 'flex', alignItems: 'center', gap: 6 }}>
      <Icon />
      <span className="mono">{name}</span>
    </div>
  );
}

// ---------- diff 确认卡 ----------
function ProposalCard({ proposal, onDone }) {
  const [state, setState] = useState('pending'); // pending | accepted | rejected
  const decide = async (accept) => {
    setState(accept ? 'accepted' : 'rejected');
    await api.confirmProposal(proposal.proposalId, accept);
    onDone?.(accept);
  };
  const rows = proposal.diff.slice(0, 12);
  return (
    <Card
      size="small"
      style={{ border: `1px solid ${state === 'accepted' ? '#16a34a' : state === 'rejected' ? '#d4d4d8' : '#34568b'}`, marginBottom: 10, opacity: state === 'rejected' ? 0.7 : 1 }}
      title={`提案：${proposal.summary}`}
    >
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        {rows.map((c, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6, fontSize: 12 }}>
            <span style={{
              flex: 'none', width: 44, textAlign: 'center', borderRadius: 4, fontSize: 11, height: 18, lineHeight: '18px',
              background: c.type === 'remove' ? '#fef2f2' : '#eef2f8', color: c.type === 'remove' ? '#b91c1c' : '#34568b',
            }}>
              {{ add: '新增', modify: '修改', remove: '删除', styles: '样式表', pageSetup: '页面设置' }[c.type] || c.type}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              {c.before && <div style={{ color: '#b91c1c', textDecoration: 'line-through', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.before.slice(0, 120)}</div>}
              {c.after && <div style={{ color: '#15803d', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.after.slice(0, 120)}</div>}
            </div>
          </div>
        ))}
        {proposal.diff.length > 12 && <div style={{ color: '#71717a', fontSize: 12 }}>…共 {proposal.diff.length} 处变化</div>}
      </div>
      {state === 'pending' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <Button type="primary" size="small" icon={<CheckCircleOutlined />} onClick={() => decide(true)}>确认落盘</Button>
          <Button size="small" onClick={() => decide(false)}>拒绝</Button>
        </div>
      )}
      {state !== 'pending' && <div style={{ fontSize: 12, color: '#71717a', marginTop: 8 }}>{state === 'accepted' ? '已确认落盘' : '已拒绝'}</div>}
    </Card>
  );
}

// ---------- @ 引用弹层 ----------
function MentionPopover({ onPick, children }) {
  const doc = useStore('doc');
  const [refs, setRefs] = useState([]);
  const fileRef = useRef(null);
  const load = () => doc && api.listRefs(doc.id).then(d => d.ok && setRefs(d.refs));
  const content = (
    <div style={{ width: 240 }}>
      {refs.map(r => (
        <div key={r.id}
          style={{ padding: '6px 10px', cursor: 'pointer', borderRadius: 4, display: 'flex', justifyContent: 'space-between', fontSize: 13 }}
          onMouseEnter={e => e.currentTarget.style.background = '#f4f4f5'}
          onMouseLeave={e => e.currentTarget.style.background = ''}
          onClick={() => onPick({ id: r.id, name: r.name })}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
          <span style={{ color: '#71717a', fontSize: 11, flex: 'none' }}>{r.isImage ? '图片' : r.chars + ' 字'}</span>
        </div>
      ))}
      <div style={{ padding: '6px 10px', cursor: 'pointer', color: '#34568b', fontSize: 13 }}
        onClick={() => fileRef.current?.click()}>
        上传新文件…
      </div>
      <input ref={fileRef} type="file" hidden onChange={async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f || !doc) return;
        const res = await api.uploadRef(doc.id, f);
        if (res.ok) onPick({ id: res.ref.id, name: res.ref.name });
        else message.error('上传失败: ' + (res.message || res.error));
      }} />
    </div>
  );
  return (
    <Popover content={content} trigger="click" placement="topLeft" onOpenChange={(o) => o && load()} arrow={false}>
      {children}
    </Popover>
  );
}

// ---------- 文件面板 ----------
const KIND_LABEL = { main: ['主文档', 'processing'], ref: ['引用', 'geekblue'], export: ['导出', 'green'] };
function FilesPanel() {
  const doc = useStore('doc');
  const [files, setFiles] = useState([]);
  useEffect(() => {
    if (doc) fetch(`/api/docs/${doc.id}/files`).then(r => r.json()).then(d => d.ok && setFiles(d.files));
  }, [doc]);
  return (
    <List
      size="small"
      style={{ padding: '0 12px', overflow: 'auto', flex: 1 }}
      dataSource={files}
      locale={{ emptyText: '暂无文件' }}
      renderItem={(f) => {
        const [label, color] = KIND_LABEL[f.kind] || [f.kind, 'default'];
        return (
          <List.Item style={{ padding: '8px 4px', fontSize: 13 }}>
            <Tag color={color} style={{ marginRight: 8 }}>{label}</Tag>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
          </List.Item>
        );
      }}
    />
  );
}

// ---------- 对话面板 ----------
export default function ChatPanel() {
  const doc = useStore('doc');
  const selection = useStore('selection');
  const rightW = useStore('rightW');
  const [messages, setMessages] = useState([]); // {role:'user'|'assistant'|'tool'|'proposal'|'error', ...}
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [refChips, setRefChips] = useState([]);
  const [tab, setTab] = useState('chat');
  const streamRef = useRef(null);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [messages]);

  const push = (msg) => setMessages(prev => [...prev, msg]);
  const patchLast = (fn) => setMessages(prev => {
    const next = [...prev];
    next[next.length - 1] = fn(next[next.length - 1]);
    return next;
  });

  const send = async () => {
    const text = input.trim();
    if (!text || !doc || busy) return;
    setBusy(true);
    setInput('');
    push({ role: 'user', text, refNames: refChips.map(r => r.name) });
    const refIds = refChips.map(r => r.id);
    setRefChips([]);
    push({ role: 'assistant', text: '' });

    try {
      await api.chatStream(doc.id, { message: text, selection, refIds }, (event, data) => {
        switch (event) {
          case 'delta':
            patchLast(m => m.role === 'assistant' ? { ...m, text: m.text + data.text } : m);
            break;
          case 'tool':
            push({ role: 'tool', name: data.name });
            break;
          case 'proposal':
            push({ role: 'proposal', proposal: data });
            break;
          case 'applied':
            push({ role: 'tool', name: data.message, ok: true });
            store.loadDoc(doc.id); // 改动落盘后重载模型重渲染
            break;
          case 'rejected':
            push({ role: 'tool', name: `已拒绝：${data.summary}`, rejected: true });
            break;
          case 'error':
            push({ role: 'error', text: data.message });
            break;
          default:
            break;
        }
      });
    } catch (err) {
      push({ role: 'error', text: '请求失败: ' + err.message });
    }
    setBusy(false);
  };

  return (
    <Layout.Sider theme="light" width={rightW} style={{ borderLeft: '1px solid #f0f0f0' }} className="app-chrome">
      <Tabs
        activeKey={tab}
        onChange={setTab}
        size="small"
        style={{ padding: '0 12px', marginBottom: 0 }}
        items={[{ key: 'chat', label: '对话' }, { key: 'files', label: '文件' }]}
      />
      {tab === 'files' ? (
        <FilesPanel />
      ) : (
      <div className="chat-column">
        {selection && (
          <div style={{ padding: '0 12px 6px' }}>
            <Tag closable color="geekblue" onClose={() => store.set({ selection: null })}>{selection.label}</Tag>
          </div>
        )}
        <div ref={streamRef} className="chat-stream" style={{ padding: '4px 12px 12px' }}>
          {messages.length === 0 && (
            <div style={{ color: '#a1a1aa', fontSize: 13, padding: '24px 8px', textAlign: 'center' }}>
              还没有对话。选中一段文字，或直接描述你的修改需求。
            </div>
          )}
          {messages.map((m, i) => {
            if (m.role === 'user') return (
              <div key={i} style={{ background: '#eef2f8', borderRadius: 8, padding: '8px 12px', margin: '0 0 10px 32px', fontSize: 13, whiteSpace: 'pre-wrap' }}>
                {m.text}
                {m.refNames?.length > 0 && <div style={{ marginTop: 4, fontSize: 11, color: '#71717a' }}>引用：{m.refNames.join('、')}</div>}
              </div>
            );
            if (m.role === 'assistant') return m.text ? (
              <div key={i} style={{ background: '#f4f4f5', borderRadius: 8, padding: '8px 12px', margin: '0 32px 10px 0', fontSize: 13, whiteSpace: 'pre-wrap' }}>{m.text}</div>
            ) : null;
            if (m.role === 'tool') return <ToolItem key={i} name={m.name} ok={m.ok} rejected={m.rejected} />;
            if (m.role === 'proposal') return <ProposalCard key={i} proposal={m.proposal} />;
            if (m.role === 'error') return <Alert key={i} type="error" showIcon style={{ marginBottom: 10 }} message={m.text} />;
            return null;
          })}
        </div>
        <ModelBar />
        {refChips.length > 0 && (
          <div style={{ padding: '6px 12px 0', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {refChips.map((r, idx) => (
              <Tag key={r.id} closable color="geekblue" onClose={() => setRefChips(prev => prev.filter((_, j) => j !== idx))}>{r.name}</Tag>
            ))}
          </div>
        )}
        <div style={{ borderTop: '1px solid #f0f0f0', padding: '8px 12px', display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <MentionPopover onPick={(r) => setRefChips(prev => prev.some(x => x.id === r.id) ? prev : [...prev, r])}>
            <Button icon={<PaperClipOutlined />} disabled={!doc} title="@ 引用文件" />
          </MentionPopover>
          <Input.TextArea
            autoSize={{ minRows: 1, maxRows: 4 }}
            placeholder="输入消息，@ 引用文件…"
            style={{ resize: 'none', flex: 1 }}
            value={input}
            disabled={!doc}
            onChange={e => setInput(e.target.value)}
            onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <Button type="primary" icon={<SendOutlined />} disabled={!doc || busy} onClick={send} loading={busy}>发送</Button>
        </div>
      </div>
      )}
    </Layout.Sider>
  );
}
