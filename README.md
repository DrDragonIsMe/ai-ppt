# ai-ppt

基于 HTML/CSS/JS 的轻量级幻灯片系统，支持键盘导航、全屏放映、多页预览、PDF 导出，以及通过 Web 界面从 URL 或文章内容自动生成完整 deck。附带 Claude CLI / Kimi CLI 的 skill 扩展：`/ppt-preview`、`/ppt-structure`、`/ppt-edit`、`/ppt-export`、`/ppt-list`、`/ppt-delete`。

## 仓库结构

```
ai-ppt/
├── ai-ppt-base/                  # 可复用的 PPT 引擎基座（唯一升级源）
│   ├── index.html                # 示例/默认 deck
│   ├── css/ppt.css               # 主题与放映样式
│   ├── js/ppt.js                 # 导航、全屏、预览、PDF 导出
│   ├── theme-ref/                # 风格参考
│   └── README.md                 # deck 级说明
├── projects/                     # 所有业务 deck
│   ├── aoji-company/
│   ├── xinrenxinshi-huaxia-bank/
│   ├── xinrenxinshi-usagestobank/
│   ├── yellow-books/
│   └── ...
├── web/                          # Web 管理界面
│   ├── index.html
│   ├── css/web.css
│   └── js/web.js
├── server.mjs                    # Web 服务入口
├── skills/                       # CLI skills
│   ├── ppt-preview/              # /ppt-preview
│   ├── ppt-structure/            # /ppt-structure
│   ├── ppt-edit/                 # /ppt-edit
│   ├── ppt-export/               # /ppt-export
│   ├── ppt-list/                 # /ppt-list
│   └── ppt-delete/               # /ppt-delete
├── scripts/                      # 升级、生成、导出、备份工具
│   ├── upgrade-decks.mjs         # 用基座 css/js 覆盖所有项目
│   ├── generate-deck.mjs         # 从 URL/文章生成 deck
│   ├── export-pptx.mjs           # 导出 PPTX
│   ├── export-pdf.mjs            # 导出 PDF（可选 Puppeteer）
│   ├── backup.mjs                # 项目与技能备份
│   └── config.mjs                # 项目配置读写
├── install-skills.js             # Node 安装脚本
├── install-skills.sh             # Shell 安装脚本
├── package.json                  # npx 支持
├── AGENTS.md                     # 项目约定与记忆
├── MEMORY.md                     # 架构记忆
└── README.md                     # 本文件
```

## 快速开始

### 1. 安装 skills

```bash
# 方式一：Shell
./install-skills.sh

# 方式二：Node
node install-skills.js

# 方式三：npx（本地）
npm link
npx ai-ppt-skills

# 方式四：npx（发布后）
npx ai-ppt-skills
```

安装完成后重启 CLI 会话。

### LLM 配置（系统级别，默认火山方舟 doubao-seed-2.0-lite）

模型配置已提升为**系统级别**：在 Web UI「模型配置」面板修改后对所有项目生效，保存在 `.ai-ppt-config.json`（已加入 `.gitignore`）。命令行生成同样读取该全局配置。

优先级（从高到低）：

1. 环境变量 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`
2. `.ai-ppt-config.json` 中的 `modelConfig`
3. 内置默认（火山方舟 doubao-seed-2.0-lite）

```bash
# 方式 A：火山方舟 doubao-seed-2.0-lite（默认）
export OPENAI_API_KEY=ark-...
export OPENAI_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
export OPENAI_MODEL=doubao-seed-2.0-lite

# 方式 B：Kimi Code
export OPENAI_API_KEY=sk-kimi-...
export OPENAI_BASE_URL=https://api.kimi.com/coding/v1
export OPENAI_MODEL=kimi-for-coding

# 方式 C：Bailian CLI
bl login
```

如果 `OPENAI_API_KEY` 以 `sk-kimi-` 开头且未设置 `OPENAI_BASE_URL`，脚本会自动使用 `https://api.kimi.com/coding/v1` 和 `kimi-for-coding` 模型。

也可以将上述环境变量写入 `.env.kimi`（已加入 `.gitignore`，不要提交到仓库），然后启动 Web 服务：

```bash
source .env.kimi && npm run web
```

### 2. 新建 deck

