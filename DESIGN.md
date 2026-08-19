# Word Studio —— 独立 Web 版 Word 工作台（设计稿 v1）

> 2026-08-19 审定。参考 [shawn-ppt-studio](https://github.com/shiyuren1985-shawn/shawn-ppt-studio) 的前端思路（原生 JS 无构建、CSS Grid 三栏、手写 resizer），融合灵犀AI 的工具化 AI 修改经验，服务端加 Git 版本控制。

## 需求确认

- 纯网页应用：本地能跑，也能部署到服务器给别人用
- 支持 .doc/.docx（.doc 由 LibreOffice 先转 .docx）
- 左栏：真实页面（LibreOffice→PDF 真分页，页码与 Word 一致）
- 中栏：实时展示文档内容；**手动编辑 + AI 编辑两种方式都支持**
- **Git 式版本管理**：每次修改（手动或 AI）都提交 git，保证可追溯、可回退、多人/多端一致
- AI 通道：默认自定义 OpenAI 兼容 endpoint（默认填本机 LiteLLM 127.0.0.1:4000），同时支持 GitHub Copilot OAuth 登录

## 架构

```
浏览器（web/，原生 ES Modules，无构建，无框架）
   │  fetch / SSE
Node 22+ 服务（server/，裸 node:http 零框架，node:sqlite 存配置）
   ├── 文档管线：docx →（LibreOffice headless）→ PDF（真分页）
   ├── 文档修改：OOXML (document.xml) 段落级补丁 → 重新转 PDF → git commit
   ├── Git：每个文档一个 workspace git 仓库（data/workspaces/<id>/）
   └── LLM 代理：OpenAI 兼容（默认 LiteLLM）/ GitHub Copilot OAuth（设备码登录）
```

## 三栏布局（web/）

```
┌─────────────┬───────────────────────┬────────────────┐
│ 左：页面列表  │ 中：文档视图             │ 右：AI 对话      │
│ PDF 页缩略图  │ pdf.js 渲染当前页（精确）│ 流式对话+工具时间轴│
│ P01 + 首行摘要│ 「编辑本页」→ 段落编辑模式 │ 改动需预览确认    │
└─────────────┴───────────────────────┴────────────────┘
```

- 布局照抄参考项目：CSS Grid 5 轨道 + CSS 变量宽度 + 6px 手写 resizer（pointermove 改变量、clamp、localStorage 持久化）、`data-*` 属性控制折叠态
- 左栏：PDF 每页小 canvas 缩略图 + 页码 + 首行摘要（pdf.js textContent 取首行）；点击切中栏页
- 中栏：pdf.js 渲染当前页（只读精确视图）；「编辑本页」切换到段落编辑模式——服务端用 OOXML 解析出该页段落列表（带段落 id），段落文本可编辑，保存时服务端把改动补丁回 docx → 重新转 PDF → 自动 git commit → 刷新视图
- 右栏：AI 对话 + 两个附加面板。顶部 tab 切换「对话 / 文件」：
  - **对话 tab**：流式对话 + 工具调用时间轴（灵犀 timeline 简化版）；**所有写工具的改动先出 diff 预览（改前/改后段落对照），用户确认后才落盘**（灵犀「预览确认」思路）；输入框支持 `@` 唤起文件选择
  - **文件 tab**：当前会话/项目涉及的文件清单——主文档、@ 引用的参考文件、AI 读取/生成/修改过的文件（从工具调用记录 + git log 汇总），每项可点击预览或重新引用
- **@ 引用文件**：输入框打 `@` 弹出文件选择器（工作区内文件 + 本地上传）；被 @ 的文件变成输入区 chip。两种用法：①**参考附件**——发送时服务端提取文件内容注入上下文（docx/pdf/txt/md 提取文本，图片走多模态）；②**导入**——AI 可用 `import_file` 工具把参考文件内容写进当前文档（如整章并入）
- **Skill 技能**：目录式技能（`skills/<name>/SKILL.md`，frontmatter 含 name/description，Sally/灵犀同款约定），设置面板里启停 + 导入 .md；启用的技能列出 name+description 进 system prompt，AI 经 `use_skill` 工具按需取全文
- **MCP**：服务端 MCP Client（stdio 子进程 + streamable-http 两种），配置文件 `data/mcp.json`（Sally 同款格式）+ 设置面板可视化管理（增删/启停/测试连接/查看工具清单）；外部工具以 `mcp__<服务>__<工具>` 命名空间并入 AI 工具表

## Git 版本控制设计

- 上传/新建文档即 `git init`，工作区 = `data/workspaces/<docId>/`（含 `document.docx`，PDF 等产物 gitignore）
- 提交时机：手动段落保存、AI 改动确认后，各产生一个 commit（message 写明来源：`manual: 编辑第3页` / `ai: 统一标题格式`）
- API：`GET /api/docs/:id/history`（git log）、`POST /api/docs/:id/checkout`（回退到指定 commit，需确认，回退本身也是一个新 commit 而非改写历史）
- 这为"部署到服务器多人用"提供了一致性底座：文档状态以 git 仓库为准

## AI 设计

- **Provider 配置**：设置面板可配多个 OpenAI 兼容 endpoint（baseURL + Key + 模型名），默认预填 `http://127.0.0.1:4000`（本机 LiteLLM）
- **GitHub Copilot OAuth**：设备码流程（复用公开的 VS Code client_id 惯例）→ 换 Copilot token → `api.githubcopilot.com` chat completions。设置面板里「GitHub Copilot 登录」按钮，服务端持有 token。（注明：依赖 GitHub 非公开 API 策略，可能有变动风险）
- **工具循环在服务端**（文档在服务端文件系统，工具必须服务端执行）。工具集 v1：
  - 文档：`read_outline`（标题树/段落地图）、`read_page(n)`、`read_paragraph(id)`、`patch_paragraphs([{id, newText}])`、`apply_format([{id, bold/font/size/alignment...}])`、`insert_paragraph(afterId, text)`、`search_replace(find, replace, scope)`
  - 版本：`git_commit(message)`、`git_history()`
  - 引用：`import_file(fileId, position)`（把 @ 文件内容导入文档）
  - 技能：`use_skill(name)`（取技能全文）
  - MCP 外部工具：`mcp__<服务>__<工具>` 动态并入
- 写工具一律走「提案→diff 预览→用户确认→执行+commit」管线（不确认不落盘）
- system prompt 拼装顺序：基础身份 + 当前文档结构摘要 + 启用的 skills 清单 + 可用 MCP 工具说明 + 用户自定义 prompt；@ 文件的提取内容作为附件块跟在用户消息后

## 目录结构

```
word-studio/
├── package.json          # type:module，scripts: start/dev/check
├── server/
│   ├── index.js          # http 服务：静态 + /api 路由 + SSE
│   ├── doc-pipeline.js   # docx→PDF（soffice）、段落解析/补丁（OOXML）
│   ├── git-store.js      # workspace git 操作封装
│   ├── llm.js            # provider 抽象：openai-compat + copilot
│   ├── copilot-auth.js   # 设备码 OAuth + token 交换
│   ├── tools.js          # AI 工具注册表 + tool-use 循环 + SSE 事件
│   ├── skills.js         # 技能扫描/启停/导入（SKILL.md + frontmatter）
│   ├── mcp-manager.js    # MCP client：stdio / streamable-http，工具并入注册表
│   ├── refs.js           # @ 引用文件：上传/提取文本/会话文件清单
│   └── config-store.js   # node:sqlite 存 provider 配置/会话/skills 启用态
├── web/
│   ├── index.html        # 三栏骨架
│   ├── app.js            # 主控制器
│   ├── api.js / model.js # 网络层 / 数据层（参考项目同款分层）
│   ├── chat.js           # 右栏对话 tab + 工具时间轴 + 确认卡 + @ 弹层
│   ├── files-panel.js    # 右栏文件 tab（会话涉及文件清单）
│   ├── pages.js          # 左栏页面列表
│   ├── viewer.js         # 中栏 pdf.js 视图 + 段落编辑模式
│   └── styles.css        # CSS Grid + 变量 + 折叠态
└── data/                 # 运行时生成：workspaces/、studio.db、mcp.json、skills/（gitignore）
```

## 实施步骤

1. **脚手架**：package.json + server/index.js（静态服务 + /api/health）+ web/ 三栏空壳（grid/resizer/折叠可用）
2. **文档管线**：上传 docx → workspace+git init → soffice 转 PDF（启动时检测 soffice，缺失给明确指引）→ pdf.js 渲染中栏 + 左栏缩略图列表
3. **Git 版本**：git-store.js（init/commit/log/checkout）+ 前端历史面板（右栏 tab 或中栏顶部抽屉）
4. **手动编辑**：段落解析（document.xml → 段落清单含 id）→ 编辑模式 UI → 补丁写回 → 重转 PDF → commit
5. **AI 链路**：provider 配置存储 + openai-compat 打通 → 工具注册表 + 服务端 tool 循环 + SSE → 右栏对话 UI + 写操作 diff 预览确认卡
6. **@ 引用与文件面板**：`@` 弹层 + 文件上传/提取（docx/pdf/txt/md→文本，图片→多模态附件）+ chip 注入上下文；文件 tab（会话涉及文件：主文档/引用/AI 触碰文件/git 记录汇总）；`import_file` 工具
7. **Skills**：skills.js 扫描启停 + `use_skill` 工具 + system prompt 注入 + 设置面板管理
8. **MCP**：mcp-manager.js（stdio + streamable-http，配置持久化到 data/mcp.json）+ 设置面板管理 + 工具命名空间并入
9. **Copilot OAuth**：设备码登录 UI + token 管理 + 接入 provider 列表
10. **收尾**：README（本地跑法 + 服务器部署法 + soffice 依赖说明）、`npm run check`（node --check 全部 js）、实际打开一个真实 docx 走通「手动改→AI 改→@引用→git 回退」全流程

## 风险与说明

- **OOXML 段落级补丁保真**：只动文本 run 和显式格式属性，复杂排版（域、文本框、SmartArt）不进入编辑范围，解析时跳过并在 UI 标注「该段不支持编辑」
- **LibreOffice 是硬依赖**：本地和服务器都要装；启动检测 + 文档说明
- **Copilot OAuth** 用的是非官方复用方案（同灵犀 Codex 的现状），GitHub 政策变动可能导致失效，UI 上会标注
- v1 不做多人实时协同（git 保证的是版本一致，不是 OT/CRDT 实时协作）
