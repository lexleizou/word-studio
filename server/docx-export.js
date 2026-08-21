// model.json → docx 导出（npm docx 库从模型重新生成 Word 文件）
import { readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ImageRun, Header, Footer,
  PageNumber, NumberFormat, TableOfContents, PageBreak, BorderStyle, VerticalAlign,
} from 'docx';

const mmToTwip = (mm) => Math.round(mm * 1440 / 25.4);
const ptToHalfPt = (pt) => Math.round(pt * 2);
const MM_TO_PX = 96 / 25.4;

// OOXML 边框 val → docx 库 BorderStyle（sz 单位同为 1/8 pt，直通）
const BORDER_STYLE = {
  single: BorderStyle.SINGLE, double: BorderStyle.DOUBLE, dashed: BorderStyle.DASHED,
  dotted: BorderStyle.DOTTED, thick: BorderStyle.THICK, none: BorderStyle.NONE, nil: BorderStyle.NIL,
};
const borderOpt = (b) => ({
  style: BORDER_STYLE[b?.val] || BorderStyle.NONE,
  size: b?.sz ?? 0,
  color: b?.color ? b.color.replace('#', '') : 'auto',
});
const tableBordersOpt = (tb) => tb ? {
  top: borderOpt(tb.top), bottom: borderOpt(tb.bottom), left: borderOpt(tb.left), right: borderOpt(tb.right),
  insideHorizontal: borderOpt(tb.insideH), insideVertical: borderOpt(tb.insideV),
} : undefined;
const cellBordersOpt = (cb) => cb ? {
  top: borderOpt(cb.top), bottom: borderOpt(cb.bottom), left: borderOpt(cb.left), right: borderOpt(cb.right),
} : undefined;
const VALIGN = { center: VerticalAlign.CENTER, bottom: VerticalAlign.BOTTOM, top: VerticalAlign.TOP };

// docx v9 ImageRun 要求显式 type（否则导出文件名带 .undefined）
function imgType(src) {
  const ext = String(src).split('.').pop().toLowerCase();
  return { png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif', webp: 'png' }[ext] || 'png';
}

const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, both: AlignmentType.JUSTIFIED };
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
const NUM_FMT = {
  decimal: NumberFormat.DECIMAL,
  lowerLetter: NumberFormat.LOWER_LETTER,
  upperLetter: NumberFormat.UPPER_LETTER,
  upperRoman: NumberFormat.UPPER_ROMAN,
  lowerRoman: NumberFormat.LOWER_ROMAN,
};

// ---------- 图片尺寸探测（PNG/JPEG/GIF 头部，免依赖） ----------
function imageDimensions(buf) {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) { // PNG
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49) { // GIF
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) { // JPEG：扫 SOF 段
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xFF) break;
        const marker = buf[off + 1];
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        off += 2 + buf.readUInt16BE(off + 2);
      }
    }
  } catch { /* 尺寸探测失败容忍 */ }
  return null;
}

// docx 库 font 参数："ascii, eastAsia" 逗号串 → { ascii, eastAsia } 对象
const docxFont = (f) => {
  if (!f) return undefined;
  const parts = String(f).split(',').map(s => s.trim()).filter(Boolean);
  return parts.length > 1 ? { ascii: parts[0], eastAsia: parts[1] } : parts[0];
};

// 行距 → docx spacing：auto 倍数（line/240）或 exact/atLeast 绝对 twips
function spacingLine(b, st) {
  const lhMm = b.lineHeightMm ?? st.lineHeightMm;
  if (lhMm != null) return { line: mmToTwip(lhMm), lineRule: (b.lineHeightRule ?? st.lineHeightRule) === 'exact' ? 'exact' : 'atLeast' };
  const lh = b.lineHeight ?? st.lineHeight;
  if (lh != null) return { line: Math.round(lh * 240) };
  return {};
}

// ---------- run / paragraph 生成 ----------
function textRun(r) {
  // 内联页码域（第X页/共Y页）→ 真 PAGE/NUMPAGES 域
  if (r.field === 'page' || r.field === 'pages') {
    return new TextRun({
      children: [r.field === 'page' ? PageNumber.CURRENT : PageNumber.TOTAL_PAGES],
      color: r.color ? r.color.replace('#', '') : undefined,
      size: r.size ? ptToHalfPt(r.size) : undefined,
      font: docxFont(r.font),
    });
  }
  return new TextRun({
    text: r.text || '',
    bold: !!r.bold,
    italics: !!r.italic,
    underline: r.underline ? {} : undefined,
    color: r.color ? r.color.replace('#', '') : undefined,
    size: r.size ? ptToHalfPt(r.size) : undefined,
    font: docxFont(r.font),
  });
}