```bash
/ppt-structure q3-report
```

会生成：

```
projects/q3-report/
├── README.md
├── index.html
├── css/ppt.css
└── js/ppt.js
```

### 3. 编辑 deck

```bash
cd q3-report
/ppt-edit slide 1 title "Q3 业务复盘"
```

或直接修改 `index.html`。

### 4. 预览

```bash
/ppt-preview              # 预览当前目录 deck
/ppt-preview q3-report    # 预览 projects/q3-report
```

### 5. 升级 deck 引擎

当 `ai-ppt-base` 的样式或交互引擎更新后，同步到所有项目：

```bash
npm run upgrade-decks
```

仅升级指定项目：

```bash
npm run upgrade-decks -- --project q3-report
```

查看影响范围（不实际复制）：

```bash
npm run upgrade-decks -- --dry-run
```

### 6. Web 管理界面（推荐）

启动 Web 控制台，在浏览器中管理项目、配置来源、自动生成幻灯片：

```bash
npm run web
```

默认打开 `http://localhost:3456`。

- 创建/删除项目
- 选择内容来源：网页 URL 或粘贴文章内容
- 配置标题、受众、风格、页数、模型等参数
- 点击“生成幻灯片”，实时查看流程进度
- 生成完成后自动打开预览
- **可视化编辑**：点击预览区「编辑模式」，直接在幻灯片上修改文字，保存后写回 `index.html`
- **AI 不覆盖手动编辑**：`ai-ppt.json` 记录 `userEdits`，后续 AI 生成/修改会把用户编辑作为约束保留
- 按 `Ctrl+P` / `Cmd+P` 打开导出面板（PDF / PPTX）

### 7. 命令行生成与导出

生成指定项目的幻灯片：

```bash
npm run generate -- q3-report
```

导出 PPTX（可编辑文字版，布局近似）：

```bash
npm run export-pptx -- q3-report
```

导出高清图片 PPTX（逐页截图，还原度最高）：

```bash
npm run export-pptx-image -- q3-report
```

导出 PDF（自动查找系统 Chrome，若未安装则提示使用浏览器打印）：

```bash
npm run export-pdf -- q3-report
```

产物保存在 `projects/<deck-name>/export/`：

```
projects/q3-report/export/
├── deck.pptx        # 可编辑文字版
├── deck-image.pptx  # 高清图片版
└── deck.pdf         # PDF 版
```

### 8. 备份

在批量修改前创建备份：

```bash
npm run backup
```

备份保存在 `.backup/<timestamp>/`。

## 键盘快捷键

### 放映页

| 按键 | 功能 |
|------|------|
| `→` / `←` | 下/上一页 |
| `Cmd + →` / `Cmd + ←` | 尾页/首页 |
| `↑` | 多页预览 |
| `↓` | 导出 PDF |
| `Ctrl + P` / `Cmd + P` | 打印 / 导出面板（Web UI） |
| `F` | 全屏 |
| `T` | 切换主题 |
| `s` | 缩略图侧边栏 |
| `Shift + S` | 演讲者模式（备注 + 下一页预览 + 计时） |
| `?` | 帮助面板 |
| `ESC` | 退出 |

### Web 管理界面

| 按键 | 功能 |
|------|------|
| `?` | 帮助面板 |
| `Ctrl + N` | 新建项目 |
| `Ctrl + S` | 保存配置 |
| `Ctrl + P` | 导出面板 |
| `Ctrl + G` | 生成幻灯片 |
| `Ctrl + O` | 打开预览 |
| `Ctrl + K` | 全局搜索 |
| `1` - `9` | 快速切换项目 |
| `Tab` | 切换配置标签 |
| `ESC` | 关闭弹窗/面板 |

## 可用 skill

| Skill | 作用 |
|-------|------|
| `/ppt-preview [deck]` | 启动本地服务器预览 deck |
| `/ppt-structure <name>` | 从 `ai-ppt-base` 新建 deck |
| `/ppt-edit [instruction]` | 修改幻灯片文字、布局 |
| `/ppt-export [deck] [pdf\|pptx]` | 导出 PDF 或 PPTX |
| `/ppt-list` | 列出所有 deck |
| `/ppt-delete <deck>` | 删除指定 deck（需确认） |

