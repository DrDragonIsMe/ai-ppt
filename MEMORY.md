# ai-ppt 架构记忆

## 项目定位

ai-ppt 是一个基于 HTML/CSS/JS 的轻量级幻灯片系统，面向 Claude CLI / Kimi CLI 提供 skill 扩展，同时提供内置 Web 管理界面，支持从 URL 或文章内容自动生成完整幻灯片。内置知识库（vault）功能——双链笔记、知识星图、知识卡片、测验、错题集与复习训练——面向学习、培训与办公知识管理等通用场景。

## 通用化命名约定（v1.9.0）

- 用户可见文案使用普适命名：测验（非试卷）、错题集（非错题本）、知识卡片（非知识点卡片）、分类（字段仍为 `subject`）、熟练度（字段仍为 `mastery`）、复习训练。
- **API 端点路径与数据字段名保持原样**（`/api/exams`、`/api/mistakes`、`subject`、`mastery`），通用化只改文案，不改契约。

## 安全约定（v1.9.0）

- 所有 API 路由的 `:name` / `:id` / body 中的名称字段必须经过 `server.mjs` 的 `isSafeName()` 校验（拒绝 `/`、`\`、`..` 与控制字符，允许中文/空格）。
- URL pathname 只在请求入口处 `decodeURIComponent` 一次，路由 handler 内禁止二次 decode。
- vault 脚本层（`vault.mjs` / `knowledge-cards.mjs` / `exam-papers.mjs`）的路径函数自带同样的校验作为纵深防御，不依赖调用方。
- 新增字面量路由（如 `/stats`、`/due`）必须放在 `:id` 通配路由之前（路由按数组顺序首匹配）。
- 静态路由项目名正则 `PROJECT_NAME_RE` 允许 `\u4e00-\u9fa5`，与 `generate-from-note.mjs` 的项目名清洗规则保持一致。

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

标题与正文均使用无衬线字体栈 `PingFang SC / Noto Sans SC / Hiragino Sans GB / Microsoft YaHei, sans-serif`（`ai-ppt-base/css/ppt.css` 的 `--font-heading` 与 `--font-body` 相同）；衬线方向（Songti SC）已被否决，见 `scripts/export-pptx.mjs` 注释。

## 关键数字 / 数据页排版原则

- 同一行展示，元素不超过 4 个；超过 4 个时应拆页或改用表格/卡片。
- 使用 `.split-visual` + `.hero-stat` + `.big-number` 时，数字字号由 `.big-number` 统一控制（当前 `clamp(44px, 5.5vw, 80px)`），并设置 `white-space: nowrap` 禁止换行。
- 数字项等宽分布，最大宽度 240px，间距随 viewport 缩放。

## 核心文件与职责

| 文件/目录 | 职责 |
|-----------|------|
| `ai-ppt-base/` | PPT 引擎基座：css/ppt.css、js/ppt.js 是唯一升级源。 |
| `projects/<name>/` | 业务 deck，包含 index.html、ai-ppt.json、css/、js/、export/。 |
| `web/` | Web 管理界面（index.html、css/web.css、js/modules/ 无构建 ES Modules，入口 app.mjs）。 |
| `server.mjs` | Web 服务入口，提供 API 与静态文件服务。 |
| `scripts/config.mjs` | 项目配置读写、创建、删除；模型默认配置现在来自 `global-config.mjs`。 |
| `scripts/global-config.mjs` | 系统级别全局配置读写（当前仅 `modelConfig`），存储于 `.ai-ppt-config.json`。
| `scripts/generate-deck.mjs` | 从 URL/文章生成 deck，输出 NDJSON 进度事件。 |
| `scripts/content-extractor.mjs` | URL 抓取与正文提取。 |
| `scripts/llm-adapter.mjs` | LLM 调用适配：LM Studio / OpenAI 兼容 / Bailian CLI，多后端自动路由与回退。 |
| `scripts/search.mjs` | 全局搜索：索引所有项目标题、来源与幻灯片文本，`npm run search -- <关键词>`。 |
| `scripts/snapshot.mjs` | 项目快照：`create/list/restore/delete`，存储于 `.snapshots/<name>/<id>/`。 |
| `scripts/chat-modify.mjs` | 对话式修改：按自然语言指令调用项目配置的 LLM 改写幻灯片，修改前自动快照。 |
| `scripts/export-pptx.mjs` | 使用 pptxgenjs 生成 PPTX。 |
| `scripts/export-pdf.mjs` | 可选 Puppeteer 打印 PDF，否则回退浏览器打印。 |
| `scripts/export-single-html.mjs` | 单文件 HTML 导出：内联本地 CSS/JS，输出 `export/deck-single.html`。 |
| `scripts/save-edits.mjs` | 保存用户在 iframe 中编辑后的 HTML，自动快照并记录 `ai-ppt.json.userEdits`。
| `scripts/backup.mjs` | 备份 projects/、skills/、web/、关键文档。 |
| `scripts/upgrade-decks.mjs` | 将 ai-ppt-base 的 css/js 同步到所有项目。 |
| `skills/` | CLI skill 定义：ppt-structure、ppt-preview、ppt-edit、ppt-export、ppt-list、ppt-delete。 |
| `install-skills.js` / `install-skills.sh` | 将 skills 安装到 ~/.agents/skills 与 ~/.kimi-code/skills。 |

## 配置规范

### 项目配置 `ai-ppt.json`

每个项目必须包含 `ai-ppt.json`，但**模型配置已移除**（提升为系统级别，见下文）：

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
  "status": "ready",
  "lastGeneratedAt": "2026-07-09T01:41:53.000Z",
  "errorMessage": null,
  "themeOverrides": {},
  "userEdits": {
    "savedAt": "2026-07-20T12:00:00.000Z",
    "slideCount": 8,
    "htmlSnapshot": [
      { "index": 0, "heading": "封面标题", "text": "副标题文字" }
    ]
  }
}
```

