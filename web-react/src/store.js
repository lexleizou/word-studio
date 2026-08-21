// 应用状态：单一 store（useSyncExternalStore 接入 React）
import { useSyncExternalStore } from 'react';

const state = {
  doc: null,          // { id, name }
  docModel: null,     // model.json
  selection: null,    // { blockIds:[], label } | { blockId, startOffset, endOffset, label }
  rendering: false,   // 分页渲染中（骨架屏）
  error: null,        // 全局错误（内联展示）
  chatBusy: false,
  density: localStorage.getItem('ws.density') || 'standard', // comfortable | standard | compact
  leftW: Number(localStorage.getItem('ws.leftW')) || 248,
  rightW: Number(localStorage.getItem('ws.rightW')) || 360,
  settingsOpen: false,
  historyOpen: false,
  editMode: false,
};

const listeners = new Set();

export const store = {
  get: (key) => state[key],
  getState: () => state,
  set(patch) {
    Object.assign(state, patch);
    listeners.forEach(fn => fn());
  },
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useStore(key) {
  return useSyncExternalStore(store.subscribe, () => store.get(key));
}

// 深度优先拍平块（含表格单元格嵌套块）
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

// 大纲条目：显式 heading 块，或导入时按数字章节号推断出 outlineLevel 的段落
const blockLevel = (b) => (b.type === 'heading' ? b.level : b.outlineLevel);
export function outlineBlocks(docModel) {
  return (docModel?.blocks || [])
    .filter(b => blockLevel(b) != null)
    .map(b => ({ id: b.id, level: blockLevel(b), title: (b.runs || []).map(r => r.text).join('') }));
}

// 章节子树：标题块 + 直到同级或更高级标题前的所有块
export function chapterBlockIds(docModel, headingId) {
  const blocks = docModel.blocks;
  const idx = blocks.findIndex(b => b.id === headingId);
  if (idx === -1 || blockLevel(blocks[idx]) == null) return [headingId];
  const level = blockLevel(blocks[idx]);
  const ids = [];
  for (let i = idx; i < blocks.length; i++) {
    if (i > idx && blockLevel(blocks[i]) != null && blockLevel(blocks[i]) <= level) break;
    ids.push(blocks[i].id);
  }
  return ids;
}
