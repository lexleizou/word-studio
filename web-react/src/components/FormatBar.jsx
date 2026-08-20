// 格式菜单栏：页面设置 + 样式管理 + 选区联动的 B/I/U、字体、字号、对齐、行距 + 编辑模式
import { Button, Select, Divider, Tooltip, message } from 'antd';
import { LayoutOutlined, EditOutlined, AlignLeftOutlined, AlignCenterOutlined } from '@ant-design/icons';
import { store, useStore } from '../store.js';
import { targetBlocks, applyInline, allHaveProp } from '../engine/format-ops.js';

export default function FormatBar() {
  const docModel = useStore('docModel');
  const selection = useStore('selection');
  const editMode = useStore('editMode');
  const selOn = !!selection && !!docModel;

  const withSelection = async (fn, msg) => {
    const blocks = targetBlocks(docModel, selection);
    if (!blocks.length) return;
    fn(blocks);
    if (!await store.applyModelChange(msg)) message.error('保存失败');
  };

  const styles = Object.entries(docModel?.styles || {}).filter(([, st]) => st.type !== 'character');

  return (
    <div className="app-chrome" style={{ background: '#fff', borderBottom: '1px solid #f0f0f0', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <Button size="small" icon={<LayoutOutlined />} disabled={!docModel}
        onClick={() => store.set({ pageSetupOpen: true })}>页面设置</Button>
      <Select
        size="small" placeholder="样式…" style={{ width: 120 }} disabled={!docModel}
        value={null}
        options={styles.map(([id, st]) => ({ value: id, label: st.name || id }))}
        onChange={(id) => store.set({ styleEditId: id })}
      />
      <Divider type="vertical" />
      <Tooltip title="粗体"><Button size="small" type="text" disabled={!selOn}
        onClick={() => withSelection(b => applyInline(selection, b, { bold: !allHaveProp(selection, b, 'bold') }), 'format: 粗体')}><b>B</b></Button></Tooltip>
      <Tooltip title="斜体"><Button size="small" type="text" disabled={!selOn}
        onClick={() => withSelection(b => applyInline(selection, b, { italic: !allHaveProp(selection, b, 'italic') }), 'format: 斜体')}><i>I</i></Button></Tooltip>
      <Tooltip title="下划线"><Button size="small" type="text" disabled={!selOn}
        onClick={() => withSelection(b => applyInline(selection, b, { underline: !allHaveProp(selection, b, 'underline') }), 'format: 下划线')}><u>U</u></Button></Tooltip>
      <Select size="small" placeholder="字体" disabled={!selOn} style={{ width: 100 }} value={null}
        options={['宋体', '黑体', '微软雅黑', '楷体', 'Times New Roman', 'Arial'].map(v => ({ value: v }))}
        onChange={(v) => withSelection(b => applyInline(selection, b, { font: v }), `format: 字体 ${v}`)} />
      <Select size="small" placeholder="字号" disabled={!selOn} style={{ width: 90 }} value={null}
        options={[['小五', 9], ['五号', 10.5], ['小四', 12], ['四号', 14], ['三号', 16], ['小二', 18], ['二号', 22]].map(([label, v]) => ({ value: v, label }))}
        onChange={(v) => withSelection(b => applyInline(selection, b, { size: v }), `format: 字号 ${v}pt`)} />
      <Tooltip title="居左"><Button size="small" type="text" disabled={!selOn} icon={<AlignLeftOutlined />}
        onClick={() => withSelection(b => b.forEach(x => x.alignment = 'left'), 'format: 居左')} /></Tooltip>
      <Tooltip title="居中"><Button size="small" type="text" disabled={!selOn} icon={<AlignCenterOutlined />}
        onClick={() => withSelection(b => b.forEach(x => x.alignment = 'center'), 'format: 居中')} /></Tooltip>
      <Select size="small" placeholder="行距" disabled={!selOn} style={{ width: 80 }} value={null}
        options={[{ value: 0, label: '默认' }, { value: 1.15 }, { value: 1.5 }, { value: 2 }].map(o => ({ ...o, label: o.label || o.value }))}
        onChange={(v) => withSelection(b => b.forEach(x => { v ? x.lineHeight = v : delete x.lineHeight; }), v ? `format: 行距 ${v}` : 'format: 行距默认')} />
      <Divider type="vertical" />
      <Button size="small" type={editMode ? 'primary' : 'default'} icon={<EditOutlined />} disabled={!docModel}
        onClick={() => store.set({ editMode: !editMode, selection: null })}>
        {editMode ? '完成编辑' : '编辑'}
      </Button>
    </div>
  );
}
