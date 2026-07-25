# ai-ppt 项目约定

> 版本历史见 CHANGELOG.md；本文件只保留现行有效约定。

## 目录结构

```
ai-ppt/
├── ai-ppt-base/        # PPT 引擎基座，唯一的样式/脚本升级源（css/ppt.css、css/themes/、js/ppt.js）
├── templates/<id>/     # 场景模板（weekly-report / training-course / pitch / review-lesson）：
│                       # 完整 deck 骨架 index.html + ai-ppt.json，不含 css/js（创建时注入基座引擎）
├── projects/<name>/    # 业务 deck：index.html、ai-ppt.json、css/、js/、export/、assets/、cover.png
├── web/                # Web 管理界面，无构建 ES Modules
│   └── js/modules/     # app.mjs 入口 + state/vault/projects/generate/modals 等
├── server.mjs, routes/ # Web 服务入口与路由模块；vault 路由按域拆分（routes/vault.mjs 为聚合入口，
│                       # routes/vault-notes/fragments/assets/learn/graph.mjs + 共享 routes/vault-commons.mjs，
│                       # 合并顺序与拆分前严格一致，域内增删路由需同步调整聚合处 slice 下标）
├── scripts/            # 生成/导出/备份/快照/搜索/vault 等工具脚本
├── tests/core.test.mjs # npm test
└── skills/             # CLI skill 定义
```

## 核心约定