## 发布到 npm

如果你想让其他人通过 npx 安装：

```bash
npm publish --access public
```

之后任何人都可以运行：

```bash
npx ai-ppt-skills
```

## 可用 Deck（项目目录）

| Deck | 说明 |
|------|------|
| `ai-ppt-base/` | PPT 引擎基座模板，可复用 |
| `projects/q3-sales-preview/` | Q3 销售队伍建设动员 |
| `projects/test-new-css/` | 测试新 CSS/配色效果 |
| `projects/xinrenxinshi-huaxia-bank/` | 薪人薪事 × 华夏银行 |

## 更新日志

### v1.8.2 — 可视化编辑、AI 约束与 Web UI 重设计（2026-07）

- **可视化编辑模式**：Web UI 预览区新增「编辑模式」，通过 `postMessage` 在 iframe 内开启 `contenteditable`；用户可直接点击修改幻灯片文字，保存时调用 `POST /api/projects/:name/save-edits` 持久化到 `index.html`，取消时放弃改动。
- **用户编辑保护**：`scripts/save-edits.mjs` 在保存时记录 `ai-ppt.json.userEdits`（含每页标题与文本摘要）；`generate-deck.mjs` 与 `chat-modify.mjs` 的 prompt 中读取该记录并明确要求 AI 保留用户手动编辑过的幻灯片文字、观点与数据。
- **Web UI 布局重设计**：采用「顶部工具栏 + 左侧可折叠项目列表 + 中间大画布预览 + 右侧属性面板」的类 Canva / Google Slides 布局，预览区更宽敞；属性面板分为内容/主题/动画/组件/版本/AI 修改标签页；顶部工具栏集成项目下拉、编辑模式、生成、导出、预览与全局搜索。
- **导出下拉菜单**：顶部工具栏新增导出下拉（PPTX / 高清图片 PPTX / PDF / 单文件 HTML），同时保留 `Ctrl+P` 导出面板。
- **测试覆盖**：`scripts/test-smoke.mjs` 新增 `save user edits` 用例。
- **系统级别模型配置**：模型配置从 `ai-ppt.json` 提升到 `.ai-ppt-config.json`，Web UI「模型配置」面板对所有项目生效；`generate-deck.mjs` / `chat-modify.mjs` 通过 `scripts/global-config.mjs` 读取全局模型。

### v1.8.1 — 演讲者模式、主题编辑器与组件库（2026-07）

- **演讲者模式**：放映页按 `Shift+S` 打开演讲者窗口（当前页备注、下一页预览、计时器）；在幻灯片内用 `<div class="speaker-note">...</div>` 编写备注（放映时隐藏）。
- **新动画**：`anim-zoom`（缩放淡入）、`anim-blur`（模糊淡入）、`anim-flip`（3D 翻转），Web UI 动画面板可选。
- **可视化主题编辑器**：主题页新增「自定义变量」，可视化调整主色/文字色/背景色与标题/正文字体，实时注入 `<style id="theme-overrides">` 并持久化到 `ai-ppt.json`。
- **组件库**：新增「组件」标签页，一键插入封面、大数字统计、表格、进度环、时间线、瀑布图、步骤流程、结尾页等预制组件。
- **单文件 HTML 导出**：导出面板新增「下载单文件 HTML」（`scripts/export-single-html.mjs`，内联所有 CSS/JS，可独立分发）。

### v1.8 — 多后端 LLM、快照、搜索与对话式修改（2026-07）

- **LLM 多后端**：支持 LM Studio 本地模型（`http://localhost:1234/v1`，自动识别已加载模型）与任意 OpenAI 兼容远程端点；Web UI 模型预设可「刷新列表」拉取远程模型。
- **对话式修改**：预览区新增「AI 修改」聊天面板，自然语言指令直接改写幻灯片（修改前自动快照）；CLI：`npm run chat-modify -- <name> "<instruction>"`，供外部 AI 驱动。
- **快照/版本管理**：项目页新增「版本」标签，一键保存/恢复/删除快照（存储于 `.snapshots/`）；CLI：`npm run snapshot -- <create|list|restore|delete>`。
- **全局搜索**：顶栏搜索框（`Ctrl+K`）跨项目搜索标题与幻灯片内容；CLI：`npm run search -- <关键词>`。
- **Markdown 导入**：内容面板一键导入 `.md/.txt` 文件作为文章内容。
- **放映体验**：新增可收起的幻灯片缩略图导航侧边栏；帮助面板分组重设计。
- **Web UI 快捷键**：`?`/`Ctrl+N/S/P/G/O/K`、`1-9` 切换项目、`Tab` 切换标签、`Esc` 关闭面板，附帮助面板。

