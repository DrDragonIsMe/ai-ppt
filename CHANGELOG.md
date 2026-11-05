# 更新日志

本文件记录 ai-ppt 的版本历史。现行有效约定见 AGENTS.md。

## v2.9.0 — 素材库 → 营销大纲 → 批量 PPT（2026-11）

> `package.json` 的 `version` 与 `web/sw.js` 的 `CACHE_VERSION` 均已对齐 2.9.0。

### 多数据源素材库

- 四种源类型 `dir / url / site / vault`（`scripts/sources/registry.mjs` 的 `SOURCE_TYPES`）。注册表 `sources.json`（已 gitignore），抓取缓存 `vault/.meta/source-cache/<sourceId>/`（`manifest.json` + `items/<itemId>.md`，已 gitignore）。
- 增量刷新：同一 origin 的 itemId 稳定（`<sourceId>--<12位sha256hex>`），hash 未变的条目不重写，上游消失的条目在整批成功后清理（`scripts/sources/refresh.mjs`）。
- 默认参数物化：`maxPages=30`、`maxBytesPerItem=512KB`、`depth=1`（site），`dir` 默认仅收文本类，`vault` 仅 `**/*.md`。`maxPages` 截断、部分失败 stale 保命、安全清单跳过均通过 SSE 事件与 `GET /api/sources` 可观测。
- 安全红线：禁入目录段 `.git/.backup/.snapshots/node_modules`；敏感位置/文件名拒绝清单（`.ssh/.aws/.docker/.config`、keychain、`/etc`、`/var/root`、`.env*`、`*.pem/key`、credentials、`.ai-ppt-config.json`、`.ai-ppt-tasks.json` 等）；词法路径与 `realpath` 双重检查，仅文本类条目入库。越 ROOT 外部目录授权改为**配置文件优先**（`sourcesConfig.allowExternalPaths`，默认 false）+ `AI_PPT_ALLOW_EXTERNAL_SOURCES` 三段式强制覆盖（显式真值强制开 / 显式 `0|false|no` 强制关 / 未设看配置文件），另需 `acknowledgeExternalPath:true`，刷新时授权重查。dir/vault 根级不可读时响亮 reject 500，不写 manifest、不动磁盘条目。
- 低相关页过滤（M17/M20/M21）：site/url 源入库前丢弃登录墙、404 栏目页、口号式营销页；判定顺序为「强信号标题（登录/法务封闭词干 + `404|403`+纯栏目名封闭准入表）→ 白名单短路 → 标题/URL 黑名单 → 品牌口号 → 登录墙正文」。`lowRelevanceSkipped`/`lowRelevanceSamples` 全链路透出，`options.skipLowRelevanceCheck` 可关闭。设计边界：正文厚实的站点首页/营销页与表外栏目别名不拦。
- prune 熔断（B091300）：兜底清理比例超 `sourcesConfig.pruneGuardRatio`（默认 0.2）时一条不删、转 stale 并告警 `prune-blocked`；confirmed-gone 不受影响；`sourcesConfig.pruneGuard:false` 关闭。
- 测试隔离修复：`AI_PPT_CONFIG_PATH` 可重定向全局配置路径；此前 M19 测试用 `process.cwd()` 定位并在 beforeEach 删除该文件，导致在仓库根跑 `npm test` 会删掉真实全局配置，已修并加两条守卫用例。
- HTTP 端点：`GET/POST /api/sources`、`PUT/DELETE /api/sources/:id`、`POST /api/sources/:id/refresh`、`GET /api/sources/:id/refresh/events`、`GET /api/sources/:id/items`、`GET /api/sources/items`、`POST /api/sources/preview`；错误枚举 `{400,403,404,409,500}`，全局并发上限 2 → 429。

### 营销大纲与批量生成

- 大纲产物 `marketing/outlines/<mo-<base36>>.json`，契约形状：`{id,title,createdAt,sourceIds,angleSet,product,angles:[{key,title,thesis,audience,evidenceItemIds,slides[{heading,lead,points,evidenceItemIds}],deckName,generatedBy}]}`。
- 内置角度集 `marketing-standard`（`scripts/marketing/angles.mjs`）：客户痛点 / 产品能力 / 行业场景 / 差异化竞争 / ROI 价值 / 成功案例与落地路径，6 个角度 thesis 互不重复。
- 大纲生成：`POST /api/marketing/outline` 202 + SSE `/api/marketing/outline/events`；CLI `scripts/marketing/generate-outline.mjs`。流程：多源素材汇总 → 分档摘要 → 逐角度 LLM（并发 1）→ 契约校验 → 落盘。无 LLM 时走确定性兜底，`done` 事件如实报告 `llmUsed/llmFailed/llmShortCircuited/llmReason/fallbackOnly`。
- 防编造校验：`evidenceItemIds` 只能引用素材库真实条目，伪造引用被剔除并计数（`outline.material.droppedEvidenceCount`）。
- 批量生成：`POST /api/marketing/batch` 202 + SSE `/api/marketing/batch/events`；CLI `scripts/marketing/batch-generate.mjs`。逐角度串行，单 deck 失败不阻断整批；全局同时只允许 1 个大纲与 1 个批次（重复 409）；`POST /api/marketing/batch/cancel` 取消。生成 `projects/mkt-<angleKey>-<slug>/`，`ai-ppt.json.sourceSelection.kind='outline'` 双向绑定，`userEdits` 保留，自动 lint + 封面截图。批次快照存 `marketing/batches/<mb-<base36>>.json`。

