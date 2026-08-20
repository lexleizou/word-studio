// 历史面板：提交列表 + 回退（回退是新 commit，不改写历史）
import * as api from './api.js';
import * as model from './model.js';
import { openModal } from './format-menu.js';

function fmtDate(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function openHistory(onReverted) {
  const doc = model.get('doc');
  if (!doc) return;
  const res = await api.getHistory(doc.id);
  if (!res.ok) { alert('读取历史失败'); return; }
  const rows = res.history.map(h => `
    <div class="history-item">
      <span class="history-msg">${escapeHtml(h.message)}</span>
      <span class="history-meta">${fmtDate(h.date)} · ${h.hash.slice(0, 7)}</span>
      <button class="btn" data-hash="${h.hash}">回退到此</button>
    </div>`).join('');
  const { overlay } = openModal('版本历史', rows || '<div class="placeholder">暂无提交</div>');
  overlay.querySelector('.modal-footer')?.remove(); // 历史面板不需要保存按钮

  overlay.querySelectorAll('[data-hash]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const hash = btn.dataset.hash;
      if (!confirm(`回退到 ${hash.slice(0, 7)}？\n当前状态不会被覆盖：回退会作为新的提交保留在历史中。`)) return;
      btn.disabled = true;
      const r = await api.checkoutDoc(doc.id, hash);
      if (!r.ok) { alert('回退失败: ' + (r.message || r.error)); btn.disabled = false; return; }
      overlay.remove();
      onReverted(r.model);
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function initHistory(onReverted) {
  const btn = document.getElementById('btn-history');
  model.subscribe('docModel', (m) => { btn.disabled = !m; });
  btn.addEventListener('click', () => openHistory(onReverted));
}
