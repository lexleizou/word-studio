// 主控制器：resizer、折叠态、右栏 tab、健康检查、文档导入
import * as api from './api.js';
import * as model from './model.js';
import { renderPaged, renderOutline, renderPageList } from './viewer.js';
import { initFormatMenu } from './format-menu.js';
import { initHistory } from './history.js';
import { initSelection, chapterBlockIds, clearSelection } from './selection.js';
import { initEditor, isEditMode } from './editor.js';
import { initChat } from './chat.js';
import { initSettings } from './settings.js';
import { initFilesPanel } from './files-panel.js';
import { initModelBar } from './model-bar.js';

const LS_KEY = 'word-studio.layout';

// ---------- 布局状态（宽度 + 折叠态）持久化 ----------
function loadLayout() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}
function saveLayout(patch) {
  localStorage.setItem(LS_KEY, JSON.stringify({ ...loadLayout(), ...patch }));
}

function applyLayout() {
  const saved = loadLayout();
  if (saved.leftW) document.documentElement.style.setProperty('--left-w', saved.leftW + 'px');
  if (saved.rightW) document.documentElement.style.setProperty('--right-w', saved.rightW + 'px');
  if (saved.left) document.body.dataset.left = saved.left;
  if (saved.right) document.body.dataset.right = saved.right;
}

// ---------- 手写 resizer：pointermove 改变量 + clamp ----------
function initResizer(el, side) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.classList.add('active');
    el.setPointerCapture(e.pointerId);
    const varName = side === 'left' ? '--left-w' : '--right-w';
    const startX = e.clientX;
    const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue(varName), 10);

    const onMove = (ev) => {
      // 左栏：向右拖变宽；右栏：向左拖变宽
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
      const w = Math.min(560, Math.max(180, startW + delta)); // clamp 180~560
      document.documentElement.style.setProperty(varName, w + 'px');
    };
    const onUp = () => {
      el.classList.remove('active');
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      const finalW = parseInt(getComputedStyle(document.documentElement).getPropertyValue(varName), 10);
      saveLayout({ [side === 'left' ? 'leftW' : 'rightW']: finalW });
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  });
}

// ---------- 折叠 / 展开 ----------
function initCollapse() {
  const setSide = (side, value) => {
    document.body.dataset[side] = value;
    saveLayout({ [side]: value });
  };
  document.getElementById('collapse-left').addEventListener('click', () => setSide('left', 'collapsed'));
  document.getElementById('expand-left').addEventListener('click', () => setSide('left', 'open'));
  document.getElementById('collapse-right').addEventListener('click', () => setSide('right', 'collapsed'));
  document.getElementById('expand-right').addEventListener('click', () => setSide('right', 'open'));
}

// ---------- 右栏 tab 切换 ----------
function initTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      document.getElementById('tab-chat').classList.toggle('hidden', tab.dataset.tab !== 'chat');
      document.getElementById('tab-files').classList.toggle('hidden', tab.dataset.tab !== 'files');
    });
  }
}

// ---------- 选区 chip（示意：跟随 model.selection 显隐） ----------
function initSelectionChip() {
  const chip = document.getElementById('selection-chip');
  model.subscribe('selection', (sel) => {
    chip.classList.toggle('hidden', !sel);
    if (sel) document.getElementById('selection-chip-text').textContent = '选中：' + (sel.label || '若干块');
  });
  chip.querySelector('.chip-close').addEventListener('click', () => model.set('selection', null));
}

// ---------- 健康检查 ----------
async function checkHealth() {
  const dot = document.getElementById('health-dot');
  try {
    const info = await api.health();
    dot.classList.toggle('ok', !!info.ok);
    dot.title = info.ok ? `服务正常 · ${info.time}` : '服务异常';
  } catch {
    dot.classList.remove('ok');
    dot.title = '服务不可达';
  }
}

