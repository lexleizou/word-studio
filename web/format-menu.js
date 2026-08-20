// 格式菜单栏：页面设置 + 样式管理（改动写回模型 → 服务端落盘 + git commit → 预览刷新）
// 选区联动（局部格式）在阶段 6 接入，这里先做全局：页面设置 + 样式表编辑
import * as model from './model.js';

// ---------- 简易模态框 ----------
export function openModal(title, bodyHtml) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header"><span>${title}</span><button class="icon-btn" data-close>×</button></div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-footer">
        <button class="btn" data-close>取消</button>
        <button class="btn primary" data-save>保存</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  for (const btn of overlay.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => overlay.remove());
  }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  return { overlay, onSave: (fn) => overlay.querySelector('[data-save]').addEventListener('click', () => fn(overlay)) };
}

const val = (overlay, name) => overlay.querySelector(`[name="${name}"]`)?.value;
const checked = (overlay, name) => !!overlay.querySelector(`[name="${name}"]`)?.checked;
const num = (overlay, name, fallback) => { const v = parseFloat(val(overlay, name)); return Number.isFinite(v) ? v : fallback; };

// ---------- 页面设置面板 ----------
function pageSetupModal(ps, onSave) {
  const { overlay, onSave: reg } = openModal('页面设置', `
    <div class="form-grid">
      <label>纸张</label>
      <select name="size">
        <option value="A4" ${ps.size === 'A4' ? 'selected' : ''}>A4</option>
        <option value="Letter" ${ps.size === 'Letter' ? 'selected' : ''}>Letter</option>
      </select>
      <label>方向</label>
      <select name="orientation">
        <option value="portrait" ${ps.orientation !== 'landscape' ? 'selected' : ''}>纵向</option>
        <option value="landscape" ${ps.orientation === 'landscape' ? 'selected' : ''}>横向</option>
      </select>
      <label>边距 (mm)</label>
      <div class="margins-row">
        上 <input name="marginTop" type="number" step="0.1" value="${ps.margins.top}">
        下 <input name="marginBottom" type="number" step="0.1" value="${ps.margins.bottom}">
        左 <input name="marginLeft" type="number" step="0.1" value="${ps.margins.left}">
        右 <input name="marginRight" type="number" step="0.1" value="${ps.margins.right}">
      </div>
      <label>页眉</label>
      <div><input type="checkbox" name="headerEnabled" ${ps.header?.enabled ? 'checked' : ''}> 启用
        <input name="headerText" placeholder="页眉文字" value="${(ps.header?.content || []).map(c => c.text || '').join(' ')}"></div>
      <label>页脚</label>
      <div><input type="checkbox" name="footerEnabled" ${ps.footer?.enabled ? 'checked' : ''}> 启用
        <input name="footerText" placeholder="页脚文字" value="${(ps.footer?.content || []).map(c => c.text || '').join(' ')}"></div>
      <label>页码</label>
      <div>
        <input type="checkbox" name="pnEnabled" ${ps.pageNumber?.enabled ? 'checked' : ''}> 启用
        <select name="pnPosition">
          <option value="footer-center" ${ps.pageNumber?.position === 'footer-center' ? 'selected' : ''}>页脚居中</option>
          <option value="footer-left" ${ps.pageNumber?.position === 'footer-left' ? 'selected' : ''}>页脚居左</option>
          <option value="footer-right" ${ps.pageNumber?.position === 'footer-right' ? 'selected' : ''}>页脚居右</option>
          <option value="header-center" ${ps.pageNumber?.position === 'header-center' ? 'selected' : ''}>页眉居中</option>
        </select>
        起始 <input name="pnStart" type="number" min="0" style="width:56px" value="${ps.pageNumber?.startAt ?? 1}">
      </div>
    </div>`);
  reg((ov) => {
    onSave({
      ...ps,
      size: val(ov, 'size'),
      orientation: val(ov, 'orientation'),
      margins: {
        top: num(ov, 'marginTop', ps.margins.top),
        bottom: num(ov, 'marginBottom', ps.margins.bottom),
        left: num(ov, 'marginLeft', ps.margins.left),
        right: num(ov, 'marginRight', ps.margins.right),
      },
      header: { ...ps.header, enabled: checked(ov, 'headerEnabled'), content: val(ov, 'headerText') ? [{ text: val(ov, 'headerText') }] : [] },
      footer: { ...ps.footer, enabled: checked(ov, 'footerEnabled'), content: val(ov, 'footerText') ? [{ text: val(ov, 'footerText') }] : [] },
      pageNumber: { ...ps.pageNumber, enabled: checked(ov, 'pnEnabled'), position: val(ov, 'pnPosition'), startAt: num(ov, 'pnStart', 1) },
    });
    ov.remove();
  });
  return overlay;
}