1. **所有业务 deck 必须位于 `projects/` 下**：`/ppt-structure` 新建、`/ppt-preview`、`/ppt-edit` 均以此为查找路径。
2. **不要直接修改项目中的 `css/ppt.css` 和 `js/ppt.js`**：改动在 `ai-ppt-base/` 进行，再 `npm run upgrade-decks` 同步（`--project <name>` 单项目、`--dry-run` 预览）。deck 内用相对路径引用本地引擎文件，保证可独立移动或打包。
3. **项目配置 `ai-ppt.json`**：每个 deck 必备。关键字段：`sourceType`/`sourceUrl`/`articleText`/`params`/`status`；`sourceSelection` 持久化知识库选材；`userEdits` 记录用户可视化编辑，`generate-deck.mjs`/`chat-modify.mjs` 的 prompt 必须保留这些页的文字与数据。
4. **系统级模型配置**：三组配置（`modelConfig`/`imageModelConfig`/`videoModelConfig`）存根目录 `.ai-ppt-config.json`（已 gitignore），由「设置」面板（顶栏齿轮，唯一设置入口）修改，对所有项目生效。优先级：环境变量 `OPENAI_*` > 配置文件 > 内置默认；apiKey 不落盘。`sk-kimi-` 开头的 key 自动路由到 Kimi Code 端点（`api.kimi.com/coding/v1` + `kimi-for-coding`）。
5. **概念模型（以笔记为中心）**：启动默认落 vault tab；顶栏仅 logo/搜索/设置/帮助（移动端另有汉堡按钮开合侧边栏抽屉，见条目 30）。PPT 作品 = `projects/<name>`，生命周期 ① 选材 → ② 生成 → ③ 修改 → ④ 发布，在侧边栏 projects tab 管理。主区面板与侧边栏 tab 一一对应，`#project-panel` 仅在 projects tab 且有选中项目时显示。
6. **生成流程**：`POST /api/projects/:name/generate` → `scripts/generate-deck.mjs`（202 + SSE 进度）；LLM 按 OpenAI 兼容 → Bailian CLI → 确定性模板降级。5 个生成脚本（generate-deck / generate-from-note(s) / generate-from-graph / generate-from-review）共用 `generation-common.mjs` 的分层管线：`buildSlidesPrompt`（统一提示词脚手架，各源只给任务描述/素材/extraRules）→ `generateSlidesHtml`（LLM 调用 + 页数校验 + `buildFallbackSlides` 参数化兜底 + Markdown 清洗 + 单 active）→ `config.mjs` 的 `writeDeckIndex`（mkdir + 复制基座引擎 + wrapSlides + 原子写盘）。源特有逻辑（graph 节点展开、review 错题整理等）保留在各自脚本。落盘完成后统一经 `scripts/design-lint.mjs` 的 `lintAfterGenerate` 做设计检查（结果作为 NDJSON `lint` 事件发出，不阻断生成；仅 gradient-text 移除这类安全项默认自动修复）。
7. **设计质量护栏**：`scripts/design-lint.mjs`（CLI `node scripts/design-lint.mjs <name> [--fix]` + 库）对 deck index.html 做生成后校验（一行大数字 ≤4、标题缺失/过长、gradient-text、空页、眉毛节制、疑似占位数据、版式轮换、表格密度、图片存在性）；`--fix` 修复前自动快照、writeFileAtomic 写回。API：`GET /api/projects/:name/design-lint`、`POST .../design-lint/fix`（修复后 invalidateSearchIndex）；前端项目工作区「设计检查」按钮展示结果并支持一键修复。chat-modify 合并完成后同样跑一次。
8. **导出单入口**：项目工具栏 `#export-dropdown` 一个入口（PPTX / 高清图片 PPTX / 浏览器打印 PDF / 单文件 HTML / 视频 MP4 / 静态站点包 ZIP），`Ctrl+P` 展开。产物在 `projects/<name>/export/`：`deck.pptx`（可编辑文字）、`deck-image.pptx`（逐页截图）、`deck.pdf`（Chrome 截图，打印回退）、`deck-single.html`、`deck.mp4`、`site.zip`。服务端导出（pptx / pptx-image / pdf / video）为异步任务：POST 202 → `GET .../export/<type>/events` SSE（NDJSON 协议同生成），done 事件带 `downloadUrl`；同项目同类型重复 POST 409，puppeteer 类导出（pptx-image / pdf / video）全局最多 2 个并发（超出 429）；单文件 HTML 与静态站点包保持同步。导出视口与 PDF 页面统一 1280×800（同基座设计基准）。
9. **视频导出**：`scripts/export-video.mjs`（CLI `node scripts/export-video.mjs <name> [--duration 秒] [--fps N]` + 库）：puppeteer 逐页截 1280×800 PNG（公共截图逻辑在 `scripts/deck-capture.mjs`，export-pdf 同用）→ ffmpeg concat 静帧合成 `deck.mp4`（每页默认 4s，30fps，H.264/yuv420p）。media-gen.mjs 暂无 TTS 能力，故为无旁白版；`extractSlideTexts`（.speaker-note 优先，否则标题+要点）已实现供将来接入。ffmpeg 缺失/合成失败降级：只输出逐帧 PNG 到 `export/frames/`，done 事件带 `note` 说明（前端 toast 展示）。
10. **发布**：`POST /api/projects/:name/publish` 把 deck 目录整体拷到 `published/<name>/vN/`（递增版本 + meta.json），`latest` 为软链（失败退化为拷贝）；静态服务 `/published/<name>/<version>/`。响应带 `latestUrl` 与 `lanUrl`（首个非回环 IPv4 + 请求端口）。`GET .../publish/qr?url=` 用 `qrcode` 包本地生成 PNG 二维码（仅 http/https，不依赖外部 API）。`POST .../export/site` 用 `archiver` 把 deck 打成 `site.zip`（排除 export/ 与隐藏文件），拖进任何静态托管即可放映。前端：工具栏「发布」按钮 + 发布结果弹窗（完整链接 / 复制 / 二维码），配置面板发布 tab 展示历史；手机扫码访问需 `AI_PPT_HOST=0.0.0.0` 启动且同一局域网。
11. **备份与快照治理**：批量改动前 `npm run backup`（→ `.backup/<ts>/`，含 `vault/`）。vault 笔记删除/覆盖前自动备份到 `.snapshots/_vault/<ts>/`，保留 200 份（`VAULT_BACKUP_KEEP`，server.mjs `backupVaultNote()` 亦调用 `pruneVaultBackups()`）。项目快照 `snapshot.mjs`（`create/list/restore/delete/prune`），每项目保留 20 份（`SNAPSHOT_KEEP`，create 后自动 prune）；restore 覆盖前自动建安全快照。均有 isSafeName/路径防注入。
12. **全局搜索**：`scripts/search.mjs` + `GET /api/search`。`invalidateSearchIndex(name)` 语义为「单项目重建索引」——生成/chat/save-edits 后自动刷新，仅删除项目时才真正移除。
13. **对话式修改**：PPT → `scripts/chat-modify.mjs`（202 + SSE NDJSON，改前自动快照；历史存 `chat-history.json` 最多 50 条）。局部编辑协议：LLM 只返回修改页（`=== slide N ===` / `=== slide new ===`，N 为 1-based），cheerio DOM 级合并进现有 index.html，未修改页与模板外定制保留；输出无法解析为局部区块时回退旧的「全部幻灯片 + wrapSlides」整页重写；超过 15 页时 prompt 只放指令相关页 + 前后各 1 页上下文；笔记 → `scripts/chat-note.mjs`（改前自动备份到 `.snapshots/_vault/`，保留 Front Matter 与 `[[wikilink]]`，失败不动文件）。CLI：`npm run chat-modify -- <name> "<instruction>"`。
14. **关键数字 / 数据页排版**：同一行 ≤4 项，超出拆页或改表格/卡片；用 `.split-visual` + `.hero-stat` + `.big-number`（字号 `clamp(44px, 5.5vw, 80px)`，禁换行，等宽分布最大 240px）。
15. **主题**：deck 只用默认主题（`web-ui`）或 `css/themes/` 预设主题；无明确指令不更换、不自创主题配色。主题的单一数据源是 `ai-ppt-base/themes.json`（字段：`id`/`name`/`desc` 适用场景描述/`color`/`mode` light|dark）：新增主题 = themes.json 加一条 + `css/themes/<id>.css` 加一个文件，然后 `npm run upgrade-decks`（会同步刷新基座 index.html 的 `theme-links` 标记区块）。`wrapSlides` 的主题 `<link>` 由 `buildThemeLinks()` 按 themes.json 动态生成；`ppt.js` 内的主题数组仅是 /api/themes 不可用时的离线兜底，不必同步。`ai-ppt-base/theme-showcase.html` 是自动从 themes.json 渲染的主题画廊（运行时探测各主题 CSS 变量画迷你 slide 预览），Web 服务经 `/base/theme-showcase.html` 提供；项目工作区「主题」tab 的「主题画廊」按钮以 modal + iframe 打开，iframe 内点选经 `postMessage({type:'ai-ppt:select-theme'})` 回传，父页走配置 API 应用主题。
16. **场景模板**：`templates/<id>/`（index.html 必备 + ai-ppt.json 可选）是「从模板新建」的骨架。`createProject(name, title, template?)` 先校验模板 id（isSafeName + 目录存在，失败不残留目录）再复制模板文件并 ensureBaseEngine；`POST /api/projects` body 加可选 `template` 字段；前端新建项目弹窗有模板下拉（空白 + 4 个模板）。模板幻灯片是设计标杆（版式轮换、chart-steps/two-col 用基座真实结构、chart 用 data-chart 声明式写法），改动后跑 `node scripts/design-lint.mjs` 应零问题。
17. **项目封面**：`scripts/deck-capture.mjs` 的 `captureCover(name)` 截第 1 页（1280×800 视口 × deviceScaleFactor 0.375 = 480×300 PNG）存 `projects/<name>/cover.png`，全程不抛错（无 Chrome/puppeteer 静默返回 null）。接入点：5 个生成脚本 lintAfterGenerate 之后、PDF 导出任务 done（routes/projects.mjs 监听）；截图时隐藏 sidebar/theme-switcher 等 UI 铬件并强制入场动画元素可见（基态 opacity:0）。前端侧边栏项目卡显示该封面（`/projects/<name>/cover.png?t=<lastGeneratedAt>` 防缓存，404 时移除 img 回退纯文字）。
18. **Front Matter 统一解析**：`scripts/front-matter.mjs` 是唯一实现（`parseFrontMatter`/`stringifyFrontMatter`/`splitFrontMatter`），支持标量、行内/多行数组、多行字符串、值含冒号；禁止再写新的 FM 解析器。
19. **写盘原子化**：`scripts/fs-utils.mjs` 的 `writeFileAtomic`/`writeJsonAtomic`（同目录临时文件 + fsync + rename）是所有 JSON/文本写盘的唯一入口；store.mjs 亦复用，不保留第二份实现。
20. **任务注册表**：`scripts/task-registry.mjs`（`createTaskRegistry`）是媒体/解析任务状态与 NDJSON 任务元信息的唯一实现——内存 Map + 节流落盘到根目录 `.ai-ppt-tasks.json`（已 gitignore，writeJsonAtomic）；状态机 `pending|running → done|error|cancelled|interrupted`。服务启动时 `load()` 把活跃态标记 `interrupted`（轮询端点对未知 id 返回 404 + `{status:'unknown'}`）；取消端点 `POST /api/media/tasks/:id/cancel`、`POST /api/vault/assets/parse-tasks/:id/cancel`（标记后迟到结果被忽略）；`spawnNdjsonTask` 事件 buffer 上限 500 条（`pushBounded` 丢最旧），同名任务覆盖前向旧 SSE 连接推 `{type:'error'}` 取代事件。

