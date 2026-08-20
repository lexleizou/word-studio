// Paged.js 渲染引擎：model.json → @page CSS + 分页 DOM（移植自 v1 viewer.js，无 React 依赖）
const MM_TO_PX = 96 / 25.4;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

// ---------- 表格边框：OOXML val/sz(1/8pt) → CSS ----------
function borderCss(b) {
  if (!b || b.val === 'none' || b.val === 'nil') return 'none';
  const style = { single: 'solid', double: 'double', dashed: 'dashed', dotted: 'dotted', thick: 'solid' }[b.val] || 'solid';
  const px = Math.max((b.sz ?? 4) / 6, 1); // sz/8 pt × 96/72 = sz/6 px
  // 浏览器 double 至少需要 ~3px 才能画出两条线
  const w = b.val === 'double' ? Math.max(px, 3) : px;
  return `${Math.round(w * 10) / 10}px ${style} ${b.color || '#000'}`;
}

// 单元格四边：tcBorders 覆盖；否则外边用表格外框、内边用 insideH/insideV（Word 语义）
function cellBorderCss(block, cell, ri, ci) {
  const tb = block.borders;
  if (!tb && !cell.borders) return '';
  const lastRow = ri === block.rows.length - 1;
  const lastCol = ci === block.rows[ri].length - 1;
  const pick = (side, outer) =>
    cell.borders?.[side] ?? (tb ? (outer ? tb[side] : (side === 'top' || side === 'bottom' ? tb.insideH : tb.insideV)) : undefined);
  const t = pick('top', ri === 0), b = pick('bottom', lastRow), l = pick('left', ci === 0), r = pick('right', lastCol);
  return `border-top:${borderCss(t)};border-bottom:${borderCss(b)};border-left:${borderCss(l)};border-right:${borderCss(r)};`;
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
      return inner ? `<p ${attr}>${inner}</p>` : `<p ${attr}><br></p>`;
    case 'list': {
      const marker = block.ordered ? `${block.index}. ` : '• ';
      const indent = 1.2 + (block.level || 0) * 1.2;
      return `<p ${attr} class="doc-list" style="padding-left:${indent}em;${style}">${marker}${inner}</p>`;
    }
    case 'table': {
      // 保留原文档列宽：table-layout:fixed + colgroup，避免自动布局把格子压窄换行
      // 有效列宽：首行无合并且数量对齐时用首行 tcW（tblGrid 可能是未更新的均分残留），否则用 tblGrid
      const firstRow = block.rows[0] || [];
      const firstRowUsable = firstRow.length
        && firstRow.every(c => c.widthMm && !c.colSpan && !c.vMerge)
        && (!block.gridCols?.length || firstRow.length === block.gridCols.length);
      const cols = firstRowUsable ? firstRow.map(c => c.widthMm)
        : (block.gridCols?.length ? block.gridCols : null);
      const tableWidth = block.widthPct ? `${block.widthPct}%` : '100%';
      const tableStyle = (cols ? 'table-layout:fixed;' : '') + `width:${tableWidth};`;
      const colgroup = cols
        ? `<colgroup>${cols.map(w => `<col style="width:${w}mm">`).join('')}</colgroup>`
        : '';
      const hasBorders = !!block.borders || block.rows.some(row => row.some(c => c.borders));
      // 合并单元格：gridSpan → colspan；vMerge restart 向下数 continue 得 rowspan，continue 格不输出
      const rowspanOf = (ri, ci) => {
        let n = 1;
        for (let rj = ri + 1; rj < block.rows.length; rj++) {
          if (block.rows[rj]?.[ci]?.vMerge === 'continue') n++;
          else break;
        }
        return n;
      };
      const rowsHtml = block.rows.map((row, ri) => {
        const rh = block.rowHeights?.[ri];
        const trStyle = rh ? ` style="height:${rh.heightMm}mm"` : '';
        return `<tr${trStyle}>${row.map((cell, ci) => {
          if (cell.vMerge === 'continue') return '';
          const styles = [];
          if (cell.widthMm) styles.push(`width:${cell.widthMm}mm`);
          if (cell.vAlign) styles.push(`vertical-align:${cell.vAlign}`);
          if (hasBorders) styles.push(cellBorderCss(block, cell, ri, ci));
          const attrs = [];
          if (styles.length) attrs.push(`style="${styles.join(';')}"`);
          if (cell.colSpan) attrs.push(`colspan="${cell.colSpan}"`);
          if (cell.vMerge === 'restart') attrs.push(`rowspan="${rowspanOf(ri, ci)}"`);
          return `<td${attrs.length ? ' ' + attrs.join(' ') : ''}>${cell.blocks.map(b => blockToHtml(b, model, docId)).join('')}</td>`;
        }).join('')}</tr>`;
      }).join('');
      return `<table ${attr}${hasBorders ? ' class="tbl-x"' : ''} style="${tableStyle}">${colgroup}<tbody>${rowsHtml}</tbody></table>`;
    }
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

// model.pageSetup → @page CSS（纸张/边距/页眉页脚/页码 margin boxes）
const NUM_CSS = { decimal: 'decimal', lowerRoman: 'lower-roman', upperRoman: 'upper-roman', lowerLetter: 'lower-latin', upperLetter: 'upper-latin' };

export function pageCss(model, docId) {
  const ps = model.pageSetup || {};
  const m = ps.margins || { top: 25.4, bottom: 25.4, left: 31.8, right: 31.8 };
  const size = ps.size === 'Letter' ? 'letter' : 'A4';
  const orient = ps.orientation === 'landscape' ? ' landscape' : '';
  const cssStr = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const boxStyle = 'font-size: 9pt; color: #666;';
  const blocks = [];
  let marginBoxes = '';

  // 页眉/页脚内容：旧格式（{text,align}/{image}）按对齐落到 margin box 的 CSS content；
  // 结构化块（{type:paragraph/table/image}）由 renderPaged 渲染成 DOM 注入，排版保真
  const pnPos = ps.pageNumber?.enabled ? (ps.pageNumber.position || 'footer-center') : null;
  const emit = (region, content) => {
    const byAlign = { left: [], center: [], right: [] };
    for (const c of content || []) {
      if (c.type || c.image) continue; // 结构化块与图片走 DOM 注入
      (byAlign[c.align] || byAlign.left).push(c.text);
    }
    for (const [align, texts] of Object.entries(byAlign)) {
      if (!texts.length) continue;
      const box = `@${region}-${align}`;
      if (region === 'bottom' && pnPos === `footer-${align}`) continue; // 页码占用的格子让位
      if (region === 'top' && pnPos === `header-${align}`) continue;
      marginBoxes += `${box} { content: ${cssStr(texts.join('    '))}; ${boxStyle} ${region === 'top' ? 'vertical-align: bottom; padding-bottom: 2mm;' : 'vertical-align: top; padding-top: 2mm;'} }`;
    }
  };
  if (ps.header?.enabled) emit('top', ps.header.content);
  if (ps.footer?.enabled) emit('bottom', ps.footer.content);

  // 页码（支持格式：阿拉伯/罗马/字母）
  if (pnPos) {
    const fmt = NUM_CSS[ps.pageNumber.format] || 'decimal';
    const box = { 'footer-left': '@bottom-left', 'footer-right': '@bottom-right', 'footer-center': '@bottom-center', 'header-center': '@top-center' }[pnPos] || '@bottom-center';
    marginBoxes += `${box} { content: counter(page, ${fmt}); ${boxStyle} }`;
  }
  blocks.push(`@page { size: ${size}${orient}; margin: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm; ${marginBoxes} }`);
  if (ps.pageNumber?.enabled && ps.pageNumber.startAt && ps.pageNumber.startAt !== 1) {
    blocks.push(`@page:first { counter-reset: page ${ps.pageNumber.startAt}; }`);
  }
  // 目录独占一页（Paged.js 的 break-after 支持不全，用相邻兄弟选择器补一刀）、显式分页符
  blocks.push('.doc-toc-placeholder { break-before: page; break-after: page; }');
  blocks.push('.doc-toc-placeholder + * { break-before: page; }');
  blocks.push('.doc-page-break { border: none; margin: 0; break-after: page; }');
  return blocks.join('\n');
}

// 页眉/页脚内容 → HTML（注入每页 margin box）。结构化块复用正文渲染，但去掉 data-block-id
//（页眉页脚内容不在 model.blocks 里，不参与点选/编辑）
function hfHtml(content, model, docId) {
  const parts = [];
  for (const c of content || []) {
    if (c.type) {
      parts.push(blockToHtml(c, model, docId).replace(/ data-block-id="[^"]*"/g, ''));
    } else if (c.image) {
      const file = String(c.image).split('/').pop();
      const w = c.widthMm ? `width:${c.widthMm}mm;` : 'max-width:40mm;';
      parts.push(`<p style="text-align:${c.align || 'center'};margin:0"><img src="/api/docs/${docId}/assets/${file}" style="${w}" alt=""></p>`);
    }
    // 纯文本旧格式仍走 pageCss 的 content: 路径，这里不重复
  }
  return parts.join('');
}

// 用 Paged.js 分页渲染进 container，返回 flow（含 pages）
export async function renderPaged(container, model, docId) {
  const html = model.blocks.map(b => blockToHtml(b, model, docId)).join('');
  const source = document.createElement('div');
  source.innerHTML = `<article class="doc-content">${html || '<p>（文档为空）</p>'}</article>`;
  container.innerHTML = '';
  const previewer = new window.Paged.Previewer();
  // 样式表参数用 { url: 文本 } 形式传内联 CSS（@page 规则才会被 polisher 解析）
  const flow = await previewer.preview(source, [{ [location.href + '#pagecss']: pageCss(model, docId) }], container);

  // 页眉/页脚注入：结构化块（表格+图片+段落）渲染成 DOM 放进每页 margin box
  for (const [pos, cfg] of [['top', model.pageSetup?.header], ['bottom', model.pageSetup?.footer]]) {
    if (!cfg?.enabled || !(cfg.content || []).length) continue;
    const inner = hfHtml(cfg.content, model, docId);
    if (!inner) continue;
    for (const page of flow.pages || []) {
      const box = page.element.querySelector(`.pagedjs_margin-${pos}-center`);
      const content = box?.querySelector('.pagedjs_margin-content');
      if (content) {
        content.innerHTML = `<div class="doc-hf doc-hf-${pos}">${inner}</div>`;
        box.classList.add('hasContent');
      }
    }
  }
  return flow;
}