// ---------- 样式编辑面板 ----------
function styleModal(styleId, st, onSave) {
  const { onSave: reg } = openModal(`样式：${st.name || styleId}`, `
    <div class="form-grid">
      <label>字号 (pt)</label><input name="fontSize" type="number" step="0.5" value="${st.fontSize ?? ''}">
      <label>字体</label><input name="font" value="${st.font ?? ''}">
      <label>加粗 / 斜体</label>
      <div><input type="checkbox" name="bold" ${st.bold ? 'checked' : ''}> 粗体
        <input type="checkbox" name="italic" ${st.italic ? 'checked' : ''}> 斜体</div>
      <label>颜色</label><input name="color" placeholder="#333333" value="${st.color?.startsWith('#') ? st.color : st.color ? '#' + st.color : ''}">
      <label>对齐</label>
      <select name="alignment">
        <option value="" ${!st.alignment ? 'selected' : ''}>默认</option>
        <option value="left" ${st.alignment === 'left' ? 'selected' : ''}>居左</option>
        <option value="center" ${st.alignment === 'center' ? 'selected' : ''}>居中</option>
        <option value="right" ${st.alignment === 'right' ? 'selected' : ''}>居右</option>
        <option value="both" ${st.alignment === 'both' ? 'selected' : ''}>两端对齐</option>
      </select>
      <label>段前/段后 (mm)</label>
      <div class="margins-row">
        <input name="spaceBefore" type="number" step="0.5" value="${st.spaceBefore ?? ''}">
        <input name="spaceAfter" type="number" step="0.5" value="${st.spaceAfter ?? ''}">
      </div>
    </div>`);
  reg((ov) => {
    const next = { ...st };
    next.fontSize = num(ov, 'fontSize', undefined);
    next.font = val(ov, 'font') || undefined;
    next.bold = checked(ov, 'bold');
    next.italic = checked(ov, 'italic');
    next.color = val(ov, 'color') || undefined;
    next.alignment = val(ov, 'alignment') || undefined;
    next.spaceBefore = num(ov, 'spaceBefore', undefined);
    next.spaceAfter = num(ov, 'spaceAfter', undefined);
    onSave(next);
    ov.remove();
  });
}

// ---------- 选区格式操作 ----------
function targetBlocks(docModel, sel) {
  if (!docModel || !sel) return [];
  const flat = model.flattenBlocks(docModel);
  if (sel.blockIds) return flat.filter(b => sel.blockIds.includes(b.id));
  if (sel.blockId) return flat.filter(b => b.id === sel.blockId);
  return [];
}

// run 级属性应用：整块
function applyInlineToBlock(block, props) {
  block.runs = (block.runs || []).map(r => ({ ...r, ...props }));
}

// run 级属性应用：块内 [start, end) 区间，边界处拆分 run
function applyInlineToRange(block, start, end, props) {
  const runs = block.runs || [];
  const out = [];
  let pos = 0;
  for (const r of runs) {
    const rs = pos, re = pos + (r.text || '').length;
    pos = re;
    const os = Math.max(rs, start), oe = Math.min(re, end);
    if (os >= oe) { out.push(r); continue; }
    if (os > rs) out.push({ ...r, text: r.text.slice(0, os - rs) });
    out.push({ ...r, ...props, text: r.text.slice(os - rs, oe - rs) });
    if (oe < re) out.push({ ...r, text: r.text.slice(oe - rs) });
  }
  block.runs = out;
}

function applyInline(sel, blocks, props) {
  for (const b of blocks) {
    if (sel.blockId && sel.startOffset != null && b.id === sel.blockId) {
      applyInlineToRange(b, sel.startOffset, sel.endOffset, props);
    } else {
      applyInlineToBlock(b, props);
    }
  }
}

// 判断选中范围内是否「全部已有」某属性（决定 B/I/U 是加还是去）
function allHaveProp(sel, blocks, prop) {
  let any = false;
  for (const b of blocks) {
    let pos = 0;
    for (const r of b.runs || []) {
      const rs = pos, re = pos + (r.text || '').length;
      pos = re;
      if (sel.blockId === b.id && sel.startOffset != null && (Math.max(rs, sel.startOffset) >= Math.min(re, sel.endOffset))) continue;
      if (!r.text) continue;
      any = true;
      if (!r[prop]) return false;
    }
  }
  return any; // 全空视为「全部已有」→ 再次点击取消
}