### 产物策略与文档

- 明确不入 git：生成物目录 `export/`、`cover.png`、`marketing/`、`vault/.meta/source-cache/`、`references/`、`sources.json`、`.ai-ppt-tasks.json`、`.ai-ppt-config.json`，以及所有视频文件 `*.mp4 / *.mov / *.m4v / *.webm / *.avi`。`projects/*` 整体由 `.gitignore` 排除。
- 有意保留的例外：`demo/` 封面是 GitHub Pages 部署源；`web/icons/` 是 PWA 源资源。
- 回归护栏：`tests/artifact-policy.test.mjs` 7 条断言覆盖视频、生成物目录、Pages/PWA 图标、node_modules 软链、已跟踪路径不被 ignore 规则命中等。
- `AGENTS.md` 新增「多数据源素材库」「营销大纲与批量生成」「产物与素材入库策略」三条核心约定；`README.md` / `README.en.md` 新增工作流章节、刷新目录结构图、新增 `/ppt-sources` 与 `/ppt-marketing` skill；测试入口统一为 `node --test tests/*.test.mjs`（当前基线 364 pass / 0 fail / 106 suites）。

## v2.8.1 — Web UI i18n（2026-07）

- **英文界面**：新增轻量 i18n（`web/js/modules/i18n.mjs`，中文原文即 key，`t(key, vars?)` 缺 key 回退中文 + 去重 console.warn；语言存 localStorage `ai-ppt-lang`，未设置按 navigator.language 探测；`setLang()` 后 reload 生效）；语言包 `web/js/i18n/zh.mjs`（恒等兜底）与 `web/js/i18n/en.mjs`（739 key 全量翻译）。
- **覆盖**：index.html 静态文案 450 处 `data-i18n(-placeholder/-title/-aria)` 打标（启动时 `applyStaticI18n()` 批量替换，zh 模式恒等）；vault/fragments/projects/generate/modals/app/state 模块动态文案全部走 `t()`；cards/exams/graph 深埋文案暂留中文（en 模式降级显示原文）。
- **设置面板**新增「界面语言」下拉（中文/English，切换即生效）；生成参数风格下拉加稳定 `value` 属性（翻译只影响显示不影响提交值）；sw.js 预缓存新增 i18n 三个文件。

## v2.8.0 — 产出链路、主题生态与易用性深化（2026-07）

### 产出

- **真实数据图表组件**：`chart-line`（折线/面积/多序列）、`chart-pie`（饼/环图）、`chart-bars`（分组/堆叠柱），slide 内 `data-chart` JSON 声明、ppt.js 渲染为静态 SVG（零依赖、打印/缩略图/导出天然正确、配色走 `--chart-1..6` 主题变量）；生成 prompt 类清单同步，LLM 可直接产出图表页。
- **发布产品化**：项目工具栏「发布」按钮 + `#publish-modal`（完整链接/复制/局域网 IP 链接/二维码，`qrcode` 本地生成）；版本化发布 `published/<name>/vN/` + `latest` 软链；「静态站点包 ZIP」导出（`archiver`）。
- **Deck → 视频**：`scripts/export-video.mjs`（puppeteer 逐页 1280×800 + ffmpeg 合成 mp4，每页默认 4s，ffmpeg 缺失降级为逐帧 PNG），任务化接入导出下拉（202 + SSE，计入 puppeteer 并发上限）。
- **设计质量护栏**：`scripts/design-lint.mjs` 9 条规则（大数字超 4/标题/渐变文字/空页/眉毛滥用/疑似占位数据/版式单调/密表/图片缺失），生成与 chat-modify 后自动 lint 发 NDJSON 事件；`GET/POST /api/projects/:name/design-lint(/fix)` + 前端「设计检查」按钮，gradient-text 可一键自动修复。
- **配图闭环**：生成配图结果区新增「插入笔记」（光标处插入 `![[name]]`）与「插入幻灯片」（`POST .../insert-image`，vault 资产自动复制进项目、默认新建 `.two-col` 图片页、写前快照+索引刷新）；视频资产生成 `<video>` 页。
- **vault 资产管理**：`DELETE /api/vault/assets/:name`（被引用 409 + 引用方列表，`?force=true` 强删）；「资产库」modal（缩略图/大小/引用徽标/插入/删除）；启动清理 `.tmp/` 孤儿 .part。
- **场景模板**：`templates/` 4 个标杆模板（周报/培训课件/路演/复习课件，全部通过 design-lint 零问题），新建项目可选模板（`POST /api/projects` 支持 `template` 字段）。
- **主题画廊**：theme-showcase.html 改为从 themes.json 自动渲染（补 `desc`/`mode` 字段），Web UI「主题画廊」modal iframe 嵌入、点选即应用（postMessage）。
- **项目封面**：`captureCover()` 生成 480×300 cover.png（生成与 PDF 导出后自动更新），PPT 作品列表显示封面缩略图。

### 易用性

