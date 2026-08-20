# Word Studio —— 独立 Web 版 Word 工作台（设计稿 v2）

> 2026-08-20 v2 改版。v1 的「LibreOffice→PDF 真分页 + OOXML 段落级补丁」方案废弃，改为 LaTeX 式管线：**结构化文档模型为单一事实源，HTML 做实时渲染预览，编辑只动内容与集中样式，最终从模型重新生成 docx/PDF**。
> 动因：在 docx 上直接打 OOXML 补丁保真维护成本过高；HTML 中间层把复杂度收敛到「导入」「导出」两个一次性边界。docx 是必须交付物，PDF 可选。

## 需求确认

- 纯网页应用：本地能跑，也能部署到服务器给别人用
- 支持 .doc/.docx 导入（.doc 仍由 LibreOffice 先转 .docx）
- 导入时解析 docx 内容与格式 → 结构化文档模型（JSON），Studio 内用 HTML 渲染
- **内容与格式分离编辑**：正文区只改内容；格式（段落样式/字符样式/页面设置）由专门的格式菜单栏统一展示和修改
- **分页预览**：预览区按纸张分页展示（CSS Paged Media），页眉、页脚、页码可见且可管理；目录必须独占一页
- **Git 式版本管理**：每次修改（手动或 AI）都提交 git，可追溯、可回退
- AI 通道：默认自定义 OpenAI 兼容 endpoint（默认填本机 LiteLLM 127.0.0.1:4000），同时支持 GitHub Copilot OAuth 登录
- 导出：修改完成后从模型重新生成 .docx（必须）；可直接导 PDF（经预览同一套分页 CSS）

## 核心管线（LaTeX 式）

```
docx ──导入解析──▶ 文档模型 model.json ──渲染──▶ HTML 分页预览（Paged.js）
（OOXML 解析）        ▲    │   ▲                    （CSS Paged Media）
                      │    │   │
        手动编辑 ──────┘    │   └────── 格式菜单（样式表 + 页面设置）
        AI 工具 ────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
        导出 docx                 导出 PDF
   （docx 库从模型重新生成）   （headless 浏览器打印预览页）
```

- **文档模型是单一事实源**：git 存 `model.json` + 原始 docx 备份；HTML 只是模型的渲染视图，不做 contenteditable DOM 反向同步
- 手动编辑与 AI 工具都操作模型（节点带稳定 id），改动后重新渲染预览

## 文档模型（model.json）

```jsonc
{
  "meta": { "title": "...", "sourceFile": "原始文件名" },
  "pageSetup": {
    "size": "A4", "orientation": "portrait",
    "margins": { "top": 25.4, "bottom": 25.4, "left": 31.8, "right": 31.8 },  // mm
    "header": { "enabled": true,  "content": [ /* 简化块 */ ], "distanceMm": 15 },
    "footer": { "enabled": true,  "content": [ /* 简化块 */ ], "distanceMm": 15 },
    "pageNumber": { "enabled": true, "format": "decimal", "position": "footer-center", "startAt": 1 }
  },
  "styles": {
    "Heading1": { "fontSize": 16, "bold": true, "alignment": "left", "outlineLevel": 1, "spaceBefore": 12, "spaceAfter": 6 },
    "Normal":   { "fontSize": 12, "lineHeight": 1.5 }
  },
  "blocks": [
    { "id": "b1", "type": "heading", "styleId": "Heading1", "runs": [{ "text": "...", "bold": false }] },
    { "id": "b2", "type": "paragraph", "styleId": "Normal", "runs": [ ... ] },
    { "id": "b3", "type": "toc", "ownPage": true },                       // 目录块：独占一页
    { "id": "b4", "type": "table", "rows": [[{ "blocks": [ ... ] }]] },
    { "id": "b5", "type": "image", "src": "assets/img1.png", "widthMm": 120 },
    { "id": "b6", "type": "pageBreak" }
  ]
}
```