`status` 取值：`draft`、`generating`、`ready`、`error`。

### 系统级别模型配置 `.ai-ppt-config.json`

保存在项目根目录，对所有项目生效：

```json
{
  "modelConfig": {
    "presetId": "volc-ark-doubao-seed-2.0-lite",
    "provider": "openai",
    "baseUrl": "https://ark.cn-beijing.volces.com/api/coding/v3",
    "model": "doubao-seed-2.0-lite"
  }
}
```

优先级：环境变量 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` > `.ai-ppt-config.json` > 内置默认。API Key 不写入该文件。

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

## 演讲者模式与创作工具

- 演讲者模式：放映页 `Shift+S`（小写 `s` 是缩略图侧边栏）打开演讲者窗口；`.speaker-note` 元素在放映中隐藏、被提取为备注；窗口含下一页预览与计时器，随翻页同步。
- 主题覆盖：`POST /api/projects/:name/theme-overrides` 注入 `<style id="theme-overrides">`（变量白名单见 server.mjs `ALLOWED_THEME_VARS`），持久化于 `ai-ppt.json.themeOverrides`；重新生成会覆盖 index.html，需重新应用。
- 组件库：`POST /api/projects/:name/component` 把 slide HTML 插入倒数第二页；Web UI「组件」标签内置 8 种预制组件。
- 新动画：`anim-zoom` / `anim-blur` / `anim-flip`，与 `anim-fade`/`anim-slide`/`anim-bounce` 同模式，均已加入 `prefers-reduced-motion` 兜底。

## 可视化编辑与用户编辑保护

- **编辑模式**：Web UI 采用「顶部工具栏 + 左侧可折叠项目列表 + 中间大画布预览 + 右侧属性面板」布局。点击预览区或顶部工具栏的「编辑模式」后，父页面通过 `postMessage` 向 iframe 发送 `ai-ppt:edit-start`；`ai-ppt-base/js/ppt.js` 接收后为 `.slide` 内文本元素开启 `contenteditable`，并显示底部浮动保存/取消工具条。
- **保存编辑**：点击保存后，iframe 向父页面发送 `ai-ppt:edit-saved` 并携带 `document.documentElement.outerHTML`；Web UI 调用 `POST /api/projects/:name/save-edits`，由 `scripts/save-edits.mjs` 写回 `index.html`（保存前自动快照），重新注入 `themeOverrides`，并在 `ai-ppt.json` 中写入 `userEdits`。
- **取消编辑**：点击取消时 iframe 发送 `ai-ppt:edit-cancelled`，并通过 `DOMParser` 恢复原始 DOM。
- **AI 约束**：`generate-deck.mjs` 与 `chat-modify.mjs` 读取 `cfg.userEdits`，在 prompt 中列出用户编辑过的每页标题与文本摘要，要求 LLM 在重新生成或修改时保留这些幻灯片的文字、观点和数据。CLI 驱动（`npm run generate`、`npm run chat-modify`）同样受此约束。
- **键盘处理**：编辑模式下 `ai-ppt-base/js/ppt.js` 禁用放映导航快捷键，避免方向键等干扰文本编辑。

## 放映页标识笔与全屏行为

- **标识笔**：按 `M` 开启/关闭；开启后鼠标按住拖动可在当前 slide 的 SVG overlay 上圈点。标记按 slide 索引存为 SVG 元素字符串（`state.markerStrokes`），翻页只渲染当前页。工具含画笔/箭头/矩形/圆/椭圆，快捷键 `1/P`、`2/A`、`3/R`、`4/O`、`5/E`，`C` 清除本页，`Esc`/`M` 退出。浮动工具条默认隐藏，仅在标识笔开启时随鼠标活动短暂显示，2 秒无活动自动隐藏；工具条内含快捷键提示文案。
- **全屏隐藏 UI**：进入全屏后帮助面板（`#help`）与缩略图侧边栏（`.sidebar`）通过 CSS `display: none !important` 完全隐藏，且不再响应鼠标活动显示；快捷键 `?` 和 `s` 在全屏下被禁用。主题切换、HUD、全屏按钮仍保留鼠标活动显隐逻辑。