- **撤销/重做**：笔记编辑器自定义 undo/redo 栈（500ms 输入合并、程序化修改独立入栈、100 步上限）；笔记「历史版本」modal（`GET .../backups` + `POST .../restore-backup`，恢复前自动备份当前版）；笔记与 PPT 的 AI 修改完成后显示「撤销本次修改」按钮。
- **批量操作与拖拽**：笔记多选支持批量删除/批量打标签（服务端统一 FM 解析保持格式）；笔记列表 HTML5 拖拽排序（顺序持久化 `vault/.meta/note-order.json`）。
- **新手引导**：首次启动 3 步向导（记录 → 生成 → 导出与发布，localStorage 记忆，帮助面板可重放）；帮助面板按场景重组（我想做 PPT/整理笔记/复习）+ 快捷键清单与实际绑定对齐。
- **移动端底线可用**（≤768px）：侧边栏汉堡抽屉、语音 modal 全屏、笔记上下堆叠、面板单列、零横向溢出——速记/语音听记/笔记阅读手机上可用。
- **截图管线修复**：`captureSlideFrames`（export-pdf/video 共用）补齐 UI 铬件隐藏与动画终态强制可见，PDF/视频不再带入侧边栏与空白页。

### 推广

- **README 双语 + 元数据**：新建 `README.en.md`、中英互链、badges（版本/license/node/tests）、keywords/description 补全、新建 `LICENSE`（MIT）与 `CONTRIBUTING.md`。
- **npm 安装向导**：install-skills.js 重写（CLI 检测含 Claude Code、`--dry-run`/`--uninstall`/`--guide`、幂等、装完打印快速上手）；`npm run intro`。
- **Demo 站点**：`demo/`（产品落地页 + 3 个单文件演示 deck + 封面）+ `.github/workflows/pages.yml`（GitHub Pages 自动部署，需仓库设置开启）。
- **自产素材**：`projects/ai-ppt-intro` 产品介绍 deck（LLM 生成 + 人工标杆化修订）→ `docs/marketing/demo.gif`（30s，README 嵌入）；`docs/marketing/` 三篇场景文案（HR 培训/错题复习/会议汇报，功能路径与 UI 文案逐字核对）。

### PWA

- **安装到桌面**：`web/manifest.webmanifest`（standalone、teal 主题色、192/512 PNG 图标，源 `web/icons/icon.svg` 经 puppeteer 导出）+ index.html head 注入 manifest/theme-color/icon/apple-touch-icon；帮助面板 footer 增加安装指引。
- **Service Worker 离线壳**：`web/sw.js` 版本化 cache（`ai-ppt-v<version>`，activate 清旧版本，skipWaiting + clientsClaim）；静态壳 cache-first 预缓存（含 `web/js/modules/*` 与 `vendor/marked.umd.js`），导航 network-first 离线回退缓存壳，`/api/` 离线返回 503 自定义 JSON（不做数据离线化），`/projects/`、`/published/`、`/base/` network-first + 运行时缓存副本；app.mjs 启动时注册（仅 https/localhost，失败静默）。server.mjs MIME 表新增 `.webmanifest`。

## v2.7.0 — 底层架构加固（2026-07）

### 基础模块

- **Front Matter 统一解析**：新增 `scripts/front-matter.mjs`（`parseFrontMatter`/`stringifyFrontMatter`/`splitFrontMatter`），支持标量、行内/多行数组、多行字符串（`|`/`>`）、值含冒号、引号内逗号；替换 vault/store/fragments/knowledge-cards/knowledge-graph/chat-note/link-resolver 共 7 处 naive 解析器。
- **写盘原子化**：新增 `scripts/fs-utils.mjs`（`writeFileAtomic`/`writeJsonAtomic`，同目录临时文件 + fsync + rename），替换 16 处直接 `writeFileSync` 写盘点（config/global-config/vault index/卡片/测验/chat/save-edits/media-gen 等），崩溃不再留下截断 JSON。
- **流式上传**：`POST /api/vault/assets` 前端改 `FormData` multipart（`scripts/multipart.mjs` 零依赖流式解析器，文件写 `.tmp` 不驻留内存，校验过 rename 入库，失败清理；超限 413），80MB 文件上传峰值内存从约 449MB 降到 4-40MB；base64 JSON 保留兼容回退。

### 性能

- **vault 增量索引**：`link-resolver.mjs` 的 `rebuildIndex` 改为 mtime 驱动（`_version` 结构版本控制），只重解析变化文件、剔除已删文件，无变化零写盘；`deriveIndex`/`getNoteInfo` 预建 Map 消除 O(n²)；`searchNotes` 走索引缓存免全量读盘；笔记/碎片列表接口加可选 `?limit=&offset=` 分页（不传参行为不变）。
- **全局搜索**：`search.mjs` 重写为倒排索引（前缀匹配 + substring 回退），`invalidateSearchIndex(name)` 语义改为「单项目重建」（修复生成/修改后项目从搜索消失的 bug）；chat/save-edits/新建项目后自动刷新。

### 生成与导出

