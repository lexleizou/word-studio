// 选区格式操作（移植自 v1 format-menu.js）：run 拆分 / 块级应用
import { flattenBlocks } from '../store.js';

export function targetBlocks(docModel, sel) {
  if (!docModel || !sel) return [];
  const flat = flattenBlocks(docModel);
  if (sel.blockIds) return flat.filter(b => sel.blockIds.includes(b.id));
  if (sel.blockId) return flat.filter(b => b.id === sel.blockId);
  return [];
}

export function applyInlineToBlock(block, props) {
  block.runs = (block.runs || []).map(r => ({ ...r, ...props }));
}

// 块内 [start, end) 区间应用，边界处拆分 run
export function applyInlineToRange(block, start, end, props) {
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

export function applyInline(sel, blocks, props) {
  for (const b of blocks) {
    if (sel.blockId && sel.startOffset != null && b.id === sel.blockId) {
      applyInlineToRange(b, sel.startOffset, sel.endOffset, props);
    } else {
      applyInlineToBlock(b, props);
    }
  }
}

// 选中范围内是否「全部已有」某属性（决定 B/I/U 是加还是去）
export function allHaveProp(sel, blocks, prop) {
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
  return any;
}