// ---------- 初始化 ----------
// getModel() 返回当前 model；onModelChanged(message) 负责写回 + 重渲染
export function initFormatMenu(getModel, onModelChanged) {
  const btnPageSetup = document.getElementById('btn-page-setup');
  const styleSelect = document.getElementById('style-select');

  btnPageSetup.addEventListener('click', () => {
    const m = getModel();
    if (!m) return;
    pageSetupModal(m.pageSetup, (next) => {
      m.pageSetup = next;
      onModelChanged('format: 页面设置');
    });
  });

  // 文档加载后刷新样式下拉
  model.subscribe('docModel', (m) => {
    btnPageSetup.disabled = !m;
    styleSelect.disabled = !m;
    styleSelect.innerHTML = '<option value="">样式…</option>' + (m
      ? Object.entries(m.styles)
          .filter(([, st]) => st.type !== 'character')
          .map(([id, st]) => `<option value="${id}">${st.name || id}</option>`).join('')
      : '');
  });

  styleSelect.addEventListener('change', () => {
    const m = getModel();
    const id = styleSelect.value;
    styleSelect.value = '';
    if (!m || !id) return;
    styleModal(id, m.styles[id] || {}, (next) => {
      m.styles[id] = next;
      onModelChanged(`format: 样式 ${next.name || id}`);
    });
  });

  // ----- 选区联动：B/I/U、字体、字号、对齐、行距 -----
  const selBtns = ['fmt-bold', 'fmt-italic', 'fmt-underline', 'fmt-align-left', 'fmt-align-center']
    .map(id => document.getElementById(id));
  const selSelects = ['fmt-font', 'fmt-size', 'fmt-lineheight'].map(id => document.getElementById(id));
  model.subscribe('selection', (sel) => {
    const on = !!sel && !!getModel();
    selBtns.forEach(b => b.disabled = !on);
    selSelects.forEach(s => s.disabled = !on);
  });

  const withSelection = (fn) => () => {
    const m = getModel();
    const sel = model.get('selection');
    const blocks = targetBlocks(m, sel);
    if (!m || !blocks.length) return;
    fn(m, sel, blocks);
  };

  document.getElementById('fmt-bold').addEventListener('click', withSelection((m, sel, blocks) => {
    applyInline(sel, blocks, { bold: !allHaveProp(sel, blocks, 'bold') });
    onModelChanged('format: 粗体');
  }));
  document.getElementById('fmt-italic').addEventListener('click', withSelection((m, sel, blocks) => {
    applyInline(sel, blocks, { italic: !allHaveProp(sel, blocks, 'italic') });
    onModelChanged('format: 斜体');
  }));
  document.getElementById('fmt-underline').addEventListener('click', withSelection((m, sel, blocks) => {
    applyInline(sel, blocks, { underline: !allHaveProp(sel, blocks, 'underline') });
    onModelChanged('format: 下划线');
  }));
  document.getElementById('fmt-font').addEventListener('change', withSelection((m, sel, blocks) => {
    const v = document.getElementById('fmt-font').value;
    document.getElementById('fmt-font').value = '';
    if (!v) return;
    applyInline(sel, blocks, { font: v });
    onModelChanged(`format: 字体 ${v}`);
  }));
  document.getElementById('fmt-size').addEventListener('change', withSelection((m, sel, blocks) => {
    const v = document.getElementById('fmt-size').value;
    document.getElementById('fmt-size').value = '';
    if (!v) return;
    applyInline(sel, blocks, { size: parseFloat(v) });
    onModelChanged(`format: 字号 ${v}pt`);
  }));
  document.getElementById('fmt-align-left').addEventListener('click', withSelection((m, sel, blocks) => {
    blocks.forEach(b => b.alignment = 'left');
    onModelChanged('format: 居左');
  }));
  document.getElementById('fmt-align-center').addEventListener('click', withSelection((m, sel, blocks) => {
    blocks.forEach(b => b.alignment = 'center');
    onModelChanged('format: 居中');
  }));
  document.getElementById('fmt-lineheight').addEventListener('change', withSelection((m, sel, blocks) => {
    const v = document.getElementById('fmt-lineheight').value;
    document.getElementById('fmt-lineheight').value = '';
    blocks.forEach(b => { v ? b.lineHeight = parseFloat(v) : delete b.lineHeight; });
    onModelChanged(v ? `format: 行距 ${v}` : 'format: 行距默认');
  }));
}
