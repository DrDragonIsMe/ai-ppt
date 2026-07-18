# ai-ppt 项目约定

## 目录结构

- `ai-ppt-base/`：PPT 引擎基座，是 **唯一** 的样式与脚本升级源。
- `projects/`：所有业务 deck 必须放在这里，每个子目录一个 deck。
- `skills/`：Claude CLI / Kimi CLI 的 skill 定义。
- `web/`：Web 管理界面静态资源。
- `server.mjs`：Web 服务入口。
- `scripts/`：升级、生成、导出、备份等工具脚本。
- `scripts/upgrade-decks.mjs`：一键将基座 `css/ppt.css` 和 `js/ppt.js` 同步到所有项目。

```
ai-ppt/
├── ai-ppt-base/
│   ├── css/ppt.css
│   ├── js/ppt.js
│   └── index.html
├── projects/
│   ├── <deck-name>/
│   │   ├── ai-ppt.json     # 项目配置（来源、参数、状态）
│   │   ├── css/ppt.css     # 由 upgrade-decks.mjs 从基座同步
│   │   ├── js/ppt.js       # 由 upgrade-decks.mjs 从基座同步
│   │   ├── index.html      # 业务内容
│   │   ├── export/         # 导出产物（PPTX/PDF）
│   │   └── README.md
│   └── ...
├── web/
│   ├── index.html
│   ├── css/web.css
│   └── js/web.js
├── server.mjs
├── scripts/
│   ├── upgrade-decks.mjs
│   ├── generate-deck.mjs
│   ├── export-pptx.mjs
│   ├── export-pdf.mjs
│   ├── backup.mjs
│   └── config.mjs
└── skills/
```

## 核心约定

1. **所有业务 deck 必须位于 `projects/` 下。**
   - 新建 deck：`/ppt-structure <name>` 应生成 `projects/<name>/`。
   - 预览/编辑 deck：`/ppt-preview <name>`、`/ppt-edit` 应优先查找 `projects/<name>/`。

2. **不要直接修改项目中的 `css/ppt.css` 和 `js/ppt.js`。**
   - 样式或交互改动应在 `ai-ppt-base/css/ppt.css`、`ai-ppt-base/js/ppt.js` 中进行。
   - 改完后运行 `npm run upgrade-decks` 统一覆盖到所有项目。

3. **升级流程**
   - 修改 `ai-ppt-base/css/ppt.css` 或 `ai-ppt-base/js/ppt.js`。
   - 运行 `npm run upgrade-decks` 同步。
   - 如需单独升级某个项目：`npm run upgrade-decks -- --project <name>`。
   - 查看影响范围：`npm run upgrade-decks -- --dry-run`。

4. **路径约定**
   - 每个 deck 的 `index.html` 使用相对路径引用本地引擎文件：
     ```html
     <link rel="stylesheet" href="css/ppt.css">
     <script src="js/ppt.js"></script>
     ```
   - 不要改成基座相对路径（如 `../ai-ppt-base/css/ppt.css`），以保证单个 deck 可独立移动或打包。

5. **项目配置 `ai-ppt.json`**
   - 每个 deck 目录必须包含 `ai-ppt.json`，供 Web UI 和生成脚本使用。
   - 关键字段：`sourceType` (`url` | `article`)、`sourceUrl`、`articleText`、`params`（title, audience, style, slideCount, language）、`modelConfig`、`status`。
   - `modelConfig` 结构：`presetId`（预设 ID）、`provider`、`baseUrl`、`model`、`apiKey`。默认使用 `kimi-code`，可在 Web UI 模型配置面板切换或自定义。

6. **Web 管理界面**
   - 启动：`npm run web`（默认端口 3456）。
   - 功能：创建/删除项目、配置来源与参数、一键生成、实时流程可视化、生成后自动预览、Ctrl+P 导出。

7. **生成流程**
   - Web UI 点击“生成”会调用 `/api/projects/:name/generate`，后端运行 `scripts/generate-deck.mjs`。
   - 生成脚本优先使用项目 `modelConfig` 中配置的 OpenAI 兼容 API（`baseUrl`、`model`、`apiKey`）；若未配置 API Key，则回退到环境变量 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`。
   - 若仍无可用 OpenAI 兼容配置，再尝试 Bailian CLI (`bl chat`)；最后退化为确定性模板，确保无 LLM 也能演示完整流程。
   - 当 `OPENAI_API_KEY` 以 `sk-kimi-` 开头且未指定 Base URL 时，自动使用 `https://api.kimi.com/coding/v1` 与 `kimi-for-coding` 模型。

8. **导出约定**
   - PDF：服务端通过 `scripts/export-pdf.mjs` 生成，自动查找系统 Chrome；保留浏览器打印（`@media print` + `window.print()`）作为回退。
   - PPTX：通过 `scripts/export-pptx.mjs` 生成，输出到 `projects/<name>/export/deck.pptx`（可编辑文字版）。
   - 高清图片 PPTX：通过 `scripts/export-pptx.mjs --image` 生成，输出到 `projects/<name>/export/deck-image.pptx`（逐页截图，还原度最高）。
   - Web UI 中 `Ctrl+P` / `Cmd+P` 打开导出面板。

9. **备份约定**
   - 在批量修改项目、生成、升级 skills 前，运行 `npm run backup`。
   - 备份保存到 `.backup/<timestamp>/`，包含 `projects/`、`skills/`、`web/`、`server.mjs`、关键文档。