## 导出策略

- **PDF**：服务端 `scripts/export-pdf.mjs` 使用 `puppeteer-core` 自动查找系统 Chrome，逐页截取最终状态后通过 `pdf-lib` 合并为 `projects/<name>/export/deck.pdf`；未找到 Chrome 时回退到浏览器打印（`window.print()` / `@media print`）。
- **PPTX（可编辑文字）**：服务端 `pptxgenjs` 解析 `index.html` 中的 `.slide` 元素，使用 `teal-editorial` 配色与无衬线字体（PingFang SC）生成 `projects/<name>/export/deck.pptx`。
- **PPTX（高清图片）**：`scripts/export-pptx.mjs --image` 使用 Puppeteer 截取每页最终状态（禁用所有动画/过渡），生成 `projects/<name>/export/deck-image.pptx`。
- Web UI 中 `Ctrl+P` / `Cmd+P` 打开导出面板，可下载上述三种产物。

## 备份策略

运行 `npm run backup` 会复制 `projects/`、`skills/`、`web/`、`vault/`、`server.mjs`、`AGENTS.md`、`README.md`、`MEMORY.md`、`package.json` 到 `.backup/<timestamp>/`。重大修改前应先备份。删除或覆盖 vault 笔记时服务端自动备份原文件到 `.snapshots/_vault/<timestamp>/`。

## v1.10.0 新增能力

- **复习内容 → PPT**：`POST /api/vault/review-deck`（body `{type: cards|mistakes, projectName}`）→ spawn `scripts/generate-from-review.mjs`，进度走现有的 `generate/events` SSE；Web UI 卡片/错题集面板有「生成复习 PPT」按钮。
- **AI 修改异步化**：`POST /chat` 立即返回 202，进度经 `GET /api/projects/:name/chat/events` SSE 推送；`chat-modify.mjs` stdout 为 NDJSON（progress/done/error），done 行含 `success/changed/summary`。
- **生成公共模块**：`scripts/generation-common.mjs` 导出 emit/清洗/wrapSlides/userEdits 等公共逻辑，被 generate-deck、generate-from-note、chat-modify 引用。
- **服务端**：默认绑定 `127.0.0.1`（`AI_PPT_HOST` 环境变量可改）；路由表约定字面量路由先于通配符；SSE 先注册 listener 再回放 buffer（计数去重）+ 25s 心跳；`generate/events` 无任务返回 404 不再触发生成；生成/修改冲突返回 409；`readBody` 上限 10MB（413）；三处 NDJSON 子进程管理收敛为 `spawnNdjsonTask()`。
- **Web UI**：测验/错题使用表单 modal（`#exam-modal`/`#mistake-modal`/`#review-deck-modal`）；笔记编辑器在主工作区 `#vault-panel`，不依赖项目选择；卡片导航 `navigateCard(±1)`；星图 `hideAllMainPanels()` + rAF 守卫（`startPhysics/stopPhysics`）；标签配色 `getGraphNodeColor()` 按 hash 取色；Tab 仅在 `.workspace-config` 内拦截；数字键在 modal 打开时禁用。
- **vault 索引**：从根目录 `.vault-index.json` 迁至 `vault/.meta/index.json`（自动迁移旧文件）。


