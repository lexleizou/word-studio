// 中栏渲染器：model.json → 简单 HTML（阶段 2 先不分页，阶段 3 接 Paged.js）
const MM_TO_PX = 96 / 25.4;

function runToHtml(run, idx) {
  let text = escapeHtml(run.text || '');
  let style = '';
  if (run.color) style += `color:${run.color};`;
  if (run.size) style += `font-size:${run.size}pt;`;
  if (run.font) style += `font-family:${run.font};`;
  if (run.bold) text = `<strong>${text}</strong>`;
  if (run.italic) text = `<em>${text}</em>`;
  if (run.underline) text = `<u>${text}</u>`;
  // data-run-idx：编辑模式按索引把文本写回对应 run
  return `<span data-run-idx="${idx}"${style ? ` style="${style}"` : ''}>${text}</span>`;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function blockStyle(block, model) {
  const st = model.styles?.[block.styleId] || {};
  let style = '';
  const align = block.alignment || st.alignment;
  if (align) style += `text-align:${align === 'both' ? 'justify' : align};`;
  if (st.fontSize) style += `font-size:${st.fontSize}pt;`;
  if (st.font) style += `font-family:${st.font};`;
  const before = block.spaceBefore ?? st.spaceBefore;
  const after = block.spaceAfter ?? st.spaceAfter;
  if (before) style += `margin-top:${before}mm;`;
  if (after) style += `margin-bottom:${after}mm;`;
  const lineHeight = block.lineHeight ?? st.lineHeight;
  if (lineHeight) style += `line-height:${lineHeight};`;
  return style;
}

function blockToHtml(block, model, docId) {
  const inner = (block.runs || []).map((r, i) => runToHtml(r, i)).join('');
  const style = blockStyle(block, model);
  const attr = `data-block-id="${block.id}"${style ? ` style="${style}"` : ''}`;
  switch (block.type) {
    case 'heading':
      return `<h${block.level} ${attr}>${inner}</h${block.level}>`;
    case 'paragraph':
      return inner ? `<p ${attr}>${inner}</p>` : '';
    case 'list': {
      const marker = block.ordered ? `${block.index}. ` : '• ';
      const indent = 1.2 + (block.level || 0) * 1.2;
      return `<p ${attr} class="doc-list" style="padding-left:${indent}em;${style}">${marker}${inner}</p>`;
    }
    case 'table':
      return `<table ${attr}><tbody>${block.rows.map(row =>
        `<tr>${row.map(cell =>
          `<td>${cell.blocks.map(b => blockToHtml(b, model, docId)).join('')}</td>`).join('')}</tr>`
      ).join('')}</tbody></table>`;
    case 'image': {
      const w = block.widthMm ? ` style="max-width:100%;width:${Math.round(block.widthMm * MM_TO_PX)}px"` : ' style="max-width:100%"';
      return `<p ${attr} class="doc-image"><img src="/api/docs/${docId}/assets/${block.src.split('/').pop()}"${w} alt=""></p>`;
    }
    case 'toc':
      return `<div ${attr} class="doc-toc-placeholder">目录<span>（导出 docx 时由 Word 更新域生成）</span></div>`;
    case 'pageBreak':
      return `<hr ${attr} class="doc-page-break">`;
    default:
      return '';
  }
}

export function renderModel(container, model, docId) {
  const html = model.blocks.map(b => blockToHtml(b, model, docId)).join('');
  container.innerHTML = `<article class="doc-content">${html || '<p class="placeholder">（文档为空）</p>'}</article>`;
}

// 左栏大纲：heading 块列表
export function renderOutline(container, model, onJump) {
  const headings = model.blocks.filter(b => b.type === 'heading');
  container.innerHTML = headings.length
    ? headings.map(h => {
        const text = (h.runs || []).map(r => r.text).join('') || '（无标题文字）';
        return `<div class="outline-item" style="padding-left:${8 + (h.level - 1) * 14}px" data-block-id="${h.id}">${escapeHtml(text)}</div>`;
      }).join('')
    : '<div class="placeholder">文档中没有标题</div>';
  container.querySelectorAll('.outline-item').forEach(el => {
    el.addEventListener('click', () => onJump(el.dataset.blockId));
  });
}

// ---------- 分页预览（Paged.js） ----------

// model.pageSetup → @page CSS（纸张/边距/页眉页脚/页码 margin boxes）
export function pageCss(model) {
  const ps = model.pageSetup || {};
  const m = ps.margins || { top: 25.4, bottom: 25.4, left: 31.8, right: 31.8 };
  const size = ps.size === 'Letter' ? 'letter' : 'A4';
  const orient = ps.orientation === 'landscape' ? ' landscape' : '';
  const cssStr = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const blocks = [];
  let marginBoxes = '';
  if (ps.header?.enabled) {
    const text = (ps.header.content || []).map(c => c.text || '').join(' ');
    if (text) marginBoxes += `@top-center { content: ${cssStr(text)}; font-size: 9pt; color: #666; vertical-align: bottom; padding-bottom: 2mm; }`;
  }
  if (ps.pageNumber?.enabled) {
    const pos = ps.pageNumber.position || 'footer-center';
    const box = { 'footer-left': '@bottom-left', 'footer-right': '@bottom-right', 'footer-center': '@bottom-center', 'header-center': '@top-center' }[pos] || '@bottom-center';
    marginBoxes += `${box} { content: counter(page); font-size: 9pt; color: #666; }`;
  } else if (ps.footer?.enabled) {
    const text = (ps.footer.content || []).map(c => c.text || '').join(' ');
    if (text) marginBoxes += `@bottom-center { content: ${cssStr(text)}; font-size: 9pt; color: #666; }`;
  }
  blocks.push(`@page { size: ${size}${orient}; margin: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm; ${marginBoxes} }`);
  // 页码起始值（Paged.js 支持 @page:first counter-reset）
  if (ps.pageNumber?.enabled && ps.pageNumber.startAt && ps.pageNumber.startAt !== 1) {
    blocks.push(`@page:first { counter-reset: page ${ps.pageNumber.startAt}; }`);
  }
  // 目录独占一页（Paged.js 的 break-after 支持不全，用相邻兄弟选择器补一刀）、显式分页符
  blocks.push('.doc-toc-placeholder { break-before: page; break-after: page; }');
  blocks.push('.doc-toc-placeholder + * { break-before: page; }');
  blocks.push('.doc-page-break { border: none; margin: 0; break-after: page; }');
  return blocks.join('\n');
}

// 用 Paged.js 把文档内容分页渲染进 container，返回 flow（含 pages）
export async function renderPaged(container, model, docId) {
  const html = model.blocks.map(b => blockToHtml(b, model, docId)).join('');

  const source = document.createElement('div');
  source.innerHTML = `<article class="doc-content">${html || '<p>（文档为空）</p>'}</article>`;
  container.innerHTML = '';
  const previewer = new Paged.Previewer();
  // 样式表参数用 { url: 文本 } 形式传内联 CSS（@page 规则才会被 polisher 解析）
  const flow = await previewer.preview(source, [{ [location.href + '#pagecss']: pageCss(model) }], container);
  return flow;
}

// 左栏页面列表：页码 + 首行摘要，点击滚动到对应页
export function renderPageList(container, flow, onJump) {
  const pages = flow?.pages || [];
  container.innerHTML = pages.length
    ? pages.map((p, i) => {
        const snippet = (p.element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24) || '（空白页）';
        return `<div class="page-item" data-page-index="${i}"><span class="page-no">P${String(i + 1).padStart(2, '0')}</span><span class="page-snippet">${escapeHtml(snippet)}</span></div>`;
      }).join('')
    : '<div class="placeholder">暂无分页</div>';
  container.querySelectorAll('.page-item').forEach(el => {
    el.addEventListener('click', () => onJump(pages[Number(el.dataset.pageIndex)]?.element));
  });
}
