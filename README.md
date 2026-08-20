# Word Studio

独立 Web 版 Word 工作台。LaTeX 式管线：**结构化文档模型（model.json）是单一事实源**，HTML 做实时分页预览，编辑只动内容与集中样式，最终从模型重新生成 docx / PDF。手动编辑与 AI 改动全部进 git，可追溯、可回退。

详细设计见 [DESIGN.md](DESIGN.md)（v2）。

## 快速开始

```bash
# 需要 Node.js >= 22（用到 node:sqlite）
npm install
npm start          # 或 npm run dev（--watch）
# 打开 http://127.0.0.1:4173
```

## 功能

- **导入** .docx / .doc（.doc 经 LibreOffice 预转）：解析内容与格式为文档模型
- **分页预览**：Paged.js 按纸张分页，页眉 / 页脚 / 页码可见，目录独占一页；左栏大纲树 + 页面列表
- **内容与格式分离编辑**：块级编辑模式只改内容；格式菜单栏统一管页面设置与样式表
- **选区**：块点选 / Shift 连选 / 大纲选章 / 块内文本选区；格式操作与 AI 写工具都限定在选区内
- **Git 版本管理**：每次修改（手动 / AI / 格式）一个 commit；历史面板一键回退（回退是新 commit）
- **AI 对话**：流式输出 + 工具时间轴；写工具一律 diff 预览、确认后才落盘
  - provider：OpenAI 兼容 endpoint（默认预填本机 127.0.0.1:4000）/ GitHub Copilot 设备码登录
  - `@` 引用文件（docx/pdf/txt/md 提取文本注入上下文，图片走多模态），AI 可用 `import_file` 导入文档
  - Skills：目录式技能（`data/skills/<name>/SKILL.md`），设置面板启停 / 导入
  - MCP：stdio + streamable-http 客户端，配置存 `data/mcp.json`，工具以 `mcp__<服务>__<工具>` 并入
- **导出**：docx（npm docx 重新生成，含样式 / 页眉页脚 / 页码域 / TOC 域）；PDF（无头 Chrome 打印预览页，所见即所得）

## 外部依赖

| 依赖 | 用途 | 安装 |
|---|---|---|
| 系统 `unzip` | docx 解包 | 系统自带（macOS/Linux） |
| LibreOffice (`soffice`) | 仅 .doc 导入 | `brew install --cask libreoffice` |
| poppler (`pdftotext`) | 仅 PDF 引用文件提取 | `brew install poppler` |
| Chrome / Chromium | 仅 PDF 导出 | 系统自带或设 `CHROME_PATH` |

缺哪个只影响对应功能，其余可用；相关报错会给出明确指引。

## 服务器部署

```bash
PORT=8080 node server/index.js
```

- 数据全部在 `data/`（workspaces git 仓库 + studio.db + mcp.json + skills/），备份这个目录即可
- v1 **没有鉴权**：只放内网 / 本机用，公网暴露前请自行加反向代理认证
- 服务器需装 Node 22+、unzip；按需装 LibreOffice / poppler / Chrome

## 环境变量

- `PORT`：服务端口（默认 4173）
- `CHROME_PATH`：PDF 导出用的 Chrome 路径
- `COPILOT_API_BASE`：Copilot API 地址（调试用）

## 开发

```bash
npm run check        # 全部 js 语法检查
npx vite build       # 前端（web-react/ → web-dist/，React + antd）；服务端优先服务 web-dist，旧版 web/ 兜底
```

集成测试（需服务已启动 + Chrome）：

```bash
node dev-cdp.mjs "http://127.0.0.1:4173/dev-test.html" 45   # UI 集成（选区/编辑/格式）
node dev-test-ai.mjs     # AI 对话链路（mock LLM）
node dev-test-mcp.mjs    # MCP 链路（mock server）
node dev-test-copilot.mjs # Copilot provider 链路（假 token）
```

## 已知限制（v1）

- 往返有损：支持标题/段落/表格/图片/列表/分页符/目录/页眉页脚页码；域、文本框、SmartArt、脚注尾注不支持，导入时跳过
- TOC 以 Word 域导出，打开文档时需更新域生成条目（Word 会提示）
- 预览分页是近似，精确页码以导出的 docx 在 Word 中分页为准
- Copilot OAuth 是 GitHub 非公开 API 方案，政策变动可能失效
- 不做多人实时协同（git 保证版本一致，不是 OT/CRDT）