function blockParagraph(block, model) {
  const st = model.styles?.[block.styleId] || {};
  const base = {
    style: model.styles?.[block.styleId] ? block.styleId : undefined,
    alignment: ALIGN[block.alignment || st.alignment],
    ...(block.pageBreakBefore ? { pageBreakBefore: true } : {}),
    spacing: {
      before: (block.spaceBefore ?? st.spaceBefore) != null ? mmToTwip(block.spaceBefore ?? st.spaceBefore) : undefined,
      after: (block.spaceAfter ?? st.spaceAfter) != null ? mmToTwip(block.spaceAfter ?? st.spaceAfter) : undefined,
      ...spacingLine(block, st),
    },
  };
  switch (block.type) {
    case 'heading':
      return new Paragraph({ ...base, heading: HEADINGS[Math.min(block.level, 4) - 1], children: (block.runs || []).map(textRun) });
    case 'paragraph':
      return new Paragraph({ ...base, children: (block.runs || []).map(textRun) });
    case 'list':
      return new Paragraph({
        ...base,
        children: (block.runs || []).map(textRun),
        ...(block.ordered
          ? { numbering: { reference: 'ws-numbering', level: Math.min(block.level || 0, 8) } }
          : { bullet: { level: Math.min(block.level || 0, 8) } }),
      });
    default:
      return null;
  }
}

// ---------- 表格生成（正文与页眉/页脚共用）：列宽/合并/边框/行高/vAlign ----------
// 单元格内容走 blockToElement（图片块也能落在格子里，如页眉 logo）
async function buildTable(block, model, workspaceDir) {
  // 有效列宽：首行无合并且数量对齐时用首行 tcW，否则用 tblGrid
  const firstRow = block.rows[0] || [];
  const firstRowUsable = firstRow.length
    && firstRow.every(c => c.widthMm && !c.colSpan && !c.vMerge)
    && (!block.gridCols?.length || firstRow.length === block.gridCols.length);
  const cols = firstRowUsable ? firstRow.map(c => c.widthMm)
    : (block.gridCols?.length ? block.gridCols : null);
  // vMerge restart 向下数 continue 得 rowspan
  const rowspanOf = (ri, ci) => {
    let n = 1;
    for (let rj = ri + 1; rj < block.rows.length; rj++) {
      if (block.rows[rj]?.[ci]?.vMerge === 'continue') n++;
      else break;
    }
    return n;
  };
  return new Table({
    width: block.widthPct
      ? { size: Math.round(block.widthPct), type: WidthType.PERCENTAGE }
      : { size: 100, type: WidthType.PERCENTAGE },
    ...(cols ? { columnWidths: cols.map(mmToTwip) } : {}),
    borders: tableBordersOpt(block.borders),
    rows: await Promise.all(block.rows.map(async (row, ri) => {
      const rh = block.rowHeights?.[ri];
      return new TableRow({
        ...(rh ? { height: { value: mmToTwip(rh.heightMm), rule: rh.rule === 'exact' ? 'exact' : 'atLeast' } } : {}),
        children: await Promise.all(row
          .map((cell, ci) => ({ cell, ci }))
          .filter(({ cell }) => cell.vMerge !== 'continue')
          .map(async ({ cell, ci }) => {
            const children = (await Promise.all(cell.blocks.map(b => blockToElement(b, model, workspaceDir)))).filter(Boolean);
            return new TableCell({
              ...(cell.widthMm ? { width: { size: mmToTwip(cell.widthMm), type: WidthType.DXA } } : {}),
              ...(cell.colSpan ? { columnSpan: cell.colSpan } : {}),
              ...(cell.vMerge === 'restart' ? { rowSpan: rowspanOf(ri, ci) } : {}),
              ...(cell.vAlign ? { verticalAlign: VALIGN[cell.vAlign] } : {}),
              borders: cellBordersOpt(cell.borders),
              children: children.length ? children : [new Paragraph({ children: [] })],
            });
          })),
      });
    })),
  });
}

// ---------- 图片段落生成（正文与页眉/页脚共用） ----------
async function imageParagraph(block, workspaceDir) {
  const src = block.src || block.image;
  const file = join(workspaceDir, src.startsWith('assets/') ? src : join('assets', String(src).split('/').pop()));
  const buf = await readFile(file).catch(() => null);
  if (!buf) return new Paragraph({ children: [new TextRun({ text: '[图片缺失]', color: '999999' })] });
  const dims = imageDimensions(buf) || { width: 400, height: 300 };
  let wPx = block.widthMm ? block.widthMm * MM_TO_PX : dims.width;
  const hPx = wPx * (dims.height / dims.width);
  return new Paragraph({
    alignment: ALIGN[block.align || block.alignment] || AlignmentType.CENTER,
    children: [new ImageRun({ type: imgType(src), data: buf, transformation: { width: Math.round(wPx), height: Math.round(hPx) } })],
  });
}

async function blockToElement(block, model, workspaceDir) {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
    case 'list':
      return blockParagraph(block, model);
    case 'table':
      return buildTable(block, model, workspaceDir);
    case 'image':
      return imageParagraph(block, workspaceDir);
    case 'toc':
      return new TableOfContents('目录', { hyperlink: true, headingStyleRange: '1-3' });
    case 'pageBreak':
      return new Paragraph({ children: [new PageBreak()] });
    default:
      return null;
  }
}