- 节点类型 v1：`heading / paragraph / toc / table / image / list / pageBreak`，不支持的 OOXML 元素（域、文本框、SmartArt、脚注等）导入时跳过并在 UI 标注「不支持」
- run 级内联格式只保留：bold / italic / underline / font / size / color / highlight
- 格式集中：`styles` 表 + `pageSetup`，块只存 `styleId` 引用 —— 与 docx styles.xml 的集中式管理天然对齐，导出映射顺

## 三栏布局（web/）

```
┌─────────────┬───────────────────────────┬────────────────┐
│ 左：大纲+页面  │ 中：HTML 分页预览 + 格式菜单 │ 右：AI 对话      │
│ 标题树导航    │ Paged.js 分页渲染          │ 流式对话+工具时间轴│
│ 页面缩略图    │ 「编辑」→ 块级编辑模式      │ 改动需预览确认    │
└─────────────┴───────────────────────────┴────────────────┘
```

- 布局沿用参考项目手法：CSS Grid 5 轨道 + CSS 变量宽度 + 6px 手写 resizer（pointermove 改变量、clamp、localStorage 持久化）、`data-*` 属性控制折叠态
- **左栏**：大纲树（标题层级导航，点击定位）+ Paged.js 分页后的页面缩略图列表（页码为预览分页结果，非 Word 精确页码，UI 标注）
- **中栏**：
  - 顶部**格式菜单栏**：页面设置（纸张/方向/边距/页眉/页脚/页码格式与位置）、样式管理（选中块的样式、样式表编辑）；改动写入模型 `pageSetup`/`styles`，预览即时刷新
  - 预览区：Paged.js 按 `@page` 规则分页渲染，页眉页脚页码由 CSS margin boxes 呈现；目录页经命名页规则独占一页
  - 「编辑」切换块级编辑模式：点选块就地编辑文本（仅内容，格式走菜单栏），保存 → 写模型 → 重新渲染 → git commit
- **右栏**：AI 对话 + 两个 tab，沿用 v1：
  - **对话 tab**：流式对话 + 工具调用时间轴；写工具一律 diff 预览（改前/改后对照）确认后才落盘；`@` 唤起文件选择
  - **文件 tab**：主文档、@ 引用文件、AI 读取/生成/修改过的文件清单
- **@ 引用文件 / Skill 技能 / MCP**：机制与 v1 完全一致（注入上下文、`import_file`、SKILL.md 目录式技能、stdio + streamable-http 双通道 MCP，`mcp__<服务>__<工具>` 命名空间）

## 选区机制（格式调整与 AI 局部操作的共同入口）

格式菜单的局部调整和 AI 的章节润色/补充都建立在同一套选区上：

- **选区粒度**：
  - **块选**：预览中点击选中块，Shift 连选连续块；左栏大纲树点章节标题 = 选中该章节子树的全部块（章节级操作的主路径）
  - **文本选区**：块内拖选一段文字（run 级字符格式调整用）
- **选区表示**：`{ blockIds: [] }` 或 `{ blockId, startOffset, endOffset }`，选区状态放前端 model 层；预览区高亮选中块，选中章节时显示章节范围标签
- **格式菜单与选区联动**：有块选区时，菜单栏的段落格式操作（改样式、对齐、缩进、行距）作用于选中块；有文本选区时，字符格式（粗斜体/字体/字号/颜色）作用于选中 run。无选区时操作作用于光标所在块
- **AI 与选区联动**：存在选区时，右栏输入框上方自动挂「选区 chip」（显示选中的章节/块范围，可移除）；发送时服务端把选中块内容注入上下文，并约束本轮 AI 写工具的 `scope` 为选中块 id 集合——AI 的润色/补充只落在选区内，diff 预览也只显示选区内的改动

## Git 版本控制设计

- 导入/新建文档即 `git init`，工作区 = `data/workspaces/<docId>/`，git 追踪 `model.json`、`assets/`、原始 docx 备份；导出产物 gitignore
- 提交时机：手动保存、AI 改动确认后，各产生一个 commit（`manual: 编辑标题` / `ai: 统一标题格式` / `format: 修改页边距`）
- API：`GET /api/docs/:id/history`、`POST /api/docs/:id/checkout`（回退是新 commit，不改写历史）
- diff 天然可读：模型是 JSON，git diff 直接反映内容与格式变化