## Web 前端约定

21. **模块化**：`app.mjs` 入口、`state.mjs` 集中全局状态 `S`。
22. **弹窗**：一律用 `modals.mjs` 的 `showInputModal`/`showConfirmModal`；禁止原生 `prompt()`/`confirm()`。
23. **笔记保存**：`Ctrl+S` 按上下文分派（vault tab 且打开笔记 → 保存笔记；项目工作区 → 保存项目配置）；2 秒防抖自动保存、脏标记（标题与保存按钮 ●）、beforeunload 防丢、localStorage 草稿（key `ai-ppt-note-draft:<name>`，打开时提示恢复）。
24. **「生成 PPT」统一入口**：`generate.mjs` 的 `#gen-modal` + `openGenerateModal(source)`，`source.kind ∈ note|notes|graph|review`，后端 API 不变。
25. **笔记工具栏**：收为「保存 + 生成 PPT + ⋯更多」下拉（重命名/预览/大纲/生成配图/附件/AI 修改/删除在 ⋯ 内）。empty-state 为笔记中心引导（新建笔记/写速记），初始 hidden。
26. **侧边栏「学习」tab**：测验/错题集/复习训练合并为 `data-tab="study"` 的 `#study-panel`，内部二级子 tab exams/mistakes/training，`switchSidebarTab('study', subTab)`，记忆在 `S.studySubtab`。
27. **笔记渲染管线**（顺序不可调换）：整体 HTML 转义 → PDF 嵌入 `![[x.pdf|N]]` 占位 → 多媒体嵌入占位 → 块引用 `((id))` 占位 → 查询块 `{{query}}` 占位 → `[[wikilink]]` 预处理 → 恢复行首 `&gt;` 引用块 → 任务标记/`key:: value` 内联替换 → `marked.parse()` → 占位换回 HTML → 异步填充块引用/查询。
28. **重命名笔记必须走** `vault.mjs` 的 `renameNote()`（备份 → 重命名 → 级联更新 `[[旧名]]` → 重建索引），禁止只重命名文件。
29. **首次启动向导与帮助面板**：localStorage `ai-ppt-onboarded` 未设置时，启动链末尾弹 3 步向导（`#onboarding-modal`，步骤定义在 app.mjs `ONBOARDING_STEPS`：记录 → 生成 → 导出与发布，CTA 分别跳速记输入 / projects tab / 关闭），「跳过引导」与最后一步均写 localStorage。帮助面板（`?` 或顶栏 ? 按钮）= 三组场景指引（做 PPT / 整理笔记 / 复习）+ 快捷键清单，footer 有「重新查看引导」入口；快捷键清单必须与 projects.mjs `bindEvents` 的全局 keydown 及 vault/fragments 编辑器内按键保持同步（新增/移除快捷键时同步改 index.html `#help-panel`）。
30. **移动端适配（≤768px）**：所有小屏样式包在 web.css 的 `@media (max-width: 768px)` 块内，不改桌面视觉。侧边栏为 fixed 全高抽屉（`.drawer-open` + `#sidebar-scrim` 遮罩），汉堡按钮 `#btn-sidebar-toggle` 仅小屏显示；开合逻辑在 app.mjs（`openSidebarDrawer` 带媒体查询守卫 / `closeSidebarDrawer`），点 tab 自动收起（速记 tab 例外——输入区在抽屉内），`selectNote`/`selectProject` 选中后收起、`focusFragmentInput` 自动展开（均经 commonCbs 回调）。速记输入区有「提交」按钮（`#btn-fragment-submit`，等价 Enter）；语音听记弹窗小屏全屏化；笔记工具栏横向滚动；dashboard/标签/主题等 grid 类面板小屏单列。

