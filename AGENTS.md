# ai-ppt 项目约定

> 版本历史见 CHANGELOG.md；本文件只保留现行有效约定。

## 目录结构

```
ai-ppt/
├── ai-ppt-base/        # PPT 引擎基座，唯一的样式/脚本升级源（css/ppt.css、css/themes/、js/ppt.js）
├── projects/<name>/    # 业务 deck：index.html、ai-ppt.json、css/、js/、export/、assets/
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
5. **概念模型（以笔记为中心）**：启动默认落 vault tab；顶栏仅 logo/搜索/设置/帮助。PPT 作品 = `projects/<name>`，生命周期 ① 选材 → ② 生成 → ③ 修改 → ④ 发布，在侧边栏 projects tab 管理。主区面板与侧边栏 tab 一一对应，`#project-panel` 仅在 projects tab 且有选中项目时显示。
6. **生成流程**：`POST /api/projects/:name/generate` → `scripts/generate-deck.mjs`（202 + SSE 进度）；LLM 按 OpenAI 兼容 → Bailian CLI → 确定性模板降级。5 个生成脚本（generate-deck / generate-from-note(s) / generate-from-graph / generate-from-review）共用 `generation-common.mjs` 的分层管线：`buildSlidesPrompt`（统一提示词脚手架，各源只给任务描述/素材/extraRules）→ `generateSlidesHtml`（LLM 调用 + 页数校验 + `buildFallbackSlides` 参数化兜底 + Markdown 清洗 + 单 active）→ `config.mjs` 的 `writeDeckIndex`（mkdir + 复制基座引擎 + wrapSlides + 原子写盘）。源特有逻辑（graph 节点展开、review 错题整理等）保留在各自脚本。
7. **导出单入口**：项目工具栏 `#export-dropdown` 一个入口（PPTX / 高清图片 PPTX / 浏览器打印 PDF / 单文件 HTML），`Ctrl+P` 展开。产物在 `projects/<name>/export/`：`deck.pptx`（可编辑文字）、`deck-image.pptx`（逐页截图）、`deck.pdf`（Chrome 截图，打印回退）、`deck-single.html`。服务端导出（pptx / pptx-image / pdf）为异步任务：POST 202 → `GET .../export/<type>/events` SSE（NDJSON 协议同生成），done 事件带 `downloadUrl`；同项目同类型重复 POST 409，puppeteer 类导出全局最多 2 个并发（超出 429）；单文件 HTML 保持同步。导出视口与 PDF 页面统一 1280×800（同基座设计基准）。
8. **备份与快照治理**：批量改动前 `npm run backup`（→ `.backup/<ts>/`，含 `vault/`）。vault 笔记删除/覆盖前自动备份到 `.snapshots/_vault/<ts>/`，保留 200 份（`VAULT_BACKUP_KEEP`，server.mjs `backupVaultNote()` 亦调用 `pruneVaultBackups()`）。项目快照 `snapshot.mjs`（`create/list/restore/delete/prune`），每项目保留 20 份（`SNAPSHOT_KEEP`，create 后自动 prune）；restore 覆盖前自动建安全快照。均有 isSafeName/路径防注入。
9. **全局搜索**：`scripts/search.mjs` + `GET /api/search`。`invalidateSearchIndex(name)` 语义为「单项目重建索引」——生成/chat/save-edits 后自动刷新，仅删除项目时才真正移除。
10. **对话式修改**：PPT → `scripts/chat-modify.mjs`（202 + SSE NDJSON，改前自动快照；历史存 `chat-history.json` 最多 50 条）。局部编辑协议：LLM 只返回修改页（`=== slide N ===` / `=== slide new ===`，N 为 1-based），cheerio DOM 级合并进现有 index.html，未修改页与模板外定制保留；输出无法解析为局部区块时回退旧的「全部幻灯片 + wrapSlides」整页重写；超过 15 页时 prompt 只放指令相关页 + 前后各 1 页上下文；笔记 → `scripts/chat-note.mjs`（改前自动备份到 `.snapshots/_vault/`，保留 Front Matter 与 `[[wikilink]]`，失败不动文件）。CLI：`npm run chat-modify -- <name> "<instruction>"`。
11. **关键数字 / 数据页排版**：同一行 ≤4 项，超出拆页或改表格/卡片；用 `.split-visual` + `.hero-stat` + `.big-number`（字号 `clamp(44px, 5.5vw, 80px)`，禁换行，等宽分布最大 240px）。
12. **主题**：deck 只用默认主题（`web-ui`）或 `css/themes/` 预设主题；无明确指令不更换、不自创主题配色。主题的单一数据源是 `ai-ppt-base/themes.json`：新增主题 = themes.json 加一条 + `css/themes/<id>.css` 加一个文件，然后 `npm run upgrade-decks`（会同步刷新基座 index.html 的 `theme-links` 标记区块）。`wrapSlides` 的主题 `<link>` 由 `buildThemeLinks()` 按 themes.json 动态生成；`ppt.js` 内的主题数组仅是 /api/themes 不可用时的离线兜底，不必同步。
13. **Front Matter 统一解析**：`scripts/front-matter.mjs` 是唯一实现（`parseFrontMatter`/`stringifyFrontMatter`/`splitFrontMatter`），支持标量、行内/多行数组、多行字符串、值含冒号；禁止再写新的 FM 解析器。
14. **写盘原子化**：`scripts/fs-utils.mjs` 的 `writeFileAtomic`/`writeJsonAtomic`（同目录临时文件 + fsync + rename）是所有 JSON/文本写盘的唯一入口；store.mjs 亦复用，不保留第二份实现。
15. **任务注册表**：`scripts/task-registry.mjs`（`createTaskRegistry`）是媒体/解析任务状态与 NDJSON 任务元信息的唯一实现——内存 Map + 节流落盘到根目录 `.ai-ppt-tasks.json`（已 gitignore，writeJsonAtomic）；状态机 `pending|running → done|error|cancelled|interrupted`。服务启动时 `load()` 把活跃态标记 `interrupted`（轮询端点对未知 id 返回 404 + `{status:'unknown'}`）；取消端点 `POST /api/media/tasks/:id/cancel`、`POST /api/vault/assets/parse-tasks/:id/cancel`（标记后迟到结果被忽略）；`spawnNdjsonTask` 事件 buffer 上限 500 条（`pushBounded` 丢最旧），同名任务覆盖前向旧 SSE 连接推 `{type:'error'}` 取代事件。

