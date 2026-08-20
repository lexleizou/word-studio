// 选区机制：块点选 / Shift 连选 / 大纲选章 / 块内文本选区
// 选区统一存 model.selection：{ blockIds:[...] } 或 { blockId, startOffset, endOffset }
import * as model from './model.js';

let anchorId = null; // Shift 连选锚点

export function clearSelection() {
  anchorId = null;
  model.set('selection', null);
}

// 章节子树：标题块 + 直到同级或更高级标题前的所有块
export function chapterBlockIds(docModel, headingId) {
  const blocks = docModel.blocks;
  const idx = blocks.findIndex(b => b.id === headingId);
  if (idx === -1 || blocks[idx].type !== 'heading') return [headingId];
  const level = blocks[idx].level;
  const ids = [];
  for (let i = idx; i < blocks.length; i++) {
    if (i > idx && blocks[i].type === 'heading' && blocks[i].level <= level) break;
    ids.push(blocks[i].id);
  }
  return ids;
}

function rangeIds(docModel, aId, bId) {
  const blocks = model.flattenBlocks(docModel);
  const ia = blocks.findIndex(b => b.id === aId);
  const ib = blocks.findIndex(b => b.id === bId);
  if (ia === -1 || ib === -1) return [bId];
  const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
  return blocks.slice(lo, hi + 1).map(b => b.id);
}

// 块内文本选区：selectionchange 时调用；仅在「未跨页拆分」的块上有效
function captureTextSelection(viewerEl) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const blockOf = (node) => (node.nodeType === 1 ? node : node.parentElement)?.closest?.('[data-block-id]');
  const a = blockOf(range.startContainer);
  const b = blockOf(range.endContainer);
  if (!a || !b || a !== b || !viewerEl.contains(a)) return null;
  // 跨页拆分的块在 DOM 里有多个同 id 元素，文本偏移无法映射回模型，降级为块选
  const sameId = viewerEl.querySelectorAll(`[data-block-id="${a.dataset.blockId}"]`);
  if (sameId.length > 1) return { blockIds: [a.dataset.blockId], label: '1 个块（跨页）' };
  const pre = range.cloneRange();
  pre.selectNodeContents(a);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const len = range.toString().length;
  if (len === 0) return null;
  return { blockId: a.dataset.blockId, startOffset: start, endOffset: start + len, label: `块内 ${len} 字` };
}

function blockLabel(docModel, blockIds) {
  const first = docModel.blocks.find(b => b.id === blockIds[0]);
  if (blockIds.length === 1) return '1 个块';
  if (first?.type === 'heading') {
    const title = (first.runs || []).map(r => r.text).join('').slice(0, 10);
    return `「${title}」等 ${blockIds.length} 个块`;
  }
  return `${blockIds.length} 个块`;
}

// 高亮同步（订阅 model.selection）
function syncHighlight() {
  const viewer = document.getElementById('viewer');
  model.subscribe('selection', (sel) => {
    viewer.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    if (!sel) return;
    const ids = sel.blockIds || [sel.blockId];
    for (const id of ids) {
      viewer.querySelectorAll(`[data-block-id="${id}"]`).forEach(el => el.classList.add('selected'));
    }
  });
}

// isEditMode() 为 true 时，点击交给编辑器，不做选区
export function initSelection(isEditMode, onChapterScroll) {
  const viewer = document.getElementById('viewer');
  syncHighlight();

  viewer.addEventListener('click', (e) => {
    if (isEditMode()) return;
    const el = e.target.closest('[data-block-id]');
    if (!el) { clearSelection(); return; }
    const docModel = model.get('docModel');
    if (!docModel) return;
    const id = el.dataset.blockId;
    const ids = e.shiftKey && anchorId ? rangeIds(docModel, anchorId, id) : [id];
    if (!e.shiftKey) anchorId = id;
    model.set('selection', { blockIds: ids, label: blockLabel(docModel, ids) });
  });

  // 块内文本选区（拖选文字）
  document.addEventListener('selectionchange', () => {
    if (isEditMode()) return;
    const textSel = captureTextSelection(viewer);
    if (textSel) model.set('selection', textSel);
  });

  // 大纲点章节 = 选中整章子树（渲染大纲时已绑定跳转，这里由 app.js 统一改接）
  void onChapterScroll;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !isEditMode()) clearSelection();
  });
}
