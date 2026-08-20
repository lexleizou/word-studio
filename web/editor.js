// 块级编辑模式：「编辑」切换，点块就地改文本，保存写模型 + git commit
// 注意：Paged.js 会把长段落拆成多个同 id 的页面碎片。
// 进入编辑时，把块的完整内容载入首个碎片就地编辑（其余碎片临时隐藏），
// 保存/取消后都重新分页渲染，避免在碎片 DOM 上映射文本。
import * as model from './model.js';

let editMode = false;
let editing = null; // { el, blockId, snapshotHtml, hiddenFrags }

export function isEditMode() { return editMode; }

function blockFullHtml(block) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (block.runs || []).map((r, i) => `<span data-run-idx="${i}">${esc(r.text)}</span>`).join('');
}

function commitEditing(save) {
  if (!editing) return null;
  const { el, blockId, hiddenFrags } = editing;
  let result = null;
  if (save) {
    const docModel = model.get('docModel');
    const block = model.flattenBlocks(docModel).find(b => b.id === blockId);
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
      result = { blockId, snippet };
    }
  }
  el.contentEditable = 'false';
  el.classList.remove('editing');
  hiddenFrags.forEach(f => f.classList.remove('frag-hidden'));
  editing = null;
  return result;
}

function beginEdit(el, viewer) {
  commitEditing(true); // 先保存上一个
  const docModel = model.get('docModel');
  const blockId = el.dataset.blockId;
  const block = model.flattenBlocks(docModel).find(b => b.id === blockId);
  if (!block) return;
  if (!['paragraph', 'heading', 'list'].includes(block.type)) return; // 表格/图片/目录暂不支持就地编辑

  // 载入完整内容到首个碎片，隐藏其余碎片
  const frags = [...viewer.querySelectorAll(`[data-block-id="${blockId}"]`)];
  const target = frags[0];
  const hiddenFrags = frags.slice(1);
  hiddenFrags.forEach(f => f.classList.add('frag-hidden'));
  target.innerHTML = blockFullHtml(block);
  target.contentEditable = 'true';
  target.classList.add('editing');
  target.focus();
  document.getSelection()?.selectAllChildren(target);
  document.getSelection()?.collapseToEnd();
  editing = { el: target, blockId, hiddenFrags };
}

export function initEditor(onModelChanged) {
  const btn = document.getElementById('btn-edit-mode');
  const viewer = document.getElementById('viewer');

  model.subscribe('docModel', (m) => {
    btn.disabled = !m;
    if (!m && editMode) toggle();
  });

  function toggle() {
    commitEditing(true);
    editMode = !editMode;
    btn.classList.toggle('active-mode', editMode);
    btn.textContent = editMode ? '完成编辑' : '编辑';
    viewer.classList.toggle('edit-mode', editMode);
  }
  btn.addEventListener('click', toggle);

  viewer.addEventListener('click', (e) => {
    if (!editMode) return;
    const el = e.target.closest('[data-block-id]');
    if (el && editing?.el === el) return; // 正在编辑本块
    if (el) beginEdit(el, viewer);
    else commitEditing(true);
  });

  viewer.addEventListener('keydown', async (e) => {
    if (!editMode || !editing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const r = commitEditing(true);
      if (r) await onModelChanged(`manual: 编辑「${r.snippet}」`);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      commitEditing(false);
      await onModelChanged(null); // 仅重渲染恢复（null 表示不写盘，见 app.js）
    }
  });

  // 失焦自动保存
  viewer.addEventListener('focusout', async (e) => {
    if (!editMode || !editing || e.relatedTarget === editing.el || editing.el.contains(e.relatedTarget)) return;
    const r = commitEditing(true);
    if (r) await onModelChanged(`manual: 编辑「${r.snippet}」`);
  });
}