## Web 前端约定

16. **模块化**：`app.mjs` 入口、`state.mjs` 集中全局状态 `S`。
17. **弹窗**：一律用 `modals.mjs` 的 `showInputModal`/`showConfirmModal`；禁止原生 `prompt()`/`confirm()`。
18. **笔记保存**：`Ctrl+S` 按上下文分派（vault tab 且打开笔记 → 保存笔记；项目工作区 → 保存项目配置）；2 秒防抖自动保存、脏标记（标题与保存按钮 ●）、beforeunload 防丢、localStorage 草稿（key `ai-ppt-note-draft:<name>`，打开时提示恢复）。
19. **「生成 PPT」统一入口**：`generate.mjs` 的 `#gen-modal` + `openGenerateModal(source)`，`source.kind ∈ note|notes|graph|review`，后端 API 不变。
20. **笔记工具栏**：收为「保存 + 生成 PPT + ⋯更多」下拉（重命名/预览/大纲/生成配图/附件/AI 修改/删除在 ⋯ 内）。empty-state 为笔记中心引导（新建笔记/写速记），初始 hidden。
21. **侧边栏「学习」tab**：测验/错题集/复习训练合并为 `data-tab="study"` 的 `#study-panel`，内部二级子 tab exams/mistakes/training，`switchSidebarTab('study', subTab)`，记忆在 `S.studySubtab`。
22. **笔记渲染管线**（顺序不可调换）：整体 HTML 转义 → PDF 嵌入 `![[x.pdf|N]]` 占位 → 多媒体嵌入占位 → 块引用 `((id))` 占位 → 查询块 `{{query}}` 占位 → `[[wikilink]]` 预处理 → 恢复行首 `&gt;` 引用块 → 任务标记/`key:: value` 内联替换 → `marked.parse()` → 占位换回 HTML → 异步填充块引用/查询。
23. **重命名笔记必须走** `vault.mjs` 的 `renameNote()`（备份 → 重命名 → 级联更新 `[[旧名]]` → 重建索引），禁止只重命名文件。

## vault 知识库

24. **速记碎片**：`vault/fragments/<id>.md`（id `f-<base36时间戳>-<4位随机>`），Front Matter `id/type/tags/created/status`（`inbox`|`organized`）；`#标签` 自动提取；promote 映射以 `organize.mjs` 的 `promoteFragment()` 为准；附件以 `![[name]]` token 入正文（不入 Front Matter），解析块 `📎 <name> 解析（<provider>）：` upsert 整块替换；`voice-*` 录音渲染为 `<audio>`。
25. **Logseq 语法**：任务 `- TODO|DOING|DONE [#A|B|C]`（`Ctrl/Cmd+Enter` 循环）、行内属性 `key:: value`、块引用 `^id` + `((id))`、查询 `{{query ...}}`（and/or/not + tag/task/property/page）；解析纯函数统一在 `vault-features.mjs`，前后端规则必须一致。每日笔记 `journal-YYYY-MM-DD`。
26. **资产与产物**：`POST /api/vault/assets` 上传存 `vault/assets/`——前端一律 `FormData` multipart 流式上传（`scripts/multipart.mjs` 零依赖解析器：文件部分写 `vault/assets/.tmp/` 临时文件不驻留内存，校验过后 rename 入库，失败自动清理；base64 JSON 保留为兼容回退），后缀 + 魔数双重校验（白名单见 `routes/vault-commons.mjs` 的 `ASSET_TYPES`），流式路径超限返回 413；`POST /api/vault/assets/:name/parse` 解析（202 + 轮询），`parse-asset.mjs` 按类型多级降级、全程不抛错。产物位置：知识库配图 → `vault/assets/`，PPT 配图 → `projects/<name>/assets/`，报告 → `vault/reports/`，视频 → `vault/assets/video-<时间戳>.mp4`。

## Skill 行为

- `/ppt-structure <name>`：在 `projects/<name>/` 创建 deck（复制基座 css/js/README，生成初始 index.html 与 ai-ppt.json）。
- `/ppt-preview [name]` / `/ppt-edit [instruction]`：优先定位 `projects/<name>/`，未指定时优先当前目录再搜索 `projects/*/`。
- `/ppt-export [name] [pdf|pptx]`：导出 PDF 或 PPTX；`/ppt-list`：列出所有 deck；`/ppt-delete <name>`：删除 deck（需确认）。
- `/ppt-design`：设计规范（蒸馏自 impeccable 与 taste-skill），生成/编辑/审查 deck 时遵循。
- `/ppt-anim` 配置动画、`/ppt-data` 数据可视化、`/ppt-theme` 主题管理、`/ppt-publish` 发布与版本管理。

## 安装与同步 skills

修改 `skills/` 后运行 `node install-skills.js`（或 `./install-skills.sh`）。

## 测试

- `npm test` → `node --test tests/core.test.mjs`；`npm run test:smoke` → `node scripts/test-smoke.mjs`。
