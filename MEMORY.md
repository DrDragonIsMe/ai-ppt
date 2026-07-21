# ai-ppt 架构记忆

## 项目定位

ai-ppt 是一个基于 HTML/CSS/JS 的轻量级幻灯片系统，面向 Claude CLI / Kimi CLI 提供 skill 扩展，同时提供内置 Web 管理界面，支持从 URL 或文章内容自动生成完整幻灯片。

## 设计系统

当前默认主题为 `teal-editorial`：

| Token | Hex | 用途 |
|-------|-----|------|
| `--ink` | `#151A19` | 主文字、标题 |
| `--cream` | `#FAFAF7` | 页面背景 |
| `--tile` | `#EDF1F0` | 卡片背景 |
| `--tile-strong` | `#E3E9E7` | 卡片边框、分隔线 |
| `--teal` | `#439288` | 唯一情绪色（kicker、badge、icon、progress、强调） |
| `--navy` | `#0B1413` | 代码块、深色表面 |

标题使用衬线字体 `Georgia / Noto Serif SC / Songti SC`，字重 400；正文使用同一衬线字体；UI 元素（kicker、badge、kbd）使用无衬线字体。

## 关键数字 / 数据页排版原则

- 同一行展示，元素不超过 4 个；超过 4 个时应拆页或改用表格/卡片。
- 使用 `.split-visual` + `.hero-stat` + `.big-number` 时，数字字号由 `.big-number` 统一控制（当前 `clamp(44px, 5.5vw, 80px)`），并设置 `white-space: nowrap` 禁止换行。
- 数字项等宽分布，最大宽度 240px，间距随 viewport 缩放。

## 核心文件与职责

| 文件/目录 | 职责 |
|-----------|------|
| `ai-ppt-base/` | PPT 引擎基座：css/ppt.css、js/ppt.js 是唯一升级源。 |
| `projects/<name>/` | 业务 deck，包含 index.html、ai-ppt.json、css/、js/、export/。 |
| `web/` | Web 管理界面（index.html、css/web.css、js/web.js）。 |
| `server.mjs` | Web 服务入口，提供 API 与静态文件服务。 |
| `scripts/config.mjs` | 项目配置读写、创建、删除。 |
| `scripts/generate-deck.mjs` | 从 URL/文章生成 deck，输出 NDJSON 进度事件。 |
| `scripts/content-extractor.mjs` | URL 抓取与正文提取。 |
| `scripts/llm-adapter.mjs` | LLM 调用适配：LM Studio / OpenAI 兼容 / Bailian CLI，多后端自动路由与回退。 |
| `scripts/search.mjs` | 全局搜索：索引所有项目标题、来源与幻灯片文本，`npm run search -- <关键词>`。 |
| `scripts/snapshot.mjs` | 项目快照：`create/list/restore/delete`，存储于 `.snapshots/<name>/<id>/`。 |
| `scripts/chat-modify.mjs` | 对话式修改：按自然语言指令调用项目配置的 LLM 改写幻灯片，修改前自动快照。 |
| `scripts/export-pptx.mjs` | 使用 pptxgenjs 生成 PPTX。 |
| `scripts/export-pdf.mjs` | 可选 Puppeteer 打印 PDF，否则回退浏览器打印。 |
| `scripts/backup.mjs` | 备份 projects/、skills/、web/、关键文档。 |
| `scripts/upgrade-decks.mjs` | 将 ai-ppt-base 的 css/js 同步到所有项目。 |
| `skills/` | CLI skill 定义：ppt-structure、ppt-preview、ppt-edit、ppt-export、ppt-list、ppt-delete。 |
| `install-skills.js` / `install-skills.sh` | 将 skills 安装到 ~/.agents/skills 与 ~/.kimi-code/skills。 |

## 配置规范

每个项目必须包含 `ai-ppt.json`：

```json
{
  "name": "q3-report",
  "sourceType": "article",
  "sourceUrl": "",
  "articleText": "...",
  "params": {
    "title": "Q3 业务复盘",
    "audience": "管理层",
    "style": "商业汇报",
    "slideCount": 8,
    "language": "zh-CN"
  },
  "modelConfig": {
    "presetId": "kimi-code",
    "provider": "kimi",
    "baseUrl": "https://api.kimi.com/coding/v1",
    "model": "kimi-for-coding",
    "apiKey": ""
  },
  "status": "ready",
  "lastGeneratedAt": "2026-07-09T01:41:53.000Z",
  "errorMessage": null
}
```

