// 数据层：前端状态 + 订阅通知（参考项目同款分层）
const state = {
  doc: null,          // 当前文档 { id, name }
  selection: null,    // { blockIds: [] } 或 { blockId, startOffset, endOffset }
};

const listeners = new Map(); // key -> Set<fn>

export function get(key) {
  return state[key];
}

export function set(key, value) {
  state[key] = value;
  for (const fn of listeners.get(key) || []) fn(value);
}

export function subscribe(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key).delete(fn);
}

// 深度优先拍平块列表（含表格单元格内的嵌套块），选区范围/格式操作都用这个顺序
export function flattenBlocks(docModel) {
  const out = [];
  const walk = (blocks) => {
    for (const b of blocks || []) {
      out.push(b);
      if (b.type === 'table') b.rows.flat().forEach(cell => walk(cell.blocks));
    }
  };
  walk(docModel?.blocks);
  return out;
}
