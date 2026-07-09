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
   - 关键字段：`sourceType` (`url` | `article`)、`sourceUrl`、`articleText`、`params`（title, audience, style, slideCount, language, model）、`status`。

6. **Web 管理界面**
   - 启动：`npm run web`（默认端口 3456）。
   - 功能：创建/删除项目、配置来源与参数、一键生成、实时流程可视化、生成后自动预览、Ctrl+P 导出。

7. **生成流程**
   - Web UI 点击“生成”会调用 `/api/projects/:name/generate`，后端运行 `scripts/generate-deck.mjs`。
   - 生成脚本优先使用 OpenAI 兼容 API（Kimi Code 等，需 `OPENAI_API_KEY`）；若未配置，再尝试 Bailian CLI (`bl chat`)；最后退化为确定性模板，确保无 LLM 也能演示完整流程。
   - 当 `OPENAI_API_KEY` 以 `sk-kimi-` 开头时，自动使用 `https://api.kimi.com/coding/v1` 与 `kimi-for-coding` 模型。

8. **导出约定**
   - PDF：服务端通过 `scripts/export-pdf.mjs` 生成，自动查找系统 Chrome；保留浏览器打印（`@media print` + `window.print()`）作为回退。
   - PPTX：通过 `scripts/export-pptx.mjs` 生成，输出到 `projects/<name>/export/deck.pptx`（可编辑文字版）。
   - 高清图片 PPTX：通过 `scripts/export-pptx.mjs --image` 生成，输出到 `projects/<name>/export/deck-image.pptx`（逐页截图，还原度最高）。
   - Web UI 中 `Ctrl+P` / `Cmd+P` 打开导出面板。

9. **备份约定**
   - 在批量修改项目、生成、升级 skills 前，运行 `npm run backup`。
   - 备份保存到 `.backup/<timestamp>/`，包含 `projects/`、`skills/`、`web/`、`server.mjs`、关键文档。

## Skill 行为

- `/ppt-structure <name>`：在 `projects/<name>/` 创建 deck，复制 `ai-ppt-base` 的 `css/ppt.css`、`js/ppt.js`、`README.md`，生成初始 `index.html` 与 `ai-ppt.json`。
- `/ppt-preview [name]`：优先在 `projects/<name>/` 启动本地服务器；未指定名称时优先当前目录，再搜索 `projects/*/`。Web UI 生成后会自动打开预览。
- `/ppt-edit [instruction]`：优先编辑 `projects/<name>/index.html`；未指定 deck 时优先当前目录，再搜索 `projects/*/`。
- `/ppt-export [name] [pdf|pptx]`：导出 deck 为 PDF（浏览器打印或可选 Puppeteer）或 PPTX（服务端生成）。

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
