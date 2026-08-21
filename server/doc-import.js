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

// Word 双字体：ascii（西文）+ eastAsia（中文）合成 "ascii, eastAsia" 逗号串
function composeFont(rFonts) {
  if (!rFonts) return undefined;
  const ascii = rFonts['@_ascii'], east = rFonts['@_eastAsia'];
  // w:hint="eastAsia"：整个 run（含西文/数字）都用 eastAsia 字体
  if (rFonts['@_hint'] === 'eastAsia' && east) return east;
  return ascii && east && east !== ascii ? `${ascii}, ${east}` : (ascii || east);
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
    const olVal = outline ? Number(outline['@_val']) : null;
    const spacing = asArray(pPr.spacing)[0];
    styles[styleId] = {
      name: textOf(s.name?.['@_val'] ?? s.name) || styleId,
      type: s['@_type'] === 'character' ? 'character' : 'paragraph',
      fontSize: halfPtToPt(asArray(rPr.sz)[0]?.['@_val']),
      bold: rPr.b != null,
      italic: rPr.i != null,
      color: asArray(rPr.color)[0]?.['@_val'],
      font: composeFont(asArray(rPr.rFonts)[0]),
      alignment: asArray(pPr.jc)[0]?.['@_val'],
      outlineLevel: olVal != null && olVal < 9 ? olVal + 1 : undefined, // OOXML val 9 = 无大纲级别
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
  const font = composeFont(asArray(rPr.rFonts)[0])
    // hint=eastAsia 但未显式给字体：整 run 回落到文档默认字体的 eastAsia（Word 语义）
    ?? (asArray(rPr.rFonts)[0]?.['@_hint'] === 'eastAsia' ? ctx.defaultEastAsia : undefined);
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

  const rawRunNodes = [...asArray(p.r), ...asArray(p.hyperlink).flatMap(h => asArray(h.r))];
  // 域状态机：PAGE/NUMPAGES → 占位 run（预览按页替换/导出写真域）；
  // 其他域（HYPERLINK/PAGEREF 等）保留缓存结果文本，域标记本身丢弃
  const fieldStack = [];
  const runNodes = [];
  for (const r of rawRunNodes) {
    const ft = asArray(r.fldChar)[0]?.['@_fldCharType'];
    if (ft === 'begin') { fieldStack.push({ instr: '', result: [], phase: 'instr' }); continue; }
    if (fieldStack.length) {
      const top = fieldStack[fieldStack.length - 1];
      if (ft === 'separate') { top.phase = 'result'; continue; }
      if (r.instrText != null) { if (top.phase === 'instr') top.instr += textOf(r.instrText); continue; }
      if (ft === 'end') {
        fieldStack.pop();
        let nodes;
        if (/\bPAGE\b/.test(top.instr)) nodes = [{ __field: 'page' }];
        else if (/\bNUMPAGES\b/.test(top.instr)) nodes = [{ __field: 'pages' }];
        else nodes = top.result;
        const outer = fieldStack[fieldStack.length - 1];
        if (outer && outer.phase === 'result') outer.result.push(...nodes);
        else runNodes.push(...nodes);
        continue;
      }
      if (top.phase === 'result') top.result.push(r); // 域指令阶段的普通 run 丢弃
      continue;
    }
    runNodes.push(r);
  }

  for (const r of runNodes) {
    if (r.__field) { runs.push({ field: r.__field }); continue; }
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
  if (pPr.pageBreakBefore != null) base.pageBreakBefore = true; // 段前分页（目录页等靠它独占分页）
  // 点线前导符制表位（手写目录条目"标题……页码"）：预览按 dotted leader 渲染
  if (asArray(asArray(pPr.tabs)[0]?.tab).some(t => t['@_leader'] === 'dot')) base.dotLeaderTab = true;
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
      const para = { ...base, type: 'paragraph', runs };
      // 大纲层级：优先段落自带 outlineLvl（Word 大纲级别），否则按数字章节号（1. / 5.2）推断；
      // 只打注解不改块类型（避免导出被套成 Word 默认 Heading 样式）
      const pOl = asArray(pPr.outlineLvl)[0]?.['@_val'];
      if (pOl != null && Number(pOl) < 9) {
        para.outlineLevel = Math.min(Number(pOl) + 1, 4);
      } else {
        // 打印版目录条目（结尾 \t页码）排除，否则目录页会污染大纲
        const txt = runs.map(r => r.text).join('').trim();
        if (txt && !/\t\s*\d{1,4}\s*$/.test(txt)) {
          const mCh = /^(\d{1,2}(?:\.\d{1,2}){0,3})[.、\s]/.exec(txt);
          if (mCh) para.outlineLevel = Math.min(mCh[1].split('.').length, 4);
        }
      }
      blocks.push(para);
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
  // docDefaults 先解析：run 级字体的最终回落基准（hint=eastAsia 时回落其 eastAsia）
  const docDefaultRFonts = asArray(parser.parse(stylesXml || '<styles/>')?.styles?.docDefaults?.rPrDefault?.rPr?.rFonts)[0];
  const defaultFont = composeFont(docDefaultRFonts);
  const defaultEastAsia = docDefaultRFonts?.['@_eastAsia']
    || (defaultFont?.includes(',') ? defaultFont.split(',').pop().trim() : defaultFont);
  const ctx = { styles, rels, numbering, counters: {}, pendingImages: [], defaultEastAsia };

  const bodyXml = /<w:body>([\s\S]*)<\/w:body>/.exec(documentXml)?.[1] ?? '';
  const blocks = [];

  // TOC 复杂域跨段落：begin/instrText/separate 在首段，缓存条目是后续若干段落，end 收尾。
  // 逐片段做深度计数状态机，整段抽出条目（级别/标题/页码），避免缓存条目被当正文解析
  const stripInstr = (s) => s.replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '');
  const textsOf = (s) => [...s.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]);
  const decodeXml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const tocEntryOf = (frag) => {
    const clean = stripInstr(frag);
    const tabIdx = clean.lastIndexOf('<w:tab');
    const title = decodeXml(textsOf(tabIdx === -1 ? clean : clean.slice(0, tabIdx)).join('')).trim();
    const page = tabIdx === -1 ? '' : decodeXml(textsOf(clean.slice(tabIdx)).join('')).trim();
    const pStyle = /<w:pStyle w:val="([^"]+)"/.exec(frag)?.[1];
    const levelMatch = /toc\s*(\d)/i.exec((styles[pStyle]?.name) || pStyle || '');
    // 条目字体取首个文本 run 的 rFonts（缓存条目通常显式带 宋体 等字体）
    const rf = /<w:rFonts([^/]*)\/>/.exec(clean)?.[1] || '';
    const attrs = Object.fromEntries([...rf.matchAll(/w:(\w+)="([^"]*)"/g)].map(m => ['@_' + m[1], m[2]]));
    const font = composeFont(attrs);
    return title ? { level: levelMatch ? Math.min(Number(levelMatch[1]), 4) : 1, text: title, page, ...(font ? { font } : {}) } : null;
  };
  let tocCap = null; // { depth, entries }
  const finishToc = () => {
    if (tocCap?.entries.length) blocks.push({ type: 'toc', ownPage: true, entries: tocCap.entries });
    tocCap = null;
  };

  for (const frag of splitTopLevel(bodyXml)) {
    const begins = (frag.match(/fldCharType="begin"/g) || []).length;
    const ends = (frag.match(/fldCharType="end"/g) || []).length;
    if (tocCap) {
      tocCap.depth += begins - ends;
      if (begins === 0 || !/<w:instrText[^>]*>[^<]*\bTOC\b/.test(frag)) {
        const e = tocEntryOf(frag);
        if (e) tocCap.entries.push(e);
      }
      if (tocCap.depth <= 0) finishToc();
      continue;
    }
    if (begins > 0 && /<w:instrText[^>]*>[^<]*\bTOC\b/.test(frag)) {
      // TOC 域起始段：separate 之后可能紧跟第一条目
      tocCap = { depth: begins - ends, entries: [] };
      const afterSeparate = frag.slice(frag.lastIndexOf('fldCharType="separate"'));
      const e = tocEntryOf(frag);
      if (e && textsOf(stripInstr(afterSeparate)).length) tocCap.entries.push(e);
      if (tocCap.depth <= 0) finishToc();
      continue;
    }
    const parsed = parser.parse(frag);
    if (parsed.p) blocks.push(...parseParagraph(parsed.p, ctx));
    else if (parsed.tbl) blocks.push(...parseTable(parsed.tbl, ctx));
  }
  if (tocCap) finishToc(); // 未闭合容忍

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
      // 内容里已带内联页码域（如"第X页/共Y页"）→ 页码随内容渲染，不再追加独立页码框
      const hasInlinePage = (blocks) => blocks.some(b =>
        (b.runs || []).some(r => r.field) || (b.type === 'table' && hasInlinePage(b.rows.flat().flatMap(c => c.blocks))));
      if (hasPageField && !hasInlinePage(content)) {
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
    // 文档默认字体（docDefaults）：预览/导出缺省字体的基准
    defaultFont,
    blocks,
  };
  await writeFile(join(workspaceDir, 'model.json'), JSON.stringify(model, null, 2));
  await writeFile(join(workspaceDir, '.gitignore'), 'exports/\n');
  return model;
}