### v1.7 — Web 管理、自动生成、PPTX 导出（2026-07）

- **Web 管理界面**：新增 `web/` + `server.mjs`，支持浏览器中创建项目、配置 URL/文章内容、调整生成参数。
- **自动生成管线**：`scripts/generate-deck.mjs` 支持从 URL 或文章生成 HTML 幻灯片，优先 Bailian CLI，其次 OpenAI 兼容 API，最后确定性模板兜底。
- **流程可视化**：生成过程通过 SSE 实时推送到 Web UI，完成后自动打开预览。
- **PPTX 导出**：新增 `/ppt-export` skill 与 `scripts/export-pptx.mjs`，使用 `pptxgenjs` 生成 `.pptx`。
- **高清图片 PPTX 导出**：新增 `npm run export-pptx-image`，使用 Puppeteer 截取每页最终状态并嵌入 PPTX。
- **PDF 导出**：`scripts/export-pdf.mjs` 自动查找系统 Chrome，无需手动配置 `PUPPETEER_EXECUTABLE_PATH`；同时保留浏览器打印回退。
- **项目备份**：新增 `scripts/backup.mjs` 与 `npm run backup`。
- **LLM 配置**：支持通过 `.env.kimi` 配置 Kimi Code 等 OpenAI 兼容 API。

### v1.7.2 — 配色与导出修复（2026-07）

- 对齐 `teal-editorial` 参考配色：ink #151A19、cream #FAFAF7、tile #EDF1F0、tile-strong #E3E9E7、teal #00B498、navy #0B1413。
- 标题字体改为衬线、字重 400，去除渐变效果，情绪色仅用于 kicker / badge / icon / progress。
- PDF 导出改为逐页 Puppeteer 截图后合并，输出完整多页 PDF。
- 可编辑 PPTX 同步更新配色与字体，更接近浏览器渲染效果。

### v1.7.3 — 模型配置、新 skills、配色微调（2026-07）

- 新增 `modelConfig` 配置项，支持在 Web UI 选择模型预设或自定义 Base URL / Model / API Key，默认 `kimi-code`。
- Web UI 模型配置面板从 `/api/models` 加载模型列表。
- 新增 `/ppt-list` skill 用于列出所有 deck，新增 `/ppt-delete` skill 用于删除 deck。
- teal 情绪色从 `#00B498` 调整为 `#439288`。

### v1.4 — PDF 页眉标题 + 专业水印（2025-07）

- **PDF 导出页眉**：点击 `↓` 导出前自动设置静态文档标题，浏览器打印对话框显示正确文件名。
- **打印水印**：每页添加半透明文字水印"内部资料，请勿非法传播"，防止外泄。
- **页边距优化**：通过 `@page` 调整上下边距，避免内容被裁剪。

### v1.3 — 打印输出介质自适应（2025-07）

- **物理打印**：幻灯片以 `100vw × 100vh` 渲染，A4 纸等比缩放内容，不再强制压缩到 297mm。
- **虚拟 PDF 导出**：浏览器 PDF 渲染器使用完整页面区域，保持满屏比例。
- **预览空白修复**：向上箭头打开多页预览时，所有页面内容可见（`.overview-card .slide-content` 强制 `opacity: 1`）。
- 影响全部 deck：`ai-ppt-base/`, `aoji-company/`, `xinrenxinshi-huaxia-bank/`, `xinrenxinshi-usagestobank/`, `yellow-books/`

### v1.2 — PDF 导出与预览修复（2025-07）

- **PDF 导出尺寸修复**：打印模式下幻灯片满屏渲染，解决 A4 纸上只占中心小区域的问题。
- **预览空白修复**：向上箭头打开多页预览时，所有页面内容可见。

## 许可证

MIT