// ---------- 文档导入与加载 ----------
async function refreshViewer() {
  const doc = model.get('doc');
  const docModel = model.get('docModel');
  if (!doc || !docModel) return;
  const viewer = document.getElementById('viewer');
  const flow = await renderPaged(viewer, docModel, doc.id);
  renderPageList(document.getElementById('pages'), flow, (pageEl) => {
    pageEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  renderOutline(document.getElementById('outline'), docModel, (blockId) => {
    // 大纲点章节：选中整章子树 + 定位
    const ids = chapterBlockIds(docModel, blockId);
    const h = docModel.blocks.find(b => b.id === blockId);
    const title = (h?.runs || []).map(r => r.text).join('').slice(0, 10) || '章节';
    model.set('selection', { blockIds: ids, label: `「${title}」${ids.length} 个块` });
    viewer.querySelector(`[data-block-id="${blockId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// message 为 null 时只重渲染（用于取消编辑等场景），否则写盘 + commit
async function onModelChanged(message) {
  const doc = model.get('doc');
  const docModel = model.get('docModel');
  if (!doc || !docModel) return;
  if (message != null) {
    const res = await api.saveModel(doc.id, docModel, message);
    if (!res.ok) { alert('保存失败: ' + (res.message || res.error)); return; }
  }
  await refreshViewer();
  // 重渲染后 DOM 重建，补一次选区高亮
  const sel = model.get('selection');
  if (sel) model.set('selection', { ...sel });
}

async function loadDoc(docId, name) {
  const res = await api.getModel(docId);
  if (!res.ok) { alert('加载失败: ' + (res.message || res.error)); return; }
  model.set('doc', { id: docId, name: res.model.meta?.title || name });
  model.set('docModel', res.model);
  document.getElementById('doc-name').textContent = res.model.meta?.title || name;
  const viewer = document.getElementById('viewer');
  viewer.classList.remove('placeholder-lg');
  await refreshViewer();
}

function initImport() {
  const btn = document.getElementById('btn-import');
  const input = document.getElementById('file-input');
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    btn.disabled = true;
    btn.textContent = '导入中…';
    try {
      const res = await api.importDoc(file);
      if (!res.ok) { alert('导入失败: ' + (res.message || res.error)); return; }
      await loadDoc(res.id, res.name);
    } catch (err) {
      alert('导入失败: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '导入 docx';
    }
  });
}

applyLayout();
initResizer(document.getElementById('resizer-left'), 'left');
initResizer(document.getElementById('resizer-right'), 'right');
initCollapse();
initTabs();
initSelectionChip();
initImport();
initFormatMenu(() => model.get('docModel'), onModelChanged);
initHistory((revertedModel) => {
  // 回退成功：服务端已落盘并 commit，前端替换模型并重渲染
  clearSelection();
  model.set('docModel', revertedModel);
  refreshViewer();
});
// AI 改动落盘后：从服务端重载模型并重渲染
async function reloadModel() {
  const doc = model.get('doc');
  if (!doc) return;
  const res = await api.getModel(doc.id);
  if (res.ok) {
    model.set('docModel', res.model);
    await refreshViewer();
  }
}

initSelection(isEditMode);
initEditor(onModelChanged);
initChat(reloadModel);
initSettings();
initFilesPanel();
initModelBar();

// 导出 docx：浏览器直接下载
model.subscribe('docModel', (m) => { document.getElementById('btn-export-docx').disabled = !m; });
document.getElementById('btn-export-docx').addEventListener('click', () => {
  const doc = model.get('doc');
  if (doc) location.href = `/api/docs/${doc.id}/export.docx`;
});
model.subscribe('docModel', (m) => { document.getElementById('btn-export-pdf').disabled = !m; });
document.getElementById('btn-export-pdf').addEventListener('click', () => {
  const doc = model.get('doc');
  if (doc) location.href = `/api/docs/${doc.id}/export.pdf`;
});
checkHealth();

// 调试/测试挂钩
window.__ws = { model, api };

// 深链：#doc=<id> 直接打开文档；?pdf=1 为 PDF 打印纯净模式
const pdfMode = new URLSearchParams(location.search).get('pdf') === '1';
if (pdfMode) document.body.classList.add('pdf-mode');
const hashDoc = /^#doc=([a-zA-Z0-9_-]+)$/.exec(location.hash)?.[1];
if (hashDoc) {
  loadDoc(hashDoc, hashDoc).then(() => {
    if (pdfMode) {
      // 分页渲染完成后给 CDP 打印发信号
      setTimeout(() => { document.title = 'PDF_READY'; }, 500);
    }
  });
}
setInterval(checkHealth, 30000);