## AI 设计

- Provider 配置、GitHub Copilot OAuth（设备码）、工具循环在服务端、system prompt 拼装顺序：均沿用 v1
- 工具集 v2（操作模型，比 v1 的 OOXML 版简单且可靠）：
  - 文档：`read_outline`、`read_block(id)`、`read_range(a, b)`、`patch_blocks([{id, newText}])`、`apply_style([{id, styleId | inlineProps}])`、`insert_block(afterId, block)`、`delete_blocks([ids])`、`search_replace(find, replace, scope)` —— 写工具均接受 `scope`（块 id 集合，来自当前选区）限定作用范围
  - 格式：`update_style(styleId, props)`、`update_page_setup(props)`（页眉/页脚/页码/边距）
  - 版本：`git_commit(message)`、`git_history()`
  - 引用：`import_file(fileId, position)`
  - 技能：`use_skill(name)`
  - MCP：`mcp__<服务>__<工具>` 动态并入
- 写工具管线不变：提案 → diff 预览 → 用户确认 → 执行 + commit

## 导入（docx → 模型）

- 服务端解 OOXML：`word/document.xml` + `styles.xml` + `numbering.xml`，段落/run/表格/图片 → 模型块；样式表 → 模型 `styles`；`sectPr` → `pageSetup`（含页眉页脚引用、页码设置）；分页符、`TOC` 域 → `pageBreak` / `toc` 块
- body 顶层段落/表格的顺序靠原始 XML 顶层标签切分保持，元素内部结构交给 fast-xml-parser
- 不支持的元素跳过并记录，UI 标注
- 依赖：`fast-xml-parser`（XML 解析）+ 系统 `unzip`（解包）；`.doc` 仍走 LibreOffice 预转（LibreOffice 从硬依赖降为仅 .doc 需要）

## 导出

- **docx（必须）**：npm `docx` 库从模型重新生成
  - `styles` → StyleDefinitions；块 → Paragraph/Table/Image；run 内联格式逐 run 映射
  - `pageSetup` → sectPr：纸张/边距、Header/Footer（含页码 `PAGE` 域）、页码格式与起始
  - `toc` 块 → 真正的 Word TOC 域（标 `dirty`，Word 打开时提示更新域以生成条目与页码——目录页码依赖 Word 排版引擎，服务端不模拟）；`ownPage` → 目录前后分页符
- **PDF（可选）**：headless Chromium（Playwright）打印预览页 HTML —— 与预览同一套 Paged Media CSS，所见即所得
- 导出后自动下载 + 记入 git 之外的产物目录；文件 tab 可见

## 分页预览实现

- CSS Paged Media：纸张/边距 → `@page { size; margin }`；页眉/页脚/页码 → margin boxes（`@top-center`、`@bottom-center { content: counter(page) }` 等）
- 浏览器内用 **Paged.js** polyfill（vendor 进 `web/vendor/`，无构建）把连续 HTML 切分成页并渲染 margin boxes
- 目录独占一页：`toc` 块用命名页 `page: toc` + 前后 `break-before/after: page`
- 预览页码为近似分页（渲染引擎与 Word 不同），精确页码以导出的 docx 在 Word 中分页为准 —— UI 明示

## 目录结构

