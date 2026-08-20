// 中栏：Paged.js 分页预览 + 选区（块点选 / Shift 连选 / 块内文本选区）+ 块级编辑模式
import { useEffect, useRef } from 'react';
import { Skeleton, Empty, Button, message } from 'antd';
import { store, useStore, flattenBlocks } from '../store.js';
import { renderPaged } from '../engine/paged.js';

let anchorId = null;

function blockLabel(docModel, blockIds) {
  const first = docModel.blocks.find(b => b.id === blockIds[0]);
  if (blockIds.length === 1) return '1 个块';
  if (first?.type === 'heading') {
    const title = (first.runs || []).map(r => r.text).join('').slice(0, 10);
    return `「${title}」等 ${blockIds.length} 个块`;
  }
  return `${blockIds.length} 个块`;
}

function rangeIds(docModel, aId, bId) {
  const flat = flattenBlocks(docModel);
  const ia = flat.findIndex(b => b.id === aId);
  const ib = flat.findIndex(b => b.id === bId);
  if (ia === -1 || ib === -1) return [bId];
  const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
  return flat.slice(lo, hi + 1).map(b => b.id);
}

export default function PagedViewer() {
  const doc = useStore('doc');
  const docModel = useStore('docModel');
  const rendering = useStore('rendering');
  const selection = useStore('selection');
  const editMode = useStore('editMode');
  const containerRef = useRef(null);
  const flowRef = useRef(null);

  // 分页渲染
  useEffect(() => {
    if (!doc || !docModel || !containerRef.current) return;
    let cancelled = false;
    store.set({ rendering: true });
    renderPaged(containerRef.current, docModel, doc.id)
      .then(flow => {
        if (cancelled) return;
        flowRef.current = flow;
        // 左栏页面列表：页码 + 首行摘要
        store.set({
          // 摘要只取正文区（page_content；margin box 嵌在 pagebox 里，会带进页眉页脚文本）
          pages: (flow.pages || []).map(p =>
            (p.element.querySelector('.pagedjs_page_content')?.textContent || '')
              .trim().replace(/\s+/g, ' ').slice(0, 24)),
        });
      })
      .finally(() => { if (!cancelled) store.set({ rendering: false }); });
    return () => { cancelled = true; };
  }, [doc, docModel]);

  // 选区高亮（DOM 重建后由 selection 变化驱动）
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    root.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    if (!selection) return;
    const ids = selection.blockIds || [selection.blockId];
    for (const id of ids) {
      root.querySelectorAll(`[data-block-id="${id}"]`).forEach(el => el.classList.add('selected'));
    }
  }, [selection, rendering]);

  // 块点选 / Shift 连选（编辑模式下交给编辑器）
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !docModel || editMode) return;
    const onClick = (e) => {
      const el = e.target.closest('[data-block-id]');
      if (!el) { store.set({ selection: null }); anchorId = null; return; }
      const id = el.dataset.blockId;
      const ids = e.shiftKey && anchorId ? rangeIds(docModel, anchorId, id) : [id];
      if (!e.shiftKey) anchorId = id;
      store.set({ selection: { blockIds: ids, label: blockLabel(docModel, ids) } });
    };
    // 块内文本选区：仅未跨页拆分的块有效（拆分块降级为块选）
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const blockOf = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest?.('[data-block-id]');
      const a = blockOf(range.startContainer);
      const b = blockOf(range.endContainer);
      if (!a || !b || a !== b || !root.contains(a)) return;
      const sameId = root.querySelectorAll(`[data-block-id="${a.dataset.blockId}"]`);
      if (sameId.length > 1) {
        store.set({ selection: { blockIds: [a.dataset.blockId], label: '1 个块（跨页）' } });
        return;
      }
      const pre = range.cloneRange();
      pre.selectNodeContents(a);
      pre.setEnd(range.startContainer, range.startOffset);
      const start = pre.toString().length;
      const len = range.toString().length;
      if (len === 0) return;
      store.set({ selection: { blockId: a.dataset.blockId, startOffset: start, endOffset: start + len, label: `块内 ${len} 字` } });
    };
    root.addEventListener('click', onClick);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      root.removeEventListener('click', onClick);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [docModel, rendering, editMode]);

  // ---------- 块级编辑模式 ----------
  // Paged.js 会把长段落拆成多个同 id 碎片：进入编辑时把完整内容载入首个碎片，
  // 其余碎片临时隐藏，保存/取消后重新分页渲染，避免在碎片 DOM 上映射文本。
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !docModel || !editMode) return;
    let editing = null; // { el, blockId, hiddenFrags }

    const commit = async (save) => {
      if (!editing) return false;
      const { el, blockId, hiddenFrags } = editing;
      let changed = false;
      if (save) {
        const block = flattenBlocks(docModel).find(b => b.id === blockId);
        if (block) {
          const spans = el.querySelectorAll('[data-run-idx]');
          if (spans.length && spans.length === (block.runs || []).length) {
            // run 结构未变：按索引写回，保留格式
            spans.forEach((sp, i) => { block.runs[i].text = sp.innerText; });
          } else {
            // 结构变了（删空/粘贴）：合并为单个 run，继承原首个 run 的格式
            const first = (block.runs || [])[0] || {};
            block.runs = [{ ...first, text: el.innerText }];
          }
          const snippet = (block.runs[0]?.text || '').slice(0, 12);
          changed = true;
          el.contentEditable = 'false';
          el.classList.remove('editing');
          hiddenFrags.forEach(f => f.classList.remove('frag-hidden'));
          editing = null;
          if (!await store.applyModelChange(`manual: 编辑「${snippet}」`)) message.error('保存失败');
          return changed;
        }
      }
      el.contentEditable = 'false';
      el.classList.remove('editing');
      hiddenFrags.forEach(f => f.classList.remove('frag-hidden'));
      editing = null;
      if (!save) await store.applyModelChange(null); // 取消：仅重渲染恢复
      return changed;
    };

    const begin = (el) => {
      const blockId = el.dataset.blockId;
      const block = flattenBlocks(docModel).find(b => b.id === blockId);
      if (!block || !['paragraph', 'heading', 'list'].includes(block.type)) return; // 表格/图片/目录暂不支持
      const frags = [...root.querySelectorAll(`[data-block-id="${blockId}"]`)];
      const target = frags[0];
      const hiddenFrags = frags.slice(1);
      hiddenFrags.forEach(f => f.classList.add('frag-hidden'));
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      target.innerHTML = (block.runs || []).map((r, i) => `<span data-run-idx="${i}">${esc(r.text)}</span>`).join('');
      target.contentEditable = 'true';
      target.classList.add('editing');
      target.focus();
      document.getSelection()?.selectAllChildren(target);
      document.getSelection()?.collapseToEnd();
      editing = { el: target, blockId, hiddenFrags };
    };

    const onClick = (e) => {
      const el = e.target.closest('[data-block-id]');
      if (el && editing?.el === el) return;
      if (editing) commit(true);
      if (el) begin(el);
    };
    const onKeydown = (e) => {
      if (!editing) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commit(true);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        commit(false);
      }
    };
    const onFocusOut = (e) => {
      if (!editing || e.relatedTarget === editing.el || editing.el.contains(e.relatedTarget)) return;
      commit(true);
    };
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('focusout', onFocusOut);
    return () => {
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeydown);
      root.removeEventListener('focusout', onFocusOut);
    };
  }, [editMode, docModel, rendering]);

  // 暴露给左栏：页面/大纲跳转
  store.scrollToPage = (index) => {
    flowRef.current?.pages?.[index]?.element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  store.scrollToBlock = (blockId) => {
    containerRef.current?.querySelector(`[data-block-id="${blockId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (!doc) {
    return (
      <div className="viewer-scroll" style={{ flex: 1, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty
          description={
            <span style={{ color: '#71717a' }}>
              还没有打开文档。<br />导入一个 .docx 开始：内容与格式分离编辑，改动全程进 git。
            </span>}
        >
          <Button type="primary" onClick={() => store.openImport?.()}>导入 docx</Button>
        </Empty>
      </div>
    );
  }

  return (
    <div className={`viewer-scroll${editMode ? ' edit-mode-on' : ''}`} style={{ flex: 1, overflow: 'auto' }}>
      {rendering && (
        <div style={{ width: 620, margin: '20px auto 16px', background: '#fff', boxShadow: '0 1px 4px rgba(24,24,27,0.08)', padding: '56px 64px' }}>
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      )}
      {/* 容器必须保持可见：Paged.js 布局依赖实际测量，display:none 会失败 */}
      <div ref={containerRef} />
    </div>
  );
}
