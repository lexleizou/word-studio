// 版本历史：右侧 Drawer + Timeline，回退为新 commit
import { useState, useEffect } from 'react';
import { Drawer, Timeline, Button, Tag, Popconfirm, message } from 'antd';
import { store, useStore } from '../store.js';
import * as api from '../api.js';

const KIND = { ai: ['AI', 'blue'], format: ['格式', 'geekblue'], manual: ['手动', 'green'], import: ['导入', 'default'], revert: ['回退', 'orange'] };
const kindOf = (msg) => KIND[(msg || '').split(':')[0]] || ['其他', 'default'];

export default function HistoryDrawer() {
  const open = useStore('historyOpen');
  const doc = useStore('doc');
  const [history, setHistory] = useState([]);

  useEffect(() => {
    if (open && doc) api.getHistory(doc.id).then(d => d.ok && setHistory(d.history));
  }, [open, doc]);

  const revert = async (hash) => {
    const res = await api.checkoutDoc(doc.id, hash);
    if (!res.ok) { message.error('回退失败: ' + (res.message || res.error)); return; }
    store.set({ docModel: res.model, selection: null, historyOpen: false });
    message.success('已回退（作为新提交追加）');
  };

  return (
    <Drawer open={!!open} title="版本历史" width={440} onClose={() => store.set({ historyOpen: false })}>
      <Timeline
        items={history.map(h => {
          const [kind, color] = kindOf(h.message);
          return {
            children: (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <Tag color={color} style={{ marginRight: 6 }}>{kind}</Tag>{h.message}
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: '#71717a' }}>
                    {new Date(h.date).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · {h.hash.slice(0, 7)}
                  </div>
                </div>
                <Popconfirm title={`回退到 ${h.hash.slice(0, 7)}？`} description="当前状态不会被覆盖，回退作为新提交追加。" onConfirm={() => revert(h.hash)}>
                  <Button size="small">回退到此</Button>
                </Popconfirm>
              </div>
            ),
          };
        })}
      />
      <p style={{ color: '#71717a', fontSize: 12 }}>回退不会覆盖历史：当前状态会保留，回退作为新的提交追加。</p>
    </Drawer>
  );
}
