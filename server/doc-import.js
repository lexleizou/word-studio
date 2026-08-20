// docx 导入：OOXML 解包 + 解析 → model.json
// 解包用系统 unzip（零新增重依赖），XML 用 fast-xml-parser。
// body 顶层元素（段落/表格）的顺序通过原始 XML 顶层标签切分保持，
// 元素内部结构再交给 fast-xml-parser 解析。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const run = promisify(execFile);
const TWIPS_PER_MM = 1440 / 25.4;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true, // v1 简化：去掉命名空间前缀（OOXML 内同名冲突概率低）
  textNodeName: '#text',
});

// ---------- unzip 辅助 ----------
async function unzipText(docxPath, entry) {
  try {
    const { stdout } = await run('unzip', ['-p', docxPath, entry], { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
    return Buffer.from(stdout).toString('utf8');
  } catch {
    return null; // 条目不存在
  }
}

async function unzipExtract(docxPath, entry, dest) {
  const { stdout } = await run('unzip', ['-p', docxPath, entry], { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
  await writeFile(dest, Buffer.from(stdout));
}

// ---------- 通用小工具 ----------
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const twipsToMm = (t) => (t == null ? undefined : Math.round((Number(t) / TWIPS_PER_MM) * 10) / 10);
const halfPtToPt = (v) => (v == null ? undefined : Number(v) / 2);

function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return String(node['#text'] ?? '');
}

// ---------- 样式表解析（styles.xml → model.styles） ----------
function parseStyles(xml) {
  const styles = {};
  if (!xml) return styles;
  const root = parser.parse(xml);
  for (const s of asArray(root?.styles?.style)) {
    const styleId = s['@_styleId'];
    if (!styleId) continue;
    const pPr = s.pPr || {};
    const rPr = s.rPr || {};
    const outline = asArray(pPr.outlineLvl)[0];
    const spacing = asArray(pPr.spacing)[0];
    styles[styleId] = {
      name: textOf(s.name?.['@_val'] ?? s.name) || styleId,
      type: s['@_type'] === 'character' ? 'character' : 'paragraph',
      fontSize: halfPtToPt(asArray(rPr.sz)[0]?.['@_val']),
      bold: rPr.b != null,
      italic: rPr.i != null,
      color: asArray(rPr.color)[0]?.['@_val'],
      font: asArray(rPr.rFonts)[0]?.['@_ascii'],
      alignment: asArray(pPr.jc)[0]?.['@_val'],
      outlineLevel: outline ? Number(outline['@_val']) + 1 : undefined,
      spaceBefore: twipsToMm(spacing?.['@_before']),
      spaceAfter: twipsToMm(spacing?.['@_after']),
    };
  }
  return styles;
}

const HEADING_RE = /^(heading|标题)\s*(\d)/i;

function styleHeadingLevel(styleId, styles) {
  const st = styles[styleId];
  if (!st) return 0;
  if (st.outlineLevel) return Math.min(st.outlineLevel, 4);
  const m = HEADING_RE.exec(st.name || styleId);
  return m ? Math.min(Number(m[2]), 4) : 0;
}

// ---------- run 解析 ----------
function parseRun(r, ctx) {
  // 图片
  if (r.drawing || r.pict) {
    const blob = JSON.stringify(r.drawing || r.pict);
    const embed = /"@_embed"\s*:\s*"([^"]+)"/.exec(blob)?.[1];
    if (embed && ctx.rels[embed]) {
      const target = ctx.rels[embed];
      // imgPrefix：页眉/页脚 part 的图片与正文图片重名时防互相覆盖
      const fileName = (ctx.imgPrefix || '') + target.split('/').pop();
      ctx.pendingImages.push({ entry: 'word/' + target.replace(/^\.\.\//, ''), fileName });
      const cx = /"@_cx"\s*:\s*"?(\d+)/.exec(blob)?.[1];
      const widthMm = cx ? Math.round(Number(cx) / 914400 * 25.4) : undefined;
      return { image: { src: 'assets/' + fileName, widthMm } };
    }
  }
  const rPr = r.rPr || {};
  const run = { text: asArray(r.t).map(textOf).join('') + (r.tab != null ? '\t' : '') };
  if (rPr.b != null) run.bold = true;
  if (rPr.i != null) run.italic = true;
  if (rPr.u != null) run.underline = true;
  const color = asArray(rPr.color)[0]?.['@_val'];
  if (color && color !== 'auto') run.color = '#' + color;
  const sz = halfPtToPt(asArray(rPr.sz)[0]?.['@_val']);
  if (sz) run.size = sz;
  const font = asArray(rPr.rFonts)[0]?.['@_ascii'];
  if (font) run.font = font;
  return { run };
}

function parseParagraph(p, ctx) {
  const pPr = p.pPr || {};
  const styleId = asArray(pPr.pStyle)[0]?.['@_val'];
  const runs = [];
  const images = [];
  let hasPageBreak = false;
  let isToc = false;

  const runNodes = [...asArray(p.r), ...asArray(p.hyperlink).flatMap(h => asArray(h.r))];
  for (const r of runNodes) {
    if (r.instrText != null && /TOC/.test(textOf(r.instrText))) isToc = true;
    for (const br of asArray(r.br)) {
      if (br === '' || br?.['@_type'] === 'page') hasPageBreak = true;
    }
    const { run, image } = parseRun(r, ctx);
    if (image) images.push(image);
    else if (run && run.text) runs.push(run);
  }
  if (p.fldSimple != null && /TOC/.test(asArray(p.fldSimple)[0]?.['@_instr'] || '')) isToc = true;

  const base = { styleId: styleId || 'Normal' };
  const spacing = asArray(pPr.spacing)[0];
  if (spacing?.['@_before']) base.spaceBefore = twipsToMm(spacing['@_before']);
  if (spacing?.['@_after']) base.spaceAfter = twipsToMm(spacing['@_after']);
  const jc = asArray(pPr.jc)[0]?.['@_val'];
  if (jc) base.alignment = jc;

  const blocks = [];
  if (isToc) {
    blocks.push({ ...base, type: 'toc', ownPage: true });
  } else {
    const headingLevel = styleId ? styleHeadingLevel(styleId, ctx.styles) : 0;
    const numPr = asArray(pPr.numPr)[0];
    if (headingLevel) {
      blocks.push({ ...base, type: 'heading', level: headingLevel, runs });
    } else if (numPr) {
      const numId = numPr.numId?.['@_val'] ?? '0';
      const ordered = ctx.numbering[numId] !== 'bullet';
      ctx.counters[numId] = (ctx.counters[numId] || 0) + 1;
      blocks.push({ ...base, type: 'list', ordered, level: Number(numPr.ilvl?.['@_val'] || 0), index: ctx.counters[numId], runs });
    } else {
      blocks.push({ ...base, type: 'paragraph', runs });
    }
  }
  for (const img of images) blocks.push({ ...base, type: 'image', ...img });
  if (hasPageBreak) blocks.push({ type: 'pageBreak' });
  return blocks;
}

// ---------- 边框解析（tblBorders / tcBorders）：val + sz(1/8 pt) + color ----------
function parseBorderEdges(node) {
  if (!node) return undefined;
  const out = {};
  for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) {
    const b = asArray(node[side])[0];
    const val = b?.['@_val'];
    if (!val) continue;
    out[side] = {
      val, // single | double | dashed | dotted | none | nil | thick ...
      ...(b['@_sz'] != null ? { sz: Number(b['@_sz']) } : {}),
      ...(b['@_color'] && b['@_color'] !== 'auto' ? { color: '#' + b['@_color'] } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

function parseTable(tbl, ctx) {
  // 列宽：tblGrid 的 gridCol（twips）→ mm；单元格 tcW 兜底/覆盖
  const gridCols = asArray(tbl.tblGrid?.gridCol)
    .map(gc => twipsToMm(gc['@_w']))
    .filter(v => v != null);
  const tblPr = tbl.tblPr || {};
  const borders = parseBorderEdges(tblPr.tblBorders);
  const tblW = asArray(tblPr.tblW)[0];
  const widthPct = tblW?.['@_type'] === 'pct' ? Number(tblW['@_w']) / 50 : undefined;
  const tableWidthMm = tblW && tblW['@_type'] !== 'pct' && tblW['@_type'] !== 'auto' ? twipsToMm(tblW['@_w']) : undefined;
  const rowHeights = [];
  const rows = asArray(tbl.tr).map((tr, ri) => {
    // 行高：trHeight（twips，hRule atLeast/exact）—— 封面签批表等靠它撑版式
    const trH = asArray(tr?.trPr?.trHeight)[0];
    if (trH?.['@_val']) rowHeights[ri] = { heightMm: twipsToMm(trH['@_val']), rule: trH['@_hRule'] === 'exact' ? 'exact' : 'atLeast' };
    return asArray(tr.tc).map((tc, ci) => {
      const tcW = asArray(tc.tcPr?.tcW)[0];
      const tcWVal = tcW?.['@_w'] ?? tcW?.['@_val']; // OOXML tcW 用 w:w 属性
      const widthMm = tcW?.['@_type'] === 'auto' || tcW?.['@_type'] === 'pct' ? undefined : twipsToMm(tcWVal) ?? gridCols[ci];
      const gridSpan = asArray(tc.tcPr?.gridSpan)[0]?.['@_val'];
      const vMergeEl = asArray(tc.tcPr?.vMerge)[0];
      // vMerge：restart = 合并起始；裸 <w:vMerge/> 或 val="continue" = 被合并的占位格
      const vMerge = vMergeEl == null ? undefined : (vMergeEl['@_val'] === 'restart' ? 'restart' : 'continue');
      const vAlign = asArray(tc.tcPr?.vAlign)[0]?.['@_val'];
      const cellBorders = parseBorderEdges(asArray(tc.tcPr?.tcBorders)[0]);
      return {
        blocks: asArray(tc.p).flatMap(p => parseParagraph(p, ctx)),
        ...(widthMm ? { widthMm } : {}),
        ...(gridSpan > 1 ? { colSpan: Number(gridSpan) } : {}),
        ...(vMerge ? { vMerge } : {}),
        ...(vAlign ? { vAlign } : {}),
        ...(cellBorders ? { borders: cellBorders } : {}),
      };
    });
  });
  return [{
    type: 'table',
    ...(gridCols.length ? { gridCols } : {}),
    ...(borders ? { borders } : {}),
    ...(widthPct ? { widthPct } : {}),
    ...(tableWidthMm ? { tableWidthMm } : {}),
    ...(rowHeights.length ? { rowHeights } : {}),
    rows,
  }];
}

// ---------- 页面设置（sectPr → pageSetup） ----------
function parsePageSetup(sectPr) {
  const setup = {
    size: 'A4',
    orientation: 'portrait',
    margins: { top: 25.4, bottom: 25.4, left: 31.8, right: 31.8 },
    header: { enabled: false, content: [], distanceMm: 15 },
    footer: { enabled: false, content: [], distanceMm: 15 },
    pageNumber: { enabled: false, format: 'decimal', position: 'footer-center', startAt: 1 },
  };
  if (!sectPr) return setup;
  const pgSz = asArray(sectPr.pgSz)[0];
  if (pgSz) {
    if (pgSz['@_orient'] === 'landscape') setup.orientation = 'landscape';
    const wMm = twipsToMm(pgSz['@_w']);
    if (Math.abs(wMm - 297) < 2 || Math.abs(wMm - 210) < 2) setup.size = 'A4';
    else if (Math.abs(wMm - 279) < 3 || Math.abs(wMm - 216) < 3) setup.size = 'Letter';
  }
  const pgMar = asArray(sectPr.pgMar)[0];
  if (pgMar) {
    setup.margins = {
      top: twipsToMm(pgMar['@_top']) ?? setup.margins.top,
      bottom: twipsToMm(pgMar['@_bottom']) ?? setup.margins.bottom,
      left: twipsToMm(pgMar['@_left']) ?? setup.margins.left,
      right: twipsToMm(pgMar['@_right']) ?? setup.margins.right,
    };
    if (pgMar['@_header']) setup.header.distanceMm = twipsToMm(pgMar['@_header']);
    if (pgMar['@_footer']) setup.footer.distanceMm = twipsToMm(pgMar['@_footer']);
  }
  const pgNum = asArray(sectPr.pgNumType)[0];
  if (pgNum) {
    setup.pageNumber.enabled = true;
    if (pgNum['@_fmt']) setup.pageNumber.format = pgNum['@_fmt'];
    if (pgNum['@_start']) setup.pageNumber.startAt = Number(pgNum['@_start']);
  }
  return setup;
}

// 页眉/页脚 XML → 结构化内容块（与正文 block 同构：paragraph/table/image）
// 页眉里常见「双线边框表格 + logo + 公司信息」排版，必须保留表格结构而非压平成文本
async function parseHeaderFooterPart(docxPath, partPath, ctx) {
  const xml = await unzipText(docxPath, partPath);
  if (!xml) return { content: [], hasPageField: false };
  const partName = partPath.split('/').pop();
  const relsPath = partPath.replace('word/', 'word/_rels/') + '.rels';
  const relsXml = await unzipText(docxPath, relsPath);
  const partRels = {};
  if (relsXml) {
    for (const r of asArray(parser.parse(relsXml)?.Relationships?.Relationship)) {
      partRels[r['@_Id']] = r['@_Target'];
    }
  }
  // part 级 ctx：图片解析走该 part 自己的 rels，文件名加前缀避免与正文图片冲突
  const partCtx = { ...ctx, rels: partRels, counters: {}, imgPrefix: partName.replace(/\.xml$/, '') + '-' };

  // PAGE 域检测（复杂域 instrText / 简单域 fldSimple）
  const hasPageField = /<w:instrText[^>]*>[^<]*PAGE/.test(xml) || /w:instr="[^"]*PAGE/.test(xml);

  // 顶层 p/tbl 按出现顺序解析（与正文同一套切分逻辑）
  const inner = /<w:(?:hdr|ftr)[^>]*>([\s\S]*)<\/w:(?:hdr|ftr)>/.exec(xml)?.[1] ?? '';
  const content = [];
  for (const frag of splitTopLevel(inner)) {
    const parsed = parser.parse(frag);
    if (parsed.p) content.push(...parseParagraph(parsed.p, partCtx));
    else if (parsed.tbl) content.push(...parseTable(parsed.tbl, partCtx));
  }
  // 清理对页眉无意义的块：分页符、目录占位、空段落（保留含图片的）
  const cleaned = content.filter(b => {
    if (b.type === 'pageBreak' || b.type === 'toc') return false;
    if ((b.type === 'paragraph' || b.type === 'heading' || b.type === 'list') && !(b.runs || []).length) return false;
    return true;
  });
  return { content: cleaned, hasPageField };
}

// 切分 body 顶层 <w:p>/<w:tbl> 片段，保持文档顺序
function splitTopLevel(bodyXml) {
  const frags = [];
  const re = /<w:(p|tbl)[ >]/g;
  let m;
  while ((m = re.exec(bodyXml))) {
    const tag = m[1];
    const openEnd = bodyXml.indexOf('>', m.index);
    if (bodyXml[openEnd - 1] === '/') { frags.push(bodyXml.slice(m.index, openEnd + 1)); continue; }
    const closeTag = `</w:${tag}>`;
    const closeIdx = bodyXml.indexOf(closeTag, openEnd); // body 层 p/tbl 不自嵌套
    if (closeIdx === -1) continue;
    frags.push(bodyXml.slice(m.index, closeIdx + closeTag.length));
    re.lastIndex = closeIdx + closeTag.length;
  }
  return frags;
}

// ---------- 主入口 ----------
export async function importDocx(workspaceDir, docxPath, originalName) {
  await mkdir(join(workspaceDir, 'assets'), { recursive: true });
  await copyFile(docxPath, join(workspaceDir, 'original.docx'));

  const [documentXml, stylesXml, numberingXml, relsXml] = await Promise.all([
    unzipText(docxPath, 'word/document.xml'),
    unzipText(docxPath, 'word/styles.xml'),
    unzipText(docxPath, 'word/numbering.xml'),
    unzipText(docxPath, 'word/_rels/document.xml.rels'),
  ]);
  if (!documentXml) throw new Error('不是有效的 docx（缺 word/document.xml）');

  // 关系表：rId → target
  const rels = {};
  if (relsXml) {
    for (const r of asArray(parser.parse(relsXml)?.Relationships?.Relationship)) {
      rels[r['@_Id']] = r['@_Target'];
    }
  }

  // 编号表：numId → 'bullet' | 'decimal'（v1 简化，只判列表有序与否）
  const numbering = {};
  if (numberingXml) {
    const root = parser.parse(numberingXml)?.numbering;
    const abstract = {};
    for (const a of asArray(root?.abstractNum)) {
      abstract[a['@_abstractNumId']] = asArray(a.lvl)[0]?.numFmt?.['@_val'] || 'bullet';
    }
    for (const n of asArray(root?.num)) {
      numbering[n['@_numId']] = abstract[n.abstractNumId?.['@_val']] || 'bullet';
    }
  }

  const styles = parseStyles(stylesXml);
  const ctx = { styles, rels, numbering, counters: {}, pendingImages: [] };

  const bodyXml = /<w:body>([\s\S]*)<\/w:body>/.exec(documentXml)?.[1] ?? '';
  const blocks = [];
  for (const frag of splitTopLevel(bodyXml)) {
    const parsed = parser.parse(frag);
    if (parsed.p) blocks.push(...parseParagraph(parsed.p, ctx));
    else if (parsed.tbl) blocks.push(...parseTable(parsed.tbl, ctx));
  }

  // 赋稳定块 id（含表格单元格内的嵌套块）
  let n = 0;
  const assignId = (b) => {
    b.id = 'b' + (++n);
    if (b.type === 'table') b.rows.flat().forEach(cell => cell.blocks.forEach(assignId));
  };
  blocks.forEach(assignId);

  // 页面设置（body 级 sectPr 是最后一个）
  const doc = parser.parse(documentXml);
  const body = doc?.document?.body;
  const sectPr = Array.isArray(body?.sectPr) ? body.sectPr.at(-1) : body?.sectPr;
  const pageSetup = parsePageSetup(sectPr);

  // 页眉/页脚：文档可能有多个节（sectPr 可嵌在分节段落的 pPr 里），引用要跨节收集
  const nestedSectPrs = asArray(body?.p).map(p => p.pPr?.sectPr).filter(Boolean);
  const allSectPrs = [...nestedSectPrs, ...asArray(body?.sectPr)];
  if (allSectPrs.length) {
    const pickRef = (kind) => {
      const refs = allSectPrs.flatMap(s => asArray(kind === 'header' ? s.headerReference : s.footerReference));
      return refs.find(r => !r['@_type'] || r['@_type'] === 'default') || refs.find(r => r['@_type'] === 'first') || refs[0];
    };
    for (const kind of ['header', 'footer']) {
      const ref = pickRef(kind);
      if (!ref) continue;
      const target = rels[ref['@_id']];
      if (!target) continue;
      const partPath = 'word/' + target.replace(/^\.\.\//, '');
      const { content, hasPageField } = await parseHeaderFooterPart(docxPath, partPath, ctx);
      pageSetup[kind].enabled = true;
      pageSetup[kind].content = content;
      if (hasPageField) {
        pageSetup.pageNumber.enabled = true;
        pageSetup.pageNumber.position = kind === 'header' ? 'header-center' : 'footer-center';
      }
    }
  }

  // 落地图片
  for (const img of ctx.pendingImages) {
    try { await unzipExtract(docxPath, img.entry, join(workspaceDir, 'assets', img.fileName)); } catch { /* 图片缺失容忍 */ }
  }

  const model = {
    meta: { title: originalName.replace(/\.(docx|doc)$/i, ''), sourceFile: originalName, importedAt: new Date().toISOString() },
    pageSetup,
    styles,
    blocks,
  };
  await writeFile(join(workspaceDir, 'model.json'), JSON.stringify(model, null, 2));
  await writeFile(join(workspaceDir, '.gitignore'), 'exports/\n');
  return model;
}
