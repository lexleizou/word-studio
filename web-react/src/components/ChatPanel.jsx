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
    const usable = data.providers.filter(p => p.enabled !== false); // 停用的配置不出现在选择列表
    setProviders(usable);
    const active = usable.find(p => p.id === data.activeProviderId) || usable[0];
    if (active) {
      setProviderId(active.id);
      setModelName(active.model || '');
      loadModels(active);
    }
  };

  const loadModels = async (p) => {
    setWarning('');
    // 配置了"已启用模型"的 provider 直接用该清单，否则实时拉取
    if (p.models?.length) {
      setModels(p.models.map(m => ({ value: m.id, label: m.label || m.id })));
      return;
    }
    const data = await api.getModels(p.id);
    if (data.ok) {
      // 条目可能是字符串（openai 兼容）或 {id,label}（codex 后端）
      setModels((data.models || []).map(m => {
        const id = typeof m === 'string' ? m : m.id;
        return { value: id, label: typeof m === 'string' ? m : (m.label || m.id) };
      }));
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
        options={modelName && !models.some(o => o.value === modelName)
          ? [{ value: modelName, label: modelName }, ...models]
          : models}
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
  const doc = store.get('doc');
  const decide = async (accept) => {
    setState(accept ? 'accepted' : 'rejected');
    await api.confirmProposal(proposal.proposalId, accept);
    onDone?.(accept);
  };
  const rows = proposal.diff.slice(0, 12);
  // 图片新增项：提炼 assets 路径用于缩略图预览
  const imgOf = (c) => {
    const m = /\[图片 (assets\/[^\]]+)\]/.exec(c.after || '');
    return m ? `/api/docs/${doc?.id}/assets/${m[1].split('/').pop()}` : null;
  };
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
              {imgOf(c) && <img src={imgOf(c)} alt="待插入插图" style={{ marginTop: 4, maxWidth: 220, maxHeight: 160, borderRadius: 4, border: '1px solid #e4e4e7' }} />}
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
  // 打字机缓冲：SSE 按网络包突发到达，队列匀速吐字才是肉眼上的逐字流式
  const queueRef = useRef('');
  const drainTimerRef = useRef(null);
  const doneMetaRef = useRef(null); // done 事件已收到但队列未排空时暂存 footer 元信息

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [messages]);

  const push = (msg) => setMessages(prev => [...prev, msg]);
  const patchLast = (fn) => setMessages(prev => {
    const next = [...prev];
    next[next.length - 1] = fn(next[next.length - 1]);
    return next;
  });

  // 流式气泡：最后一条是 streaming 的 assistant 消息就复用，否则新开一条
  const appendStreamText = (text) => setMessages(prev => {
    const next = [...prev];
    const last = next[next.length - 1];
    if (last?.role === 'assistant' && last.streaming) {
      next[next.length - 1] = { ...last, text: last.text + text };
    } else {
      next.push({ role: 'assistant', text, streaming: true });
    }
    return next;
  });

  const finalizeIfReady = () => {
    const meta = doneMetaRef.current;
    if (!meta || queueRef.current) return; // 队列没排空继续打字
    doneMetaRef.current = null;
    setMessages(prev => {
      const next = [...prev];
      let i = next.length - 1;
      while (i >= 0 && next[i].role !== 'assistant') i--;
      const m = { model: meta.model, usage: meta.usage, tools: meta.tools };
      if (i === -1) next.push({ role: 'assistant', text: '', meta: m });
      else next[i] = { ...next[i], streaming: false, meta: m };
      return next;
    });
    setBusy(false);
  };

  const drain = () => {
    const q = queueRef.current;
    if (!q) {
      drainTimerRef.current = null;
      finalizeIfReady();
      return;
    }
    // 自适应吐字：积压越多吐得越快，保证追上实时流
    const n = q.length > 240 ? 16 : q.length > 120 ? 8 : q.length > 48 ? 4 : q.length > 16 ? 2 : 1;
    queueRef.current = q.slice(n);
    appendStreamText(q.slice(0, n));
    drainTimerRef.current = setTimeout(drain, 16);
  };
  const startDrain = () => { if (!drainTimerRef.current) drainTimerRef.current = setTimeout(drain, 0); };

  // 工具/提案事件介入前：把当前轮的剩余文字立即倒进气泡并封口，保持消息顺序
  const flushAndClose = () => {
    if (drainTimerRef.current) { clearTimeout(drainTimerRef.current); drainTimerRef.current = null; }
    const q = queueRef.current;
    queueRef.current = '';
    setMessages(prev => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === 'assistant' && last.streaming) {
        next[next.length - 1] = { ...last, text: last.text + q, streaming: false };
      } else if (q) {
        next.push({ role: 'assistant', text: q, streaming: false });
      }
      return next;
    });
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !doc || busy) return;
    setBusy(true);
    setInput('');
    push({ role: 'user', text, refNames: refChips.map(r => r.name) });
    const refIds = refChips.map(r => r.id);
    setRefChips([]);

    try {
      await api.chatStream(doc.id, { message: text, selection, refIds }, (event, data) => {
        switch (event) {
          case 'delta':
            queueRef.current += data.text;
            startDrain();
            break;
          case 'tool':
            flushAndClose();
            push({ role: 'tool', name: data.name });
            break;
          case 'proposal':
            flushAndClose();
            push({ role: 'proposal', proposal: data });
            break;
          case 'applied':
            flushAndClose();
            push({ role: 'tool', name: data.message, ok: true });
            store.loadDoc(doc.id); // 改动落盘后重载模型重渲染
            break;
          case 'rejected':
            flushAndClose();
            push({ role: 'tool', name: `已拒绝：${data.summary}`, rejected: true });
            break;
          case 'done':
            doneMetaRef.current = data;
            finalizeIfReady(); // 队列已空则立即收尾，否则由 drain 排空后收尾
            break;
          case 'error':
            flushAndClose();
            push({ role: 'error', text: data.message });
            break;
          default:
            break;
        }
      });
    } catch (err) {
      push({ role: 'error', text: '请求失败: ' + err.message });
    }
    if (!doneMetaRef.current) setBusy(false); // done 已收但未排空时由 finalizeIfReady 解锁
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
            if (m.role === 'assistant') return (m.text || m.meta) ? (
              <div key={i} style={m.text
                ? { background: '#f4f4f5', borderRadius: 8, padding: '8px 12px', margin: '0 32px 10px 0', fontSize: 13, whiteSpace: 'pre-wrap' }
                : { margin: '0 32px 10px 0', fontSize: 13 }}>
                {m.text}
                {m.streaming && <span className="ws-cursor">▍</span>}
                {m.meta && (
                  <div className="mono" style={{ marginTop: m.text ? 6 : 0, paddingTop: m.text ? 5 : 0, borderTop: m.text ? '1px dashed #e4e4e7' : 'none', fontSize: 11, color: '#a1a1aa', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <span>{m.meta.model || '模型未知'}</span>
                    <span>{m.meta.usage ? `${m.meta.usage.total.toLocaleString()} tokens` : 'tokens —'}</span>
                    <span>{
                      m.meta.tools?.count
                        ? `工具 ${m.meta.tools.count} 次${m.meta.tools.count <= 2 ? `（${m.meta.tools.all.join('、')}）` : ''}`
                        : '未调用工具'
                    }</span>
                  </div>
                )}
              </div>
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