`status` 取值：`draft`、`generating`、`ready`、`error`。

## 生成管线

1. Web UI 调用 `POST /api/projects/:name/generate`。
2. `server.mjs` spawn `scripts/generate-deck.mjs <name>`。
3. `generate-deck.mjs` 读取 `ai-ppt.json`，提取 URL 或使用文章内容。
4. 调用 `llm-adapter.mjs` 生成幻灯片 HTML；按 `modelConfig.provider` 路由：LM Studio（`localhost:1234`，无 API Key、自动取已加载模型）→ OpenAI 兼容 API（Kimi Code 自动检测）→ Bailian CLI → 确定性模板兜底。
5. 如果 LLM 不可用，使用 `buildFallbackSlides` 确定性模板。
6. 确保仅第一张 slide 带 `active` 类，写入 `index.html`。
7. 通过 stdout NDJSON 发送进度事件，server 通过 SSE 转发给前端。
8. 生成完成后 Web UI 自动打开 `/projects/:name/` 预览。

## 对话式修改管线

1. Web UI「AI 修改」面板调用 `POST /api/projects/:name/chat`（携带自然语言指令与可选 session API Key）。
2. `server.mjs` spawn `scripts/chat-modify.mjs <name> <instruction>` 并等待完成。
3. 脚本提取当前幻灯片 HTML → 自动保存快照 → 构建修改 prompt → 调用 `llm-adapter.mjs`（按项目 `modelConfig`）→ 清洗输出并重写 `index.html`。
4. 失败时不改动文件（快照可用于回滚）；CLI 同样可用：`npm run chat-modify -- <name> "<instruction>"`，供外部 AI 驱动。

## 快照与搜索

- 快照：`scripts/snapshot.mjs`，`.snapshots/<name>/<timestamp-id>/` 全量复制项目目录 + `snapshot.json` 元信息；Web UI「版本」标签管理。
- 搜索：`scripts/search.mjs` 每次请求时实时建索引（项目量小，无需缓存）；`GET /api/search?q=` 供 Web UI 顶栏搜索框使用。

## 导出策略

- **PDF**：服务端 `scripts/export-pdf.mjs` 使用 `puppeteer-core` 自动查找系统 Chrome，逐页截取最终状态后通过 `pdf-lib` 合并为 `projects/<name>/export/deck.pdf`；未找到 Chrome 时回退到浏览器打印（`window.print()` / `@media print`）。
- **PPTX（可编辑文字）**：服务端 `pptxgenjs` 解析 `index.html` 中的 `.slide` 元素，使用 `teal-editorial` 配色与衬线标题字体生成 `projects/<name>/export/deck.pptx`。
- **PPTX（高清图片）**：`scripts/export-pptx.mjs --image` 使用 Puppeteer 截取每页最终状态（禁用所有动画/过渡），生成 `projects/<name>/export/deck-image.pptx`。
- Web UI 中 `Ctrl+P` / `Cmd+P` 打开导出面板，可下载上述三种产物。

## 备份策略

运行 `npm run backup` 会复制 `projects/`、`skills/`、`web/`、`server.mjs`、`AGENTS.md`、`README.md`、`MEMORY.md`、`package.json` 到 `.backup/<timestamp>/`。重大修改前应先备份。

## 依赖

- `cheerio`：HTML 解析（内容提取、生成时清洗、PPTX 导出）。
- `pptxgenjs`：PPTX 生成。
- `puppeteer-core`：服务端 PDF 与高清图片 PPTX 导出。
- `.env.kimi`：Kimi Code 等 OpenAI 兼容 API 的密钥与 Base URL（已加入 `.gitignore`）。

## 升级流程

1. 样式/交互改动在 `ai-ppt-base/` 进行。
2. 运行 `npm run upgrade-decks` 同步到所有项目。
3. 修改 `skills/` 后运行 `node install-skills.js`。
4. 更新 `AGENTS.md`、`README.md`、`MEMORY.md` 以反映新约定。

## 回退策略

- 生成失败时会保留原 `index.html`，并将状态置为 `error`。
- 备份目录可直接复制回项目根目录以恢复状态。
- 无 LLM 时自动生成器会输出基于关键词的示例 deck，保证流程可演示。