## vault 知识库

31. **速记碎片**：`vault/fragments/<id>.md`（id `f-<base36时间戳>-<4位随机>`），Front Matter `id/type/tags/created/status`（`inbox`|`organized`）；`#标签` 自动提取；promote 映射以 `organize.mjs` 的 `promoteFragment()` 为准；附件以 `![[name]]` token 入正文（不入 Front Matter），解析块 `📎 <name> 解析（<provider>）：` upsert 整块替换；`voice-*` 录音渲染为 `<audio>`。
32. **Logseq 语法**：任务 `- TODO|DOING|DONE [#A|B|C]`（`Ctrl/Cmd+Enter` 循环）、行内属性 `key:: value`、块引用 `^id` + `((id))`、查询 `{{query ...}}`（and/or/not + tag/task/property/page）；解析纯函数统一在 `vault-features.mjs`，前后端规则必须一致。每日笔记 `journal-YYYY-MM-DD`。
33. **资产与产物**：`POST /api/vault/assets` 上传存 `vault/assets/`——前端一律 `FormData` multipart 流式上传（`scripts/multipart.mjs` 零依赖解析器：文件部分写 `vault/assets/.tmp/` 临时文件不驻留内存，校验过后 rename 入库，失败自动清理；base64 JSON 保留为兼容回退），后缀 + 魔数双重校验（白名单见 `routes/vault-commons.mjs` 的 `ASSET_TYPES`），流式路径超限返回 413；`POST /api/vault/assets/:name/parse` 解析（202 + 轮询），`parse-asset.mjs` 按类型多级降级、全程不抛错。`DELETE /api/vault/assets/:name` 删除：被笔记/碎片正文 `![[name]]` 引用时默认 409 + 引用方列表（扫描纯函数在 `scripts/asset-refs.mjs`），`?force=true` 强删；`GET /api/vault/assets?refs=1` 附引用状态，前端「资产库」弹窗（笔记 ⋯更多 入口）据此管理。服务启动时 `cleanupOrphanTmpParts()` 清理 `.tmp/` 孤儿 .part。`POST /api/projects/:name/insert-image`（body `{asset, from?, slide?, title?}`）把 vault/项目资产插入 deck：`scripts/insert-image.mjs` cheerio 合并（默认末页前新建图片页，传 slide 追加进该页 `.slide-content`），写前快照 + writeFileAtomic + invalidateSearchIndex；生成配图弹窗结果区按上下文提供「插入笔记 / 插入幻灯片」。产物位置：知识库配图 → `vault/assets/`，PPT 配图 → `projects/<name>/assets/`，报告 → `vault/reports/`，视频 → `vault/assets/video-<时间戳>.mp4`。
34. **PWA**：`web/manifest.webmanifest`（name「AI PPT 知识中枢」、teal 主题色、icons 在 `web/icons/`，源文件 `icon.svg` 改后用 puppeteer 重新导出 PNG）+ `web/sw.js`（app.mjs 启动时注册，仅 https/localhost，失败静默）。缓存策略：静态壳（html/css/js/vendor/图标/manifest）cache-first 预缓存；导航 network-first 离线回退缓存 `/index.html`；`/api/` network-only 离线 503 JSON（不做数据离线化）；`/projects/`、`/published/`、`/base/` network-first + 运行时缓存副本。**版本维护**：cache 名 `ai-ppt-v<CACHE_VERSION>`，`CACHE_VERSION` 必须与 package.json `version` 同步——改动任何 `web/` 静态资源后 bump 版本号，activate 自动清理旧 cache（skipWaiting + clientsClaim 保证及时生效）。server.mjs MIME 表含 `.webmanifest`。
35. **i18n**：`web/js/modules/i18n.mjs`（中文原文即 key，`t(key, vars?)` 插值用 `{name}` 占位，缺 key 回退中文并按 key 去重 console.warn；语言存 localStorage `ai-ppt-lang`，未设置按 navigator.language 探测；`setLang()` 持久化后 `location.reload()`——状态在 localStorage/服务端，刷新安全）。语言包 `web/js/i18n/zh.mjs`（恒等兜底，正常为空）+ `web/js/i18n/en.mjs`（全量映射）。静态文案在 index.html 打 `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` / `data-i18n-aria`（属性值必须与原文逐字一致，zh 模式恒等），启动时 `applyStaticI18n()` 批量替换；JS 动态文案一律 `t()`。**约定：新增 UI 文案必须走 t()/data-i18n 并同步更新 en.mjs**；后端错误消息、LLM prompt、deck/笔记内容不翻。cards/exams/graph 的深埋文案暂未覆盖（en 模式降级显示中文）。