- **生成管线收敛**：5 个 `generate-*.mjs` 共用 `generation-common.mjs` 分层管线（`buildSlidesPrompt` → `generateSlidesHtml` → 参数化 `buildFallbackSlides` → `writeDeckIndex`），删除 4 份各异兜底模板与重复 LLM 调用代码。
- **主题自动注册**：单一数据源 `ai-ppt-base/themes.json`，`wrapSlides` 动态生成主题 `<link>`，`upgrade-decks` 幂等刷新基座 `theme-links` 区块；新增主题 = themes.json 加一条 + 一个 css 文件 + `npm run upgrade-decks`。
- **chat-modify 局部编辑**：LLM 只返回修改页（`=== slide N ===`/`=== slide new ===`），cheerio DOM 级合并保留未修改页与模板外定制；超 15 页只放指令相关页 + 上下文；解析失败回退旧整页重写路径。
- **导出异步化**：PPTX/图片 PPTX/PDF 导出任务化（202 + SSE NDJSON，done 带 `downloadUrl`），同项目同类型 409 防重、puppeteer 全局并发上限 2（超出 429）；导出视口与 PDF 页面统一 1280×800。
- **打印路径修复**：两个 `@media print` 块合并，`@page 1280px 800px margin 0` 每页正好一张 slide 无空白页；progress-ring/waterfall 等动画组件打印时纯 CSS 渲染终态；幻灯片缩放基准统一 1280×800。

### 任务系统

- **统一任务注册表**：新增 `scripts/task-registry.mjs`（`createTaskRegistry`），媒体任务与解析任务从分散的 in-memory Map 迁到共享实现（create/get/update/complete/fail/cancel），内存 Map + 节流落盘到根目录 `.ai-ppt-tasks.json`（writeJsonAtomic，已 gitignore）；NDJSON 类任务（generate/chat/note-chat/export）的元信息（kind/name/status/起止时间）同样写入注册表。
- **重启恢复**：服务启动时 `load()` 加载任务文件，所有活跃态任务标记 `interrupted`（带「服务已重启，任务中断，请重试」文案）；轮询端点对已知任务返回真实状态，对未知 id 返回 404 + `{status:'unknown'}`；interrupted 的 NDJSON 任务回填为合成 state，`GET .../events` 回放明确错误事件后收尾而非挂起。
- **取消能力**：新增 `POST /api/media/tasks/:id/cancel` 与 `POST /api/vault/assets/parse-tasks/:id/cancel`；HTTP 等待型任务标记 cancelled 后忽略迟到结果（complete/fail 不覆盖终态）；前端视频生成进度区加「取消」按钮。
- **spawnNdjsonTask 加固**：事件 buffer 上限 500 条（`pushBounded` 丢最旧，防 stderr 洪峰撑爆内存）；同名任务覆盖前向旧 SSE 连接推 `{type:'error', message:'任务已被新任务取代'}` 并断开。
- **前端**：`api()` 抛错携带 `err.status`/`err.data`；碎片解析与视频生成轮询识别 interrupted/unknown/cancelled 后停止轮询并提示「服务已重启，任务中断，请重试」，不再无限转圈。

### 结构重构

- **routes/vault.mjs 按域拆分**：1100 行单文件拆为 `vault-commons`（共享辅助）+ `vault-notes` / `vault-fragments` / `vault-assets` / `vault-learn` / `vault-graph` 五个域模块，`routes/vault.mjs` 变为 35 行薄聚合入口；63 条路由的 (method, pattern) 序列拆分前后逐项 diff 一致，行为零变化。
- **DI 装配收敛**：server.mjs 依赖按域分组成 4 个命名 deps 对象，启动时 `assertDeps` 校验必需键（vault 46/config 7/media 14/projects 31），缺失启动即报错；清理 exportPptx/exportPdf 死注入。

---

## v2.6.0 — 易用性修复与信息架构收拢（2026-07）

### 易用性修复

- **笔记保存机制**：`Ctrl+S` 按上下文分派（vault tab 且打开笔记 → 保存笔记；项目工作区 → 保存项目配置）；2 秒防抖自动保存、脏标记（标题与保存按钮显示 ●）、beforeunload 防丢、localStorage 草稿（key `ai-ppt-note-draft:<name>`，打开笔记时提示恢复）。
- **原生弹窗清零**：新增 `web/js/modules/modals.mjs`（`showInputModal`/`showConfirmModal`，Promise 风格），全站原生 `prompt()`/`confirm()` 替换完毕。
- **empty-state** 改为笔记中心引导（+ 新建笔记 / 写速记），初始 hidden。
- **笔记工具栏**收为「保存 + 生成 PPT + ⋯更多」下拉（重命名/预览/大纲/生成配图/附件/AI 修改/删除进下拉）。

### 信息架构收拢

- **「生成 PPT」入口统一**：`web/js/modules/generate.mjs` 的 `#gen-modal` + `openGenerateModal(source)`，`source.kind ∈ note|notes|graph|review`，后端 API 不变；旧 `#note-gen-modal`/`#graph-deck-modal` 删除。
- **导出单入口**：项目工具栏 `#export-dropdown` 一个入口（PPTX / 高清图片 PPTX / 浏览器打印 PDF / 单文件 HTML），`Ctrl+P` 展开；actions-bar 导出按钮与 `#export-modal` 删除。
- **侧边栏「学习」tab**：测验/错题集/复习训练三 tab 合并为 `data-tab="study"` 的 `#study-panel`（二级子 tab exams/mistakes/training，`S.studySubtab` 记忆）；侧边栏设置 tab 移除，顶栏齿轮为唯一设置入口。

### 底层修复