## v2.0.0 知识中枢

**四环闭环**：速记碎片（`vault/fragments/`）→ AI 整理与加权星图 → PPT/配图/视频表现 → 智能测验迭代，测验结果（熟练度、复习记录）反哺星图权重与下一轮组卷选题池。

**新增脚本**

| 脚本 | 职责 |
|------|------|
| `scripts/fragments.mjs` | 碎片 CRUD：id `f-<base36时间戳>-<4位随机>`，Front Matter `tags/created/status`（`inbox`\|`organized`），正文 `#标签` 自动提取去重。 |
| `scripts/organize.mjs` | AI 整理：`buildOrganizeSuggestions()`（LLM 建议，失败降级确定性规则，`degraded` 标记）与 `applyOrganizeActions()`（promote/tag/link/merge/leave，逐条容错）。 |
| `scripts/media-gen.mjs` | 媒体生成：`generateImage/generateVideo`（provider 按 arkcli → bailian → openai 降级，openai 仅生图），`probeMediaProvider()` 探测；视频提交后轮询任务（5s 间隔，5 分钟超时）。 |
| `scripts/generate-from-graph.mjs` | 星图选区生成 PPT：`node scripts/generate-from-graph.mjs <project> <node1,node2,...>`，NDJSON 进度协议同 generate-deck。 |

**新增端点**

| 端点 | 说明 |
|------|------|
| `GET/POST /api/vault/fragments`、`PUT/DELETE /api/vault/fragments/:id` | 碎片 CRUD；`POST /api/vault/fragments/:id/promote`（body `{to: card\|note\|mistake}`）转化。 |
| `POST /api/vault/organize/suggest` / `apply` | AI 整理建议与确认执行。 |
| `POST /api/exams/smart-generate` | 智能组卷：低熟练卡片 + 到期复习卡片 + 历史错题选题池，LLM 变式或降级直选。 |
| `POST /api/media/image` / `POST /api/media/video` | 生图同步返回 `{webPath}`；生视频异步轮询。body `target: 'vault'` → `vault/assets/`，`target: <项目名>` → `projects/<name>/assets/`。 |
| `GET /api/vault/assets/:file` | vault 媒体静态服务。 |
| `GET /api/dashboard` | 首页看板：`{todayFragments, inboxFragments, dueCards, lowMasteryMistakes, recentFragments, counts:{notes, cards, exams, mistakes, projects}}`。 |
| `POST /api/vault/graph/generate-deck` | 星图选区生成 PPT，body `{nodes, projectName}`，进度复用 `generate/events` SSE。 |

**关键契约**

- **promote 字段映射**（`organize.mjs` 的 `promoteFragment()`，与 server.mjs promote 路由一致）：`card` → 标题取首行（去 `#标签`）截 30 字、question 截 80 字、answer 为全文；`note` → 标题取首行截 30 字并剔除不安全字符，重名自动加 `-2/-3` 后缀，正文为全文；`mistake` → question 为全文、`source: 'organize'`。三者 tags 原样继承，成功后碎片状态置 `organized`。
- **weight 计算口径**（`knowledge-graph.mjs`）：节点 `weight = 链接度数（出链+入链）+ mentions`；`mentions` = 节点名在其他笔记/碎片语料中的出现次数（自身笔记不计）；`reviews` = 按 title/tags 匹配到的卡片与错题的复习次数之和；边 `weight = 1 + 两节点名在同一文档中的共现次数`。
- **降级原则**：所有 LLM 能力必须可无模型运行——AI 整理降级为确定性规则（疑问词→promote 卡片、共享标签→merge、有标签→tag、否则 leave）并返回 `degraded: true`；智能组卷降级为「低熟练优先、最近未复习优先」直选；媒体生成按 arkcli → bailian → openai 顺序降级，全失败明确报错；不编造数据。
- **媒体配置**：三组模型 `modelConfig`/`imageModelConfig`/`videoModelConfig` 存 `.ai-ppt-config.json`；apiKey 不落盘，仅请求时临时传入或读环境变量。