## Skill 行为

- `/ppt-structure <name>`：在 `projects/<name>/` 创建 deck（复制基座 css/js/README，生成初始 index.html 与 ai-ppt.json）。
- `/ppt-preview [name]` / `/ppt-edit [instruction]`：优先定位 `projects/<name>/`，未指定时优先当前目录再搜索 `projects/*/`。
- `/ppt-export [name] [pdf|pptx]`：导出 PDF 或 PPTX；`/ppt-list`：列出所有 deck；`/ppt-delete <name>`：删除 deck（需确认）。
- `/ppt-design`：设计规范（蒸馏自 impeccable 与 taste-skill），生成/编辑/审查 deck 时遵循。
- `/ppt-anim` 配置动画、`/ppt-data` 数据可视化、`/ppt-theme` 主题管理、`/ppt-publish` 发布与版本管理。

## 安装与同步 skills

修改 `skills/` 后运行 `node install-skills.js`（或 `./install-skills.sh`）。Node 安装器是向导式：真实文件放 `~/.agents/skills/`，在检测到的 CLI（`~/.kimi-code` 总是、`~/.claude` 存在时）下建相对软链；支持 `--dry-run`（只打印）、`--uninstall`（卸载）、`--guide`（快速上手，`npm run intro` 等效）；幂等、零依赖、postinstall 非交互。

## 测试

- `npm test` → `node --test tests/core.test.mjs`；`npm run test:smoke` → `node scripts/test-smoke.mjs`。
