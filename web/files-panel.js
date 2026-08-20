// 右栏文件 tab：主文档 / 引用文件 / 导出产物清单
import * as model from './model.js';

const KIND_LABEL = { main: '主文档', ref: '引用', export: '导出' };

async function refresh() {
  const doc = model.get('doc');
  const box = document.getElementById('tab-files');
  if (!doc) { box.innerHTML = '<div class="placeholder">打开文档后显示文件清单</div>'; return; }
  const res = await fetch(`/api/docs/${doc.id}/files`);
  const data = await res.json();
  if (!data.ok) { box.innerHTML = '<div class="placeholder">读取失败</div>'; return; }
  box.innerHTML = data.files.map(f => `
    <div class="file-item">
      <span class="file-kind">${KIND_LABEL[f.kind] || f.kind}</span>
      <span class="file-name">${f.name}</span>
    </div>`).join('') || '<div class="placeholder">暂无文件</div>';
}

export function initFilesPanel() {
  document.querySelector('.tab[data-tab="files"]').addEventListener('click', refresh);
  model.subscribe('docModel', refresh);
}
