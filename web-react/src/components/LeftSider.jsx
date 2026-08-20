// 左栏：大纲树（点章节 = 选中整章）+ 页面列表
import { Layout, Tree, List } from 'antd';
import { store, useStore, chapterBlockIds } from '../store.js';

export default function LeftSider() {
  const docModel = useStore('docModel');
  const selection = useStore('selection');
  const dense = useStore('density') === 'compact';
  const leftW = useStore('leftW');

  if (!docModel) {
    return (
      <Layout.Sider theme="light" width={leftW} style={{ borderRight: '1px solid #f0f0f0' }} className="app-chrome">
        <div style={{ padding: 16, color: '#a1a1aa', fontSize: 13 }}>导入文档后显示大纲与页面</div>
      </Layout.Sider>
    );
  }

  const headings = docModel.blocks.filter(b => b.type === 'heading');
  const treeData = headings.map(h => ({
    title: (h.runs || []).map(r => r.text).join('') || '（无标题文字）',
    key: h.id,
  }));
  const selectedKeys = selection?.blockIds?.length
    ? headings.filter(h => selection.blockIds.includes(h.id)).map(h => h.id).slice(0, 1)
    : selection?.blockId ? [selection.blockId] : [];

  return (
    <Layout.Sider theme="light" width={leftW} style={{ borderRight: '1px solid #f0f0f0', overflow: 'auto' }} className="app-chrome">
      <div style={{ padding: '10px 12px 4px', fontSize: 12, color: '#71717a', fontWeight: 600 }}>大纲</div>
      <Tree
        treeData={treeData}
        selectedKeys={selectedKeys}
        defaultExpandAll
        showLine={{ showLeafIcon: false }}
        style={{ background: 'transparent', fontSize: 13 }}
        onSelect={(keys) => {
          const id = keys[0];
          if (!id) return;
          const ids = chapterBlockIds(docModel, id);
          const h = docModel.blocks.find(b => b.id === id);
          const title = (h?.runs || []).map(r => r.text).join('').slice(0, 10) || '章节';
          store.set({ selection: { blockIds: ids, label: `「${title}」${ids.length} 个块` } });
          store.scrollToBlock?.(id);
        }}
      />
      <div style={{ padding: '14px 12px 4px', fontSize: 12, color: '#71717a', fontWeight: 600, borderTop: '1px solid #f0f0f0' }}>页面</div>
      <PageList dense={dense} />
    </Layout.Sider>
  );
}

function PageList({ dense }) {
  const pages = useStore('pages') || [];
  return (
    <List
      size="small"
      dataSource={pages}
      locale={{ emptyText: '—' }}
      renderItem={(snippet, i) => (
        <List.Item
          style={{ padding: dense ? '3px 12px' : '6px 12px', cursor: 'pointer', fontSize: 12 }}
          onClick={() => store.scrollToPage?.(i)}
        >
          <span className="mono" style={{ color: '#71717a', marginRight: 8 }}>P{String(i + 1).padStart(2, '0')}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{snippet || '（空白页）'}</span>
        </List.Item>
      )}
    />
  );
}