10. **关键数字 / 数据页排版原则**
    - 同一行展示，元素不超过 4 个；超过 4 个时应拆页或改用表格/卡片。
    - 使用 `.split-visual` + `.hero-stat` + `.big-number` 布局，数字字号由 `.big-number` 统一控制（当前 `clamp(44px, 5.5vw, 80px)`），并禁止换行。
    - 数字项等宽分布，随视口自动缩放，最大宽度 240px。

11. **主题使用约定**
    - deck 只能使用默认主题（`web-ui`）或 `ai-ppt-base/css/themes/` 中已预设的主题之一。
    - 没有用户明确指令时，一律使用默认主题，不要自行更换预设主题，更不要新创主题或配色。

## Skill 行为

- `/ppt-structure <name>`：在 `projects/<name>/` 创建 deck，复制 `ai-ppt-base` 的 `css/ppt.css`、`js/ppt.js`、`README.md`，生成初始 `index.html` 与 `ai-ppt.json`。
- `/ppt-preview [name]`：优先在 `projects/<name>/` 启动本地服务器；未指定名称时优先当前目录，再搜索 `projects/*/`。Web UI 生成后会自动打开预览。
- `/ppt-edit [instruction]`：优先编辑 `projects/<name>/index.html`；未指定 deck 时优先当前目录，再搜索 `projects/*/index.html`。
- `/ppt-export [name] [pdf|pptx]`：导出 deck 为 PDF（浏览器打印或可选 Puppeteer）或 PPTX（服务端生成）。
- `/ppt-list`：列出 `projects/` 下所有 deck 的标识、标题、状态与最后生成时间。
- `/ppt-delete <name>`：删除 `projects/<name>/`，操作前会要求确认。
- `/ppt-design`：幻灯片设计规范（蒸馏自 GitHub 的 impeccable 与 taste-skill）。生成、搭建、编辑、审查 deck 时遵循：先出"设计解读"，版式轮换、眉毛（kicker/section-title）节制、禁渐变文字、禁编造数据，附交付前检查清单。

## 安装与同步 skills

修改 `skills/` 后，运行以下命令让本地 CLI 生效：

```bash
node install-skills.js
```

或：

```bash
./install-skills.sh
```

## 迁移历史

- v1.5 曾将 CSS/JS 内联到 `index.html`，后因升级维护困难 revert 回分离结构。
- v1.6 引入 `projects/` 目录，统一存放业务 deck，并新增 `scripts/upgrade-decks.mjs` 同步基座引擎到所有项目。
- v1.7 新增 Web 管理界面（`web/` + `server.mjs`）、URL/文章内容自动生成管线、PPTX/PDF 导出 skill、项目备份脚本。
- v1.7.1 高清图片 PPTX 导出禁用动画以截取最终状态；修复 `.two-col > .visual-card` 在可编辑 PPTX 中缺失内容；PDF 导出支持自动查找 Chrome；支持 `.env.kimi` 配置 Kimi Code。
- v1.7.2 全面对齐 `teal-editorial` 配色（ink #151A19 / cream #FAFAF7 / tile #EDF1F0 / tile-strong #E3E9E7 / teal #00B498 / navy #0B1413）；标题改为衬线、字重 400；PDF 导出改为逐页截图并合并，输出完整多页 PDF；可编辑 PPTX 同步更新配色与字体。
- v1.7.3 新增模型配置 `modelConfig`（预设 / Base URL / Model / API Key），Web UI 加载模型列表，默认 `kimi-code`；teal 情绪色改为 `#439288`；新增 `/ppt-list` 与 `/ppt-delete` skill。
- v1.7.4 引入 GitHub 设计 skill（impeccable + taste-skill）的蒸馏版 `/ppt-design`；`generate-deck.mjs` prompt 内置反模板化设计规则，兜底模板去除硬编码文案与编造数据；基座标题增加 `text-wrap: balance`、新增 `prefers-reduced-motion` 兜底；`progress-ring` 支持直观的 `--progress-pct` 百分比（旧 `--progress` dashoffset 写法保持兼容）；`.gradient-text` 标记弃用（保留兼容）；演示 deck 数字页改用标准 `split-visual` + `hero-stat`；修复 `ppt.js` 初始化时用 localStorage/默认主题覆盖 `<body>` 上硬编码 `theme-*` 类的问题——现在 `ai-ppt.json` 的 `theme` 字段在页面加载后真正生效。
- v1.7.5 修复全屏时左上角帮助面板（`#help`）等悬浮 UI 常驻遮挡内容的问题：原实现用 `:fullscreen:hover` 控制显隐，鼠标只要停留在页面上 UI 就一直可见。改为 JS 无活动检测——全屏下默认隐藏帮助面板/主题切换/HUD/全屏按钮，`mousemove`/`touchstart` 时通过 `<html>.fs-ui-visible` 短暂显示，2 秒无活动后自动淡出；进入和退出全屏时重置该状态。
- v1.7.6 修复 ↑ 预览（overview）缩略图全空白的 bug：克隆的 `.slide` 继承了基座规则的 `opacity: 0` 和视口相对 padding，旧的 `.slide-content scale(0.22)` 缩放方案因此失效。改为在 `buildOverview()` 中把克隆节点按固定 1280×800 设计尺寸布局后整体 `scale()` 进卡片，缩略图与真实页面一致；同时让 `progress-ring` 与 `waterfall` 组件在缩略图中渲染终态（动画只在 `.slide.active` 上播放）。