```
word-studio/
├── package.json          # type:module；依赖：fast-xml-parser、docx、playwright（可选）；scripts: start/dev/check
├── server/
│   ├── index.js          # http 服务：静态 + /api 路由 + SSE
│   ├── doc-import.js     # docx(OOXML) → model.json
│   ├── docx-export.js    # model.json → docx（npm docx 库）
│   ├── pdf-export.js     # 预览 HTML → PDF（headless 打印）
│   ├── git-store.js      # workspace git 操作封装
│   ├── llm.js            # provider 抽象：openai-compat + copilot
│   ├── copilot-auth.js   # 设备码 OAuth + token 交换
│   ├── tools.js          # AI 工具注册表 + tool-use 循环 + SSE 事件
│   ├── skills.js         # 技能扫描/启停/导入
│   ├── mcp-manager.js    # MCP client：stdio / streamable-http
│   ├── refs.js           # @ 引用文件：上传/提取文本/会话文件清单
│   └── config-store.js   # node:sqlite 存 provider 配置/会话/skills 启用态
├── web/
│   ├── index.html        # 三栏骨架 + 格式菜单栏
│   ├── app.js            # 主控制器
│   ├── api.js / model.js # 网络层 / 数据层
│   ├── chat.js           # 右栏对话 tab + 工具时间轴 + 确认卡 + @ 弹层
│   ├── files-panel.js    # 右栏文件 tab
│   ├── outline.js        # 左栏大纲树 + 页面缩略图
│   ├── viewer.js         # 中栏 Paged.js 分页预览 + 块级编辑模式
│   ├── format-menu.js    # 格式菜单栏：页面设置 + 样式管理
│   ├── styles.css        # CSS Grid + 变量 + 折叠态
│   └── vendor/pagedjs/   # Paged.js polyfill
└── data/                 # 运行时生成：workspaces/、studio.db、mcp.json、skills/（gitignore）
```

## 实施步骤

1. **脚手架**：package.json + server/index.js（静态 + /api/health）+ web/ 三栏空壳（grid/resizer/折叠可用）
2. **模型与导入**：定义 model.json schema → doc-import.js（OOXML 解析）→ 导入 docx 落地 workspace + git init → 简单 HTML 渲染（先不分页）
3. **分页预览**：接入 Paged.js + Paged Media CSS（@page、页眉页脚页码 margin boxes、toc 命名页）→ 左栏大纲树 + 页面缩略图
4. **格式菜单栏**：页面设置面板 + 样式管理面板 → 写模型 → 预览即时刷新
5. **Git 版本**：git-store.js + 历史面板（沿用 v1 设计）
6. **选区与手动编辑**：选区机制（块点选/Shift 连选/大纲选章节/块内文本选区 + 高亮）→ 块级编辑模式 → 格式菜单与选区联动 → 写模型 → 重渲染 → commit
7. **导出 docx**：docx-export.js（含 styles/sectPr/页眉页脚页码域/TOC 域）→ 真实 docx 导出并在 Word/WPS 验证
8. **AI 链路**：provider 配置 + openai-compat 打通 → 工具注册表（模型版工具集，含 scope 限定）+ SSE → 对话 UI + 选区 chip + diff 确认卡
9. **@ 引用与文件面板 / Skills / MCP / Copilot OAuth**：沿用 v1 步骤 6–9
10. **导出 PDF**：headless 打印预览页
11. **收尾**：README、`npm run check`、真实 docx 走通「导入→手动改→格式菜单改→AI 改→@引用→导出 docx 验证→git 回退」全流程

## 风险与说明

- **往返保真**：docx → 模型 → docx 是有损往返。v1 支持范围：标题/段落/表格/图片/列表/分页符/目录/页眉页脚页码 + 基础样式；域、文本框、SmartArt、脚注尾注、复杂表格（嵌套/跨页表头）不支持，导入时标注。适合报告/公文/标书类文档
- **目录页码**：TOC 以 Word 域导出，打开文档时需更新域（Word 会提示）；服务端不模拟 Word 排版引擎
- **预览分页是近似**：Paged.js 分页与 Word 实际分页可能有差，页码以导出 docx 为准；UI 明示，不做「与 Word 页码一致」承诺
- **LibreOffice 降级为可选**：仅 .doc 导入需要；v1 的 PDF 硬依赖消除
- **Copilot OAuth**：非官方复用方案，GitHub 政策变动可能失效，UI 标注
- v1 不做多人实时协同（git 保证版本一致，不是 OT/CRDT）