## v2.1.0 信息架构

**概念模型**

- **知识库 = 个人资产**：速记碎片 → AI 整理 → 笔记/知识卡片 → 加权星图 → 测验/错题巩固，与任何项目无关。
- **项目 = 一份 PPT 作品**：`projects/<name>/` 的生命周期为流水线四步——**① 选材 → ② 生成 → ③ 修改 → ④ 发布**（导出 PDF/PPTX/单文件 HTML）。Web UI 项目工作区顶部有对应步骤条。
- **选材 = 桥梁**：在项目工作区「选材」标签（原「内容」标签）内从知识库勾选笔记/卡片/碎片/错题，勾选内容汇总为素材文本进入生成；也可直接粘贴文章或填写 URL。

**sourceSelection 字段**（`ai-ppt.json` 新增，持久化项目内知识库选材）

```json
"sourceSelection": {
  "notes": ["笔记名"],
  "cards": ["卡片 id"],
  "fragments": ["f-<base36时间戳>-<4位随机>"],
  "mistakes": ["错题 id"],
  "updatedAt": "ISO 时间"
}
```

四类数组分别存笔记标题、卡片/碎片/错题的 id，均为可选、缺省为空数组；选材面板按此回填勾选状态，「生成复习 PPT」直接把勾选内容汇总为素材文本。

**主区显示规则**

- 有选中项目时，除知识库专属面板 tab（笔记/卡片/碎片/星图/测验/错题等 vault 面板）外，任何 tab 下主区一律显示项目工作区 `#project-panel`；`selectProject` 不得只在 projects tab 下才挂载工作区（v2.1.0 前的回归即由此产生，表现为切 tab 后主区空白）。

**来源 badge 映射**（项目列表「PPT 作品」按 `ai-ppt.json.sourceType` 显示）

| sourceType | badge | 来源入口 |
|------------|-------|----------|
| `url` | 网页 | URL 抓取生成 |
| `article` | 文章 | 粘贴文章生成（默认） |
| `vault-note` | 笔记 | 笔记一键生成 PPT |
| `vault-cards` | 卡片 | 知识卡片生成复习 PPT |
| `vault-mistakes` | 错题 | 错题集生成复习 PPT |
| `vault-graph` | 星图 | 星图选区生成 PPT |

## v2.2.0 双链笔记

借鉴 Obsidian / Logseq 的双链笔记体验，全部逻辑在 `scripts/link-resolver.mjs` / `scripts/vault.mjs` 与 `web/js/modules/`（前端已模块化）。

**新增/变更端点**

| 端点 | 说明 |
|------|------|
| `POST /api/vault/notes/:name/rename` | body `{newName}`；备份到 `.snapshots/_vault/` → fs 重命名 → 级联更新笔记/碎片/卡片中的 `[[旧名]]`（`[[旧名|显示文本]]` 只改链接前半）→ 重建索引；返回 `{ok, newName, updatedRefs}`。脚本侧唯一入口是 `vault.mjs` 的 `renameNote()`。 |
| `GET /api/vault/notes/:name/mentions` | 扫描其他笔记正文与碎片正文中未包 `[[...]]` 的笔记名出现，返回 `{mentions: [{source, snippet}]}`；`source` 为笔记名或 `fragment:<id>`。 |
| `POST /api/vault/notes/:name/link-mentions` | body `{source}`；把该来源中所有未链接出现包成 `[[名字]]`（大小写不一致时用 `[[名字|原文]]` 保留显示文本），返回 `{ok, count}`，随后重建索引。 |
| `GET /api/vault/tags` | 聚合笔记（索引 front matter tags）+ 卡片 front matter 标签 + 碎片标签，返回 `{tags: {tag: {notes[], cards[], fragments[]}}}`。 |
| `GET /api/vault/notes/:name/info` | `backlinks` 结构升级为 `[{name, snippets}]`：同一来源合并为一条，每条 snippet 为链接所在行 ±40 字、去重。 |
| `GET /api/vault/search?q=` | snippet 以首个命中位置为中心截取 ±60 字；仅标题命中时取正文开头 120 字。 |