// ---------- 主入口 ----------
export async function exportDocx(workspaceDir, model) {
  const ps = model.pageSetup || {};
  const m = ps.margins || { top: 25.4, bottom: 25.4, left: 31.8, right: 31.8 };
  const isLetter = ps.size === 'Letter';
  const landscape = ps.orientation === 'landscape';
  let wMm = isLetter ? 215.9 : 210, hMm = isLetter ? 279.4 : 297;
  if (landscape) [wMm, hMm] = [hMm, wMm];

  // 集中样式表
  const paragraphStyles = Object.entries(model.styles || {})
    .filter(([, st]) => st.type !== 'character')
    .map(([id, st]) => ({
      id,
      name: st.name || id,
      run: {
        bold: st.bold || undefined,
        italics: st.italic || undefined,
        color: st.color ? st.color.replace('#', '') : undefined,
        size: st.fontSize ? ptToHalfPt(st.fontSize) : undefined,
        font: docxFont(st.font),
      },
      paragraph: {
        alignment: ALIGN[st.alignment],
        spacing: {
          before: st.spaceBefore != null ? mmToTwip(st.spaceBefore) : undefined,
          after: st.spaceAfter != null ? mmToTwip(st.spaceAfter) : undefined,
          ...spacingLine({}, st),
        },
        outlineLevel: st.outlineLevel ? Math.min(st.outlineLevel - 1, 3) : undefined,
      },
    }));

  // 页眉 / 页脚 / 页码：结构化块（段落带 run 格式 / 表格带边框 / 图片）与旧 {text,align} 格式都支持
  const hfElement = async (c) => {
    if (c.type === 'table') return buildTable(c, model, workspaceDir);
    if (c.type === 'paragraph' || c.type === 'heading' || c.type === 'list') return blockParagraph(c, model);
    if (c.type === 'image' || c.image) return imageParagraph(c, workspaceDir);
    return new Paragraph({
      alignment: ALIGN[c.align] || AlignmentType.LEFT,
      children: [new TextRun({ text: c.text || '', size: 18, color: '666666' })],
    });
  };
  const headerChildren = [];
  if (ps.header?.enabled) for (const c of ps.header.content || []) headerChildren.push(await hfElement(c));
  const footerChildren = [];
  if (ps.footer?.enabled) for (const c of ps.footer.content || []) footerChildren.push(await hfElement(c));
  if (ps.pageNumber?.enabled) {
    const pos = ps.pageNumber.position || 'footer-center';
    const align = pos.endsWith('left') ? AlignmentType.LEFT : pos.endsWith('right') ? AlignmentType.RIGHT : AlignmentType.CENTER;
    const pnPara = new Paragraph({ alignment: align, children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '666666' })] });
    if (pos.startsWith('header')) headerChildren.push(pnPara);
    else footerChildren.push(pnPara);
  }
  const headers = headerChildren.length ? { default: new Header({ children: headerChildren }) } : undefined;
  const footers = footerChildren.length ? { default: new Footer({ children: footerChildren }) } : undefined;

  const children = [];
  for (const block of model.blocks) {
    // 目录独占一页：前后各补一个分页符
    if (block.type === 'toc' && block.ownPage !== false) {
      if (children.length) children.push(new Paragraph({ children: [new PageBreak()] }));
      children.push(new TableOfContents('目录', { hyperlink: true, headingStyleRange: '1-3' }));
      children.push(new Paragraph({ children: [new PageBreak()] }));
      continue;
    }
    const el = await blockToElement(block, model, workspaceDir);
    if (el) children.push(el);
  }

  const doc = new Document({
    creator: 'word-studio',
    title: model.meta?.title || '',
    styles: {
      paragraphStyles,
      ...(model.defaultFont ? { default: { document: { run: { font: docxFont(model.defaultFont) } } } } : {}),
    },
    numbering: {
      config: [{
        reference: 'ws-numbering',
        levels: Array.from({ length: 9 }, (_, i) => ({
          level: i, format: NumberFormat.DECIMAL, text: `%${i + 1}.`, alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: mmToTwip(7 + i * 7), hanging: mmToTwip(3.5) } } },
        })),
      }],
    },
    sections: [{
      properties: {
        page: {
          size: { width: mmToTwip(wMm), height: mmToTwip(hMm) },
          margin: { top: mmToTwip(m.top), bottom: mmToTwip(m.bottom), left: mmToTwip(m.left), right: mmToTwip(m.right) },
          pageNumbers: ps.pageNumber?.enabled ? {
            start: ps.pageNumber.startAt ?? 1,
            formatType: NUM_FMT[ps.pageNumber.format] || NumberFormat.DECIMAL,
          } : undefined,
        },
      },
      headers,
      footers,
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const exportsDir = join(workspaceDir, 'exports');
  await mkdir(exportsDir, { recursive: true });
  const outPath = join(exportsDir, `${(model.meta?.title || 'document').replace(/[\\/:*?"<>|]/g, '_')}.docx`);
  await import('node:fs/promises').then(fs => fs.writeFile(outPath, buffer));
  return { buffer, outPath, fileName: basename(outPath) };
}