- **搜索索引**：`invalidateSearchIndex(name)` 语义从「移除」改为「单项目重建索引」，生成/chat/save-edits 后索引自动刷新；仅删除项目时才真正移除。
- **快照治理**：`scripts/snapshot.mjs` 常量 `SNAPSHOT_KEEP = 20`（create 后自动 prune，CLI 新增 `prune <name>`）；`restoreSnapshot` 覆盖前自动建安全快照；`scripts/vault.mjs` 常量 `VAULT_BACKUP_KEEP = 200` + `pruneVaultBackups()`（server.mjs `backupVaultNote()` 亦调用）；均有 isSafeName/路径防注入。
- **死代码清理**：`web/js/web.js`、`scripts/build-fonts.mjs` + `ai-ppt-base/fonts/`、`generate-deck.mjs` 的 `chunkText` 删除；server.mjs 经核查无死代码。
- **测试脚本**：`npm test` → `node --test tests/core.test.mjs`，新增 `npm run test:smoke` → `node scripts/test-smoke.mjs`。

---

## 迁移历史（自 AGENTS.md 迁入）

- v1.5 曾将 CSS/JS 内联到 `index.html`，后因升级维护困难 revert 回分离结构。
- v1.6 引入 `projects/` 目录，统一存放业务 deck，并新增 `scripts/upgrade-decks.mjs` 同步基座引擎到所有项目。
- v1.7 新增 Web 管理界面（`web/` + `server.mjs`）、URL/文章内容自动生成管线、PPTX/PDF 导出 skill、项目备份脚本。
- v1.7.1 高清图片 PPTX 导出禁用动画以截取最终状态；修复 `.two-col > .visual-card` 在可编辑 PPTX 中缺失内容；PDF 导出支持自动查找 Chrome；支持 `.env.kimi` 配置 Kimi Code。
- v1.7.2 全面对齐 `teal-editorial` 配色（ink #151A19 / cream #FAFAF7 / tile #EDF1F0 / tile-strong #E3E9E7 / teal #00B498 / navy #0B1413）；标题改为衬线、字重 400；PDF 导出改为逐页截图并合并，输出完整多页 PDF；可编辑 PPTX 同步更新配色与字体。
- v1.7.3 新增模型配置 `modelConfig`（预设 / Base URL / Model / API Key），Web UI 加载模型列表，默认 `kimi-code`；teal 情绪色改为 `#439288`；新增 `/ppt-list` 与 `/ppt-delete` skill。
- v1.7.4 引入 GitHub 设计 skill（impeccable + taste-skill）的蒸馏版 `/ppt-design`；`generate-deck.mjs` prompt 内置反模板化设计规则，兜底模板去除硬编码文案与编造数据；基座标题增加 `text-wrap: balance`、新增 `prefers-reduced-motion` 兜底；`progress-ring` 支持直观的 `--progress-pct` 百分比（旧 `--progress` dashoffset 写法保持兼容）；`.gradient-text` 标记弃用（保留兼容）；演示 deck 数字页改用标准 `split-visual` + `hero-stat`；修复 `ppt.js` 初始化时用 localStorage/默认主题覆盖 `<body>` 上硬编码 `theme-*` 类的问题——现在 `ai-ppt.json` 的 `theme` 字段在页面加载后真正生效。
- v1.7.5 修复全屏时左上角帮助面板（`#help`）等悬浮 UI 常驻遮挡内容的问题：原实现用 `:fullscreen:hover` 控制显隐，鼠标只要停留在页面上 UI 就一直可见。改为 JS 无活动检测——全屏下默认隐藏帮助面板/主题切换/HUD/全屏按钮，`mousemove`/`touchstart` 时通过 `<html>.fs-ui-visible` 短暂显示，2 秒无活动后自动淡出；进入和退出全屏时重置该状态。
- v1.7.6 修复 ↑ 预览（overview）缩略图全空白的 bug：克隆的 `.slide` 继承了基座规则的 `opacity: 0` 和视口相对 padding，旧的 `.slide-content scale(0.22)` 缩放方案因此失效。改为在 `buildOverview()` 中把克隆节点按固定 1280×800 设计尺寸布局后整体 `scale()` 进卡片，缩略图与真实页面一致；同时让 `progress-ring` 与 `waterfall` 组件在缩略图中渲染终态（动画只在 `.slide.active` 上播放）。
- v1.8.0 大规模功能升级：① 帮助面板分组重设计（导航/视图/导出），Web UI 增加完整快捷键系统（`?`/`Ctrl+N`/`Ctrl+S`/`Ctrl+P`/`Ctrl+G`/`Ctrl+O`/`Ctrl+K`/`1-9`/`Tab`/`Esc`）与帮助面板；② LLM 多后端：`llm-adapter.mjs` 支持 LM Studio 本地模型（`http://localhost:1234/v1`，自动列出已加载模型）与任意 OpenAI 兼容远程端点，Web UI 模型预设新增 `lmstudio` 并可「刷新列表」拉取远程模型；③ 全局搜索：`scripts/search.mjs` + `GET /api/search` + 顶栏搜索框；④ 快照/版本管理：`scripts/snapshot.mjs`（`.snapshots/<name>/<id>/`）+ 快照 API + Web UI「版本」标签；⑤ Markdown 导入：内容面板一键导入 `.md/.txt`；⑥ 对话式修改：`scripts/chat-modify.mjs` + `POST /api/projects/:name/chat` + 预览区「AI 修改」聊天面板，修改前自动快照；⑦ 放映页新增可收起的缩略图导航侧边栏；⑧ `generate-deck.mjs` / `config.mjs` 的模板 HTML 同步新版帮助面板。
- v1.8.1 演讲者模式与创作工具：① 演讲者模式 `Shift+S`（`s` 已被缩略图侧边栏占用）打开演讲者窗口——`.speaker-note` 备注提取、下一页预览、计时器，窗口随翻页同步；② 新动画 `anim-zoom`/`anim-blur`/`anim-flip`，Web UI 动画面板同步可选；③ 可视化主题编辑器：`POST /api/projects/:name/theme-overrides` 注入 `<style id="theme-overrides">` 并持久化 `ai-ppt.json.themeOverrides`（白名单变量见 server.mjs `ALLOWED_THEME_VARS`）；④ 组件库：`POST /api/projects/:name/component` 将预制 slide 插入倒数第二页，Web UI「组件」标签提供 8 种组件；⑤ 单文件 HTML 导出 `scripts/export-single-html.mjs`（内联本地 CSS/JS）+ `POST /export/html` + 导出面板按钮。
- v1.8.2 可视化编辑、AI 约束与 Web UI 重设计：① Web UI 预览区新增「编辑模式」，iframe 内 `contenteditable` 直接改字，`POST /api/projects/:name/save-edits` 持久化；② `ai-ppt.json.userEdits` 记录用户编辑，`generate-deck.mjs`/`chat-modify.mjs` prompt 要求 LLM 保留；③ Web UI 改为「顶部工具栏 + 左侧可折叠项目列表 + 中间大画布 + 右侧属性面板」布局；④ 顶部工具栏新增导出下拉菜单；⑤ `scripts/test-smoke.mjs` 覆盖 save-edits；⑥ 模型配置提升为系统级别 `.ai-ppt-config.json`，切换项目不再变化；⑦ 全屏下隐藏帮助面板与缩略图侧边栏；⑧ 新增按页标识笔（`M` 快捷键，圈点保存在当前 slide 的 SVG overlay，非全局）。
- v1.9.0 通用化改造与安全加固：① 学习场景命名普适化（试卷→测验、错题本→错题集、知识点卡片→知识卡片、学科/科目→分类、掌握度→熟练度、训练模式→复习训练），仅改用户可见文案，API 路径与数据字段名（`subject`/`mastery`）保持不变；② 所有 API 路由的 `:name`/`:id`/body 字段统一经 `isSafeName()` 白名单校验（拒绝 `/`、`\`、`..`），vault 脚本层（vault/knowledge-cards/exam-papers）同步加纵深防御；③ 修复双重 `decodeURIComponent`、`/api/exams/stats` 路由被遮蔽、204 带 body、CORS 缺 PUT/DELETE；④ Web UI 修复 toast 未定义（42 处）、switchSidebarTab 重复定义、保存笔记丢 Front Matter、prompt 取消误创建、多处 XSS 转义遗漏；⑤ 新增笔记删除入口与复习训练中途退出；⑥ `generate-from-note.mjs` 主题/动画参数生效、知识星图 tags 兼容数组格式、静态路由项目名支持中文。
- v1.10.0 数据安全、体验升级与架构加固：① `npm run backup` 纳入 `vault/`，删除/覆盖笔记自动备份到 `.snapshots/_vault/`；② 复习内容→PPT 闭环：`POST /api/vault/review-deck` + `scripts/generate-from-review.mjs`，知识卡片/错题集一键生成复习课件；③ AI 修改异步化：`POST /chat` 返回 202 立即响应，`GET /chat/events` SSE 推送进度，`chat-modify.mjs` stdout 改 NDJSON 协议；④ 测验/错题的连续 `prompt()` 改为页面内表单 modal；⑤ 笔记编辑器移出项目配置面板，不选项目也可用知识库；卡片上/下一张导航，评级不跳回；⑥ 服务端默认绑 `127.0.0.1`（`AI_PPT_HOST` 可改）、路由「字面量先于通配符」约定、SSE 竞态修复+心跳、generate/events 去副作用、生成/修改 409 并发防护、readBody 限 10MB；⑦ 新增 `scripts/generation-common.mjs` 收敛三个生成脚本的公共逻辑；⑧ 星图面板重叠/rAF 叠加修复、标签配色 hash 泛化、Tab/数字键误触修复、AI 扩展精简 prompt、vault 索引迁至 `vault/.meta/index.json`、`exam-papers.mjs` 补 CLI、vault 新增办公示例。
- v2.0.0 个人知识中枢：① 速记碎片 `vault/fragments/`（`#标签` 自动提取、`Ctrl+Shift+N` 速记、promote 转化为卡片/笔记/错题）；② AI 整理（`/api/vault/organize/suggest|apply` 建议+确认，无 LLM 降级为确定性规则）；③ 加权星图（节点 `weight`=链接度数+被提及次数、`mentions`、`reviews`，支持「只看高频」）；④ 智能组卷（`/api/exams/smart-generate`，低熟练/到期/错题选题池，LLM 变式或降级直选）；⑤ 三组模型配置（文本/生图/生视频，arkcli/bl/OpenAI 兼容，apiKey 不落盘）；⑥ 媒体生成（`/api/media/image` 同步、`/api/media/video` 异步轮询，产物入 `vault/assets/` 或 `projects/<name>/assets/`）；⑦ 星图选区一键生成 PPT（`/api/vault/graph/generate-deck` + `scripts/generate-from-graph.mjs`，复用 generate/events SSE）；⑧ Dashboard 首页（`GET /api/dashboard`）；⑨ 知识卡片答案解析修复、vault 索引迁移。
- v2.1.0 项目概念与信息架构升级：① 修复选中项目后切到非项目 tab 项目工作区消失的回归（主区显示规则：有选中项目时非知识专属面板 tab 一律显示项目工作区）；② 项目工作区新增流水线步骤条（① 选材 → ② 生成 → ③ 修改 → ④ 发布）；③ 配置「内容」更名「选材」，新增知识库选材（笔记/卡片/碎片/错题勾选汇总为素材、一键生成复习 PPT、`ai-ppt.json.sourceSelection` 持久化）；④ 项目列表改名「PPT 作品」并显示来源 badge。
- v2.2.0 双链笔记体验升级（借鉴 Obsidian/Logseq）：① 笔记预览（转义→wikilink 预处理→marked 渲染，`[[wikilink]]` 可点击、死链一键创建）；② `[[` 自动补全与大纲 TOC；③ 快速跳转 `Ctrl+Shift+O`（Quick Switcher）；④ 搜索 snippet 命中居中、入链带上下文（`backlinks: [{name, snippets}]`）；⑤ 每日笔记 `journal-YYYY-MM-DD`，速记碎片可附加到今日；⑥ 重命名级联更新全库引用（`POST /api/vault/notes/:name/rename`）；⑦ 标签聚合（`GET /api/vault/tags`）与未链接提及一键转链；⑧ 新增依赖 `marked`（vendor 于 `web/js/vendor/marked.umd.js`）。
- v2.3.0 独立系统设置区与 AI 对话强化：① 三组模型配置（文本/生图/生视频）从项目「选材」tab 提升到系统级「设置」面板（复用 `GET/POST /api/config` 与 `POST /api/media/test`），新增 `POST /api/backup` 备份入口；② 笔记 AI 对话修改（`scripts/chat-note.mjs` + `POST /api/vault/notes/:name/chat` 202 + `chat/events` SSE，自动备份、保留 Front Matter 与 wikilink）；③ PPT AI 对话历史持久化 `projects/<name>/chat-history.json`（最多 50 条，`GET /api/projects/:name/chat/history`）。
- v2.3.1 模型密钥挂钩与系统级设置入口：① 设置面板三组模型的 API Key 可勾选「保存到本地配置」（`.ai-ppt-config.json`），取 key 优先级 环境变量 > 配置文件，`GET /api/config` 只返回 `apiKeySet` 掩码；② 顶栏新增 ⚙ 一键打开系统设置；③ 「未配置可用 LLM」错误自动追加设置面板引导。
- v2.3.2 AI 修改结果显示修改明细：① 笔记/PPT 的 AI 对话修改完成后展示修改明细（优先 LLM 输出的逐条修改点，prompt 新增 `---修改说明---` 输出约定；缺失时回退行级 diff，LCS 实现，上限 40 行）；② 明细随 SSE `done.details` 下发，chat-history.json 同步保存。
- v2.4.0 以笔记为中心重构 + Logseq 笔记功能：① 布局——顶部工具栏去掉项目选择器与项目操作按钮（移入 `#project-panel` 的 `.project-toolbar`），顶部只留 logo/搜索/设置/帮助；主区面板与侧边栏 tab 严格对应，启动默认 tab 改为 `vault`；`1-9` 快切项目快捷键移除，「新建项目」入口移入侧边栏 projects tab（`#btn-create-project-side`）；② Logseq 语法——任务（TODO/DOING/DONE + `[#A-C]`、`Ctrl/Cmd+Enter` 循环、主区 `#tasks-panel` 聚合）、行内属性 `key:: value`、块引用 `^id` + `((id))` 只读展开、简单查询 `{{query ...}}` 内嵌渲染、PDF 上传与 `![[x.pdf|N]]` 嵌入、Journal 前后一天导航与日记列表；③ 多选笔记生成媒体——`S.selectedNotes` + `#note-gen-modal` 三类型：PPT（`generate-deck` 202 + SSE 进度，完成自动跳项目工作区）、视频（`generate-video` 202 + `/api/media/tasks/:id` 轮询，modal 内播放）、报告（`generate-report` 同步，marked 渲染 + 客户端导出 HTML）；④ 后端——`scripts/vault-features.mjs` 纯函数（parseTasks/parseProperties/parseBlockAnchors/toggleTaskLine/runQuery 微型 DSL：and/or/not + tag/task/property/page 谓词）；索引扩展 `index.notes[name].{tasks,properties,blocks}` + `index.blocks` + `index.tasks`；新路由（字面量先于通配）：`GET /api/vault/tasks`、`POST /api/vault/query`、`GET /api/vault/blocks/:id`、`GET|POST /api/vault/assets`（PDF 后缀 + `%PDF` 魔数双重校验，成功返回 201）、`POST /api/vault/notes/generate-deck`（脚本 `generate-from-notes.mjs`，sourceType `vault-notes`）、`POST /api/vault/notes/generate-video`（mediaTasks 异步，LLM 浓缩视频 prompt 失败时首段截断 300 字）、`POST /api/vault/notes/generate-report`（落盘 `vault/reports/`，LLM 失败降级确定性模板）与 `GET /api/vault/reports`；`vault/reports/` 已加入 `ensureVaultDirs`。
- v2.5.0 速记多媒体升级（后端）：① `POST /api/vault/assets` 从仅 PDF 扩展为多类型上传（图片 png/jpg/jpeg/gif/webp ≤10MB、文档 pdf/docx ≤20MB、音频 mp3/wav/m4a/ogg ≤80MB、视频 mp4/webm/mov ≤80MB；后缀 + 魔数双重校验表在 `routes/vault.mjs` 顶部 `ASSET_TYPES`，重名自动改 `名-<base36时间戳>.扩展名`，返回 201 `{ok,name,webPath,kind}`）；② `readBody(req, maxBytes)` 支持按路由放宽上限（资产上传用 110MB）；③ 新增 `scripts/parse-asset.mjs`——pdf/docx 本地提取（pdf-parse v2 / mammoth）+ LLM 规整为干货笔记，图片走 openai 兼容视觉 → `bl omni`，语音类（音频与 `voice-*` 录音）优先 `bl speech recognize`（FunAudio-ASR；webm 等容器先 ffmpeg 抽轨转 m4a，临时文件用完即删）→ LLM 规整（失败则保留原始转写），兜底 `bl omni --audio`（仅限其支持的 9 种后缀）→ `arkcli +chat --input @file`，视频走 `bl omni --video` → `arkcli +chat`，全部 try/catch 降级不抛错；④ 解析任务路由 `POST /api/vault/assets/:name/parse`（202 `{taskId}`）+ `GET /api/vault/assets/parse-tasks/:id`（轮询 `{status,text?,degraded?,provider?,error?}`），任务存 `routes/vault.mjs` 内 in-memory `parseTasks` Map，TTL 同 `MEDIA_TASK_TTL_MS`；⑤ `POST /api/vault/fragments` 支持 `attachments: [name]`（以 `![[name]]` token 追加进正文）与 `parse: true`（后台顺序解析附件，`updateFragment` 追加「📎 <name> 解析：」段落并自动重提取 #标签，响应带 `parseTaskIds`）；⑥ `server.mjs` MIME 表补 webm/mov/mp3/wav/m4a/ogg/docx，保证 `GET /api/vault/assets/:file` 浏览器可直接加载。⑦ 前端——速记输入区支持剪贴板粘贴/拖拽/📎 选择附件（chips 预览 + 大小预检），`submitFragment` 先上传再以 `![[name]]` 入正文，轮询 parseTask 并刷新；碎片列表渲染正文内 `![[name]]` 为图片/视频/音频/文件链接（escapeHtml 后白名单正则替换）；⑧ 笔记预览管线在 PDF 嵌入后新增多媒体嵌入（img/video/audio/docx 链接），笔记工具栏「PDF」上传泛化为多类型「附件」，`![[` 补全扩展全类型；⑨ 星图美化——teal-editorial 配色（笔记 teal/卡片琥珀/碎片紫/标签柔和 hash 色、cream 底、ink 低透明边）、节点描边与下方标签、悬停高亮邻接、HTML 图例（`.graph-legend`），物理模拟与选区生成 PPT 行为不变；⑩ 新增依赖 pdf-parse、mammoth；⑪ 语音听记——速记输入区 🎙 入口 + `#voice-modal`（大计时器 + AnalyserNode 波形 + 暂停/继续），MediaRecorder 录音完成即自动上传 `voice-*` 附件并建碎片（转写 prompt、音频播放器渲染），`appendAttachmentTokens` 同名 token 去重，`bl` JSON 输出解包（空 content 继续降级）；⑫ 附件重解析工程化——`POST /api/vault/fragments/:id/reparse` 路由（202 + parseTaskIds）、解析块标准化为 `📎 <name> 解析（<provider>）：` 且 upsert 整块替换（`scripts/fragments.mjs` 的 `extractAttachmentNames`/`upsertParseBlock` 纯函数）、创建与重解析共用 `startFragmentParseTasks()`、前端碎片「重新解析」按钮、CLI `node scripts/fragments.mjs reparse <id>`。

## 更早期版本（自 README.md 迁入）

### v1.4 — PDF 页眉标题 + 专业水印（2025-07）

- **PDF 导出页眉**：点击 `↓` 导出前自动设置静态文档标题，浏览器打印对话框显示正确文件名。
- **打印水印**：每页添加半透明文字水印"内部资料，请勿非法传播"，防止外泄。
- **页边距优化**：通过 `@page` 调整上下边距，避免内容被裁剪。

### v1.3 — 打印输出介质自适应（2025-07）

- **物理打印**：幻灯片以 `100vw × 100vh` 渲染，A4 纸等比缩放内容，不再强制压缩到 297mm。
- **虚拟 PDF 导出**：浏览器 PDF 渲染器使用完整页面区域，保持满屏比例。
- **预览空白修复**：向上箭头打开多页预览时，所有页面内容可见（`.overview-card .slide-content` 强制 `opacity: 1`）。

### v1.2 — PDF 导出与预览修复（2025-07）

- **PDF 导出尺寸修复**：打印模式下幻灯片满屏渲染，解决 A4 纸上只占中心小区域的问题。
- **预览空白修复**：向上箭头打开多页预览时，所有页面内容可见。