**渲染管线**（`web/js/modules/` 的笔记预览渲染；现行 11 步管线以 AGENTS.md 第 19 条为准）

整体 `escapeHtml` → PDF 嵌入 `![[x.pdf|N]]` 占位 → 多媒体嵌入占位 → 块引用 `((id))` 占位 → 查询块 `{{query}}` 占位 → `[[wikilink]]` 预处理为 `<a class="wiki-link" data-note="...">`（死链加 `wiki-link-dead`，点击即创建）→ 恢复行首 `&gt;` 引用块 → 任务标记/`key:: value` 内联替换 → `marked.parse()` → 占位换回 HTML → 异步填充块引用/查询，并给 h1-h3 加大纲锚点 id（供 TOC 跳转）。marked 以 vendor 文件放在 `web/js/vendor/marked.umd.js`。管线顺序不可调换：先转义保证 XSS 安全，wikilink 等预处理必须在 marked 之前。

**数据口径**

- 入链：索引 `backlinks[target]` 为 `[{source, snippets}]`，snippet 取链接所在行 ±40 字并去重；`info` 端点映射为 `[{name, snippets}]`。
- 未链接提及：先把 `[[...]]` 区域整体打码再做大小写不敏感匹配，排除自身笔记与 front matter 区域；碎片语料为剥离 front matter 后的正文。
- 每日笔记：`journal-YYYY-MM-DD`，自动创建 Front Matter 为 `type: journal`、`tags: [日记]`；碎片附加以 `- HH:MM 内容` 追加到正文末尾并置 `organized`（前端 `appendFragmentToToday()`，复用 `PUT /api/vault/notes/:name` 与 `PUT /api/vault/fragments/:id`，无专用端点）。

## v2.3.0 设置区与 AI 对话强化

**系统设置面板**

- Web UI 新增独立「设置」区：三组模型配置（`modelConfig` / `imageModelConfig` / `videoModelConfig`）从项目「选材」tab 提升到系统级设置面板，复用现有 `GET/POST /api/config`（apiKey 不落盘）与 `POST /api/media/test` 探针；项目内各 tab 不再重复放置模型配置入口。
- 设置面板内置数据备份入口：`POST /api/backup` 调用 `scripts/backup.mjs` 的 `runBackup(label)`，成功返回 200 `{dir}`。

**笔记 AI 对话修改**

| 端点 | 说明 |
|------|------|
| `POST /api/vault/notes/:name/chat` | body `{instruction, apiKey?}` → 202 `{message:'修改已启动'}`；进行中 409 `{error:'该笔记正在修改中'}`。 |
| `GET /api/vault/notes/:name/chat/events` | SSE 进度推送；无任务 404 `{error:'没有进行中的修改'}`。 |

- 脚本：`node scripts/chat-note.mjs <note-name> <instruction>`，stdout NDJSON（progress + done`{success,changed,summary}`/error），协议与 `chat-modify.mjs` 一致，服务端复用 `spawnNdjsonTask()` 管理子进程。
- 修改前自动备份原笔记到 `.snapshots/_vault/<timestamp>/`；prompt 要求 LLM 保留 Front Matter 与 `[[wikilink]]`，失败时不改动文件（备份可回滚）。

**PPT 对话历史持久化**

- 「AI 修改」聊天记录持久化到 `projects/<name>/chat-history.json`，格式 `{messages: [{role: 'user'|'assistant', content, time}]}`，最多保留 50 条。
- `GET /api/projects/:name/chat/history` 返回该结构（无文件时 `{messages: []}`），聊天面板加载时回填，刷新页面不丢历史。

## 依赖

- `cheerio`：HTML 解析（内容提取、生成时清洗、PPTX 导出）。
- `pptxgenjs`：PPTX 生成。
- `puppeteer-core`：服务端 PDF 与高清图片 PPTX 导出。
- `marked`：笔记 Markdown 预览渲染（vendor 文件 `web/js/vendor/marked.umd.js`，v2.2.0 新增）。
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
