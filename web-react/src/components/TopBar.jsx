// 顶栏：品牌 / 文档名 / 导入 / 健康状态 / 历史 / 导出 / 设置
import { useRef, useEffect, useState } from 'react';
import { Layout, Button, Badge, message } from 'antd';
import { UploadOutlined, HistoryOutlined, FilePdfOutlined, FileWordOutlined, SettingOutlined } from '@ant-design/icons';
import { store, useStore } from '../store.js';
import * as api from '../api.js';

export default function TopBar() {
  const doc = useStore('doc');
  const [healthy, setHealthy] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    const check = () => api.health().then(i => setHealthy(!!i.ok)).catch(() => setHealthy(false));
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, []);

  store.openImport = () => fileRef.current?.click();

  const onFile = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const hide = message.loading('导入中…', 0);
    try {
      const res = await api.importDoc(file);
      if (!res.ok) { message.error('导入失败: ' + (res.message || res.error)); return; }
      await store.loadDoc(res.id);
      message.success(`已导入：${res.name}（${res.blocks} 个块）`);
    } finally {
      hide();
    }
  };

  return (
    <Layout.Header style={{
      background: '#fff', padding: '0 16px', height: 48, lineHeight: '48px',
      borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 12,
    }} className="app-chrome">
      <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: '-0.02em' }}>Word Studio</span>
      <span style={{ color: '#71717a' }}>{doc?.name || '未打开文档'}</span>
      <Button type="primary" size="small" icon={<UploadOutlined />} onClick={() => fileRef.current?.click()}>导入 docx</Button>
      <input ref={fileRef} type="file" accept=".docx,.doc" hidden onChange={onFile} />
      <div style={{ flex: 1 }} />
      <Badge status={healthy ? 'success' : 'error'} text={healthy ? '服务正常' : '服务不可达'} style={{ fontSize: 12 }} />
      <Button size="small" icon={<HistoryOutlined />} disabled={!doc} onClick={() => store.set({ historyOpen: true })}>历史</Button>
      <Button size="small" icon={<FilePdfOutlined />} disabled={!doc}
        onClick={() => { if (doc) location.href = `/api/docs/${doc.id}/export.pdf`; }}>导出 PDF</Button>
      <Button type="primary" size="small" icon={<FileWordOutlined />} disabled={!doc}
        onClick={() => { if (doc) location.href = `/api/docs/${doc.id}/export.docx`; }}>导出 docx</Button>
      <Button size="small" icon={<SettingOutlined />} onClick={() => store.set({ settingsOpen: true })}>设置</Button>
    </Layout.Header>
  );
}
