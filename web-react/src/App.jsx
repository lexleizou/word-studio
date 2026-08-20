// 应用骨架：ConfigProvider（主题 + 密度）+ 三栏布局
import { useEffect } from 'react';
import { ConfigProvider, Layout, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { store, useStore } from './store.js';
import { cssText } from './styles.js';
import * as api from './api.js';
import TopBar from './components/TopBar.jsx';
import LeftSider from './components/LeftSider.jsx';
import PagedViewer from './components/PagedViewer.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import FormatBar from './components/FormatBar.jsx';
import PageSetupModal from './components/PageSetupModal.jsx';
import StyleModal from './components/StyleModal.jsx';
import HistoryDrawer from './components/HistoryDrawer.jsx';
import Resizer from './components/Resizer.jsx';

// 文档加载挂到 store，供各组件调用
store.loadDoc = async (docId) => {
  const res = await api.getModel(docId);
  if (!res.ok) return false;
  store.set({
    doc: { id: docId, name: res.model.meta?.title || docId },
    docModel: res.model,
    selection: null,
  });
  return true;
};

// 统一写回通道：手动编辑 / 格式调整 / AI 改动共用（null message = 只重渲染不写盘）
store.applyModelChange = async (message) => {
  const { doc, docModel } = store.getState();
  if (!doc || !docModel) return false;
  if (message != null) {
    const res = await api.saveModel(doc.id, docModel, message);
    if (!res.ok) return false;
  }
  store.set({ docModel: { ...docModel } }); // 换引用触发重渲染
  return true;
};

export default function App() {
  const density = useStore('density');

  // 全局样式注入
  useEffect(() => {
    const el = document.createElement('style');
    el.textContent = cssText;
    document.head.appendChild(el);
    return () => el.remove();
  }, []);

  // 深链：#doc=<id>；?pdf=1 为 PDF 打印纯净模式
  useEffect(() => {
    const pdfMode = new URLSearchParams(location.search).get('pdf') === '1';
    if (pdfMode) document.body.classList.add('pdf-mode');
    const docId = /^#doc=([a-zA-Z0-9_-]+)$/.exec(location.hash)?.[1];
    if (docId) {
      store.loadDoc(docId).then(() => {
        if (pdfMode) setTimeout(() => { document.title = 'PDF_READY'; }, 500);
      });
    }
  }, []);

  const algorithms = density === 'compact'
    ? [antdTheme.defaultAlgorithm, antdTheme.compactAlgorithm]
    : [antdTheme.defaultAlgorithm];

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: algorithms,
        token: {
          colorPrimary: '#34568b',
          colorInfo: '#34568b',
          colorText: '#18181b',
          colorTextSecondary: '#52525b',
          borderRadius: 6,
        },
      }}
    >
      <Layout style={{ height: '100vh' }}>
        <TopBar />
        <Layout style={{ height: 'calc(100vh - 48px)' }}>
          <LeftSider />
          <Resizer side="left" />
          <Layout.Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <FormatBar />
            <PagedViewer />
          </Layout.Content>
          <Resizer side="right" />
          <ChatPanel />
        </Layout>
      </Layout>
      <SettingsModal />
      <PageSetupModal />
      <StyleModal />
      <HistoryDrawer />
    </ConfigProvider>
  );
}
