// 全局样式：taste 校准（去饱和深蓝 / zinc 中性 / Mono 数字）+ Paged.js 页面外观
export const cssText = `
  html, body, #root { height: 100%; margin: 0; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif; overflow: hidden; }

  .mono { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace; }

  /* ---------- 栏宽 resizer ---------- */
  .col-resizer { flex: none; width: 6px; cursor: col-resize; background: transparent; transition: background 0.15s; }
  .col-resizer:hover, .col-resizer.active { background: #e3e9f2; }

  /* ---------- 三栏高度链（antd Sider 内容撑满） ---------- */
  .ant-layout-sider .ant-layout-sider-children { height: 100%; display: flex; flex-direction: column; }
  .ant-layout-sider .ant-layout-sider-children > .ant-tabs { flex: none; }
  .chat-column { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .chat-stream { flex: 1; min-height: 0; overflow: auto; }
  /* 流式打字光标 */
  .ws-cursor { display: inline-block; color: #34568b; animation: ws-blink 0.9s steps(1) infinite; }
  @keyframes ws-blink { 50% { opacity: 0; } }

  /* ---------- Paged.js 页面 ---------- */
  .viewer-scroll { background: #f4f4f5; }
  .pagedjs_pages { padding: 20px 0 32px; }
  .pagedjs_page {
    background: #fff;
    margin: 0 auto 16px;
    box-shadow: 0 1px 4px rgba(24,24,27,0.08), 0 8px 24px rgba(24,24,27,0.06);
  }
  .doc-content { line-height: 1.5; }
  .doc-content h1, .doc-content h2, .doc-content h3, .doc-content h4 { line-height: 1.4; margin: 0.8em 0 0.4em; }
  .doc-content h1 { font-size: 20pt; }
  .doc-content h2 { font-size: 16pt; }
  .doc-content h3 { font-size: 14pt; }
  .doc-content h4 { font-size: 12pt; }
  .doc-content p { margin: 0.3em 0; min-height: 1em; }
  .doc-content table { border-collapse: collapse; width: 100%; margin: 0; }
  /* 单元格默认样式对齐 Word：tblCellMar 左右 108tw≈1.9mm、上下 0；行距单倍偏紧 */
  .doc-content td { border: 1px solid #e4e4e7; padding: 0 1.9mm; line-height: 1.35; vertical-align: top; }
  /* 显式边框表格（tblBorders/tcBorders 导入）：默认边框让位给逐格内联样式 */
  .doc-content table.tbl-x td { border: none; }
  .doc-hf table.tbl-x td { border: none; }
  .doc-list { margin: 0.2em 0; }
  .doc-image { text-align: center; margin: 0.6em 0; }

  /* ---------- 页眉/页脚注入（margin box 内 DOM） ---------- */
  /* 页眉从盒顶（页面顶边）起排 + margin-top=header 距离；页脚从盒底（页面底边）起排 + margin-bottom=footer 距离 */
  .pagedjs_margin-top-center .pagedjs_margin-content { display: flex; align-items: flex-start; width: 100%; }
  .pagedjs_margin-bottom-center .pagedjs_margin-content { display: flex; align-items: flex-end; width: 100%; }
  .doc-hf { width: 100%; font-size: 9pt; line-height: 1.3; color: #18181b; }
  .doc-hf p { margin: 0; min-height: 0; }
  .doc-hf table { border-collapse: collapse; margin: 0; }
  .doc-hf td { padding: 0 1.9mm; vertical-align: middle; line-height: 1.3; }
  .doc-hf img { display: block; }
  .doc-toc-placeholder {
    border: 1px dashed #d4d4d8; border-radius: 6px;
    padding: 24px; margin: 12px 0;
    text-align: center; color: #a1a1aa; font-size: 16px; font-weight: 600;
  }
  .doc-toc-placeholder span { display: block; font-size: 12px; font-weight: 400; margin-top: 6px; }

  /* ---------- 打印版目录（TOC 域缓存条目 + 手写目录点线条目） ---------- */
  .doc-toc { padding: 1mm 0; }
  .toc-e { display: flex; align-items: baseline; margin: 0.35em 0; }
  .toc-l2 { padding-left: 1.6em; }
  .toc-l3 { padding-left: 3.2em; }
  .toc-l4 { padding-left: 4.8em; }
  .toc-dots { flex: 1; margin: 0 0.4em; border-bottom: 1px dotted #71717a; transform: translateY(-0.15em); }
  .toc-p { font-variant-numeric: tabular-nums; }

  /* ---------- 选区高亮 ---------- */
  .doc-content [data-block-id].selected {
    background: rgba(52,86,139,0.08);
    outline: 1px solid rgba(52,86,139,0.35);
    border-radius: 2px;
  }
  .doc-content .frag-hidden { display: none; }

  /* ---------- 编辑模式 ---------- */
  .edit-mode-on .doc-content [data-block-id]:hover {
    outline: 1px dashed #34568b;
    border-radius: 2px;
    cursor: text;
  }
  .doc-content [data-block-id].editing {
    outline: 2px solid #34568b;
    border-radius: 2px;
    background: #fff;
  }

  /* ---------- PDF 打印纯净模式（?pdf=1，供 CDP printToPDF） ---------- */
  html:has(body.pdf-mode), body.pdf-mode { overflow: visible !important; height: auto !important; }
  body.pdf-mode .app-chrome { display: none !important; }
  /* 打印链路所有滚动/裁剪容器都要放开，否则内容被裁成一两页 */
  body.pdf-mode .ant-layout,
  body.pdf-mode .ant-layout-content,
  body.pdf-mode .viewer-scroll { overflow: visible !important; height: auto !important; display: block !important; }
  body.pdf-mode .pagedjs_pages { padding: 0; }
  body.pdf-mode .pagedjs_page:last-child { break-after: auto; }
  body.pdf-mode .pagedjs_page { margin: 0 !important; box-shadow: none !important; break-after: page; }
  @media print {
    body.pdf-mode { background: #fff; }
    body.pdf-mode .pagedjs_page { break-after: page; }
  }
`;
