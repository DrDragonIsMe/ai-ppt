# ai-ppt 全库功能与易用性升级审查报告

> 生成时间：2026-07-25。方式：10 个只读探索子代理分区审查（前端壳 / vault 前端 / 项目前端 / 表现层 PWA / 服务端 API / 生成管线 / 导出工具链 / vault 后端 / PPT 引擎基座 / 模板与 DX），所有条目均附代码证据。
> 状态：**待实施**。建议按文末「落地批次」顺序执行。

---

## 批次一：低风险 quick wins（建议最先做）

| # | 问题 | 位置 | 修法 |
|---|------|------|------|
| 1 | 移动端 `@media (max-width:768px)` 块写在大量基础规则**之前**，大纲/dashboard/卡片/图谱/tags/vault 等 7+ 处移动端覆盖被反覆盖（条目 30 部分失效） | `web/css/web.css:2134-2339` vs 2549/3143/3428/3515/3545/3821 等 | 媒体块整体移到文件末尾；AGENTS.md 补约定「响应式覆盖写在组件基础样式之后」 |
| 2 | 通用 Esc 直接给弹窗加 `hidden`，绕过清理：录音中按 Esc 麦克风/MediaRecorder 后台继续跑；input 弹窗 promise 可能永久挂起 | `web/js/modules/projects.mjs:851-854`、`fragments.mjs:595`、`modals.mjs:30-35` | 弹窗关闭回调注册表；至少 voice-modal 的 Esc 接 `cancelVoiceRecording` |
| 3 | 启动链无 `.catch`，`/api/projects` 失败 → 全页面按钮哑、无提示 | `web/js/modules/app.mjs:409-434`、`projects.mjs:47-51`（loadProjects 无内部 catch） | 链尾 catch 显示错误条 + 重试；loadProjects 补 catch |
| 4 | 重新生成/生成到已存在项目：无快照无确认直接覆盖（chat-modify/save-edits 都有快照） | `scripts/generate-deck.mjs`（无 createSnapshot）、`routes/vault-notes.mjs:258-274`、`routes/vault-graph.mjs:26-47,170-183` | 路由层已存在项目 409/force + 前端确认；脚本层覆盖前 `createSnapshot` |
| 5 | `generate-deck.mjs:33` 正则 `[一二三四五六七八九十\\d]` 的 `\\d` 应为 `\d`（实测阿拉伯数字提纲永不命中章节解析）；`#{1,6}` 分支因 stripMarkdown 先行成死代码 | `scripts/generate-deck.mjs:33,107,150` | `\\d`→`\d`，清理死分支 |
| 6 | smoke 测试失败仍 exit 0，CI 无法守门；BASE 硬编码 3456 | `scripts/test-smoke.mjs:9,34-41` | 统计失败数非零退出 + `AI_PPT_SMOKE_BASE` 环境变量 |
| 7 | site.zip 打进 `chat-history.json`（AI 对话）和 `ai-ppt.json`（原文） | `scripts/export-site.mjs:27-32` | 排除清单加这两个文件，或改白名单 |
| 8 | PDF 导出 1× 位图打印模糊（高清 PPTX 已是 2×） | `scripts/deck-capture.mjs:33`、`export-pdf.mjs:59-68` | `captureSlideFrames` 加 scale 参数，PDF 用 2× |
| 9 | 卡片熟练度 level=5 时颜色 `undefined`（masteryColors 只有 5 项，labels 有 6 项） | `web/js/modules/cards.mjs:36,45,78` | 补第 6 色（对齐 `exams.mjs:327`） |
| 10 | 危险确认弹窗默认焦点在「确定」，Enter 即误删 | `web/js/modules/modals.mjs:71` | `opts.danger` 时焦点给取消 |
| 11 | 速记输入无 localStorage 草稿，刷新即丢 | `web/js/modules/fragments.mjs:237-265` | 防抖写草稿，提交后清除，初始化恢复 |
| 12 | 切换笔记时丢弃未结算的自动保存（<2s 输入丢失，还触发困惑的草稿提示） | `web/js/modules/vault.mjs:291,312` | `selectNote` 开头 dirty 则先 `saveNote({auto:true})` |
| 13 | 错题「加入错题集」可重复加入（id 含 Date.now 无去重） | `scripts/exam-papers.mjs:246`、`web/js/modules/exams.mjs:172-176` | id 去时间戳幂等覆盖；前端点击后禁用 |
| 14 | 资产引用扫描不认 `![[x.pdf|N]]` 页码语法，删除保护可绕过 | `scripts/asset-refs.mjs:5-7` | 正则 `![[name(\|\d+)?]]` |
| 15 | 畸形 JSON body 返回 500 而非 400 | `server.mjs:168-170` readBody | catch 内设 `statusCode=400` |
| 16 | 生图失败静默吞异常，502 无诊断 | `routes/media.mjs:40-42` | catch 里 console.error + 截断 err.message 进响应 |
| 17 | toast：换行塌缩（无 `white-space:pre-line`）、2.6s 消失不可复制、无 aria-live | `web/css/web.css:1841-1865`、`web/js/modules/state.mjs:168-194`、`web/index.html:1272` | pre-line + 错误 toast 延长 + `role="status" aria-live` |
| 18 | 图谱画布无 devicePixelRatio 适配，Retina 模糊 | `web/js/modules/graph.mjs:185-186` | `canvas.width = rect.width * dpr; ctx.scale(dpr,dpr)` |
| 19 | 笔记编辑器 Tab 直接移出焦点，无缩进支持 | `web/js/modules/vault.mjs:1879-1890` | Tab 插两空格、Shift+Tab 去缩进 |
| 20 | 图谱面板无关闭按钮，`hideGraphPanel` 是死代码 | `web/js/modules/graph.mjs:49`、`web/index.html:246-258` | 头部加「✕ 返回」按钮 |
| 21 | 导出进度逐条 toast 刷屏 | `web/js/modules/projects.mjs:748` | 单个可更新持久 toast/迷你进度条 |
| 22 | 新建项目弹窗不支持 Enter 提交 | `web/index.html:1175`、`projects.mjs:1049-1051` | 输入框绑 Enter → createProject |
| 23 | AI 修改输入框单行 input，无法多行指令 | `web/index.html:761` | 换 textarea，Enter 发送 / Shift+Enter 换行 |
| 24 | 设计检查 lint 事件前端静默丢弃；lint 无问题时不发声 | `web/js/modules/projects.mjs:726-732`、`scripts/design-lint.mjs:279-285` | done 后 toast 摘要；0 问题也 emit |
| 25 | overview 模式键盘全死（Esc 无法退出，与 README 矛盾） | `ai-ppt-base/js/ppt.js:986,1069-1070` | overview 态单独处理 Esc/方向键/Enter |
| 26 | 翻页笔不支持：无 Space/PageDown/PageUp/Home/End | `ai-ppt-base/js/ppt.js:1035-1053` | onKeyDown 补这些键 |
| 27 | 放映帮助面板 hover 即关；快捷键清单缺 T/M/S/Shift+S 等 | `ai-ppt-base/js/ppt.js:956-958`、`ai-ppt-base/index.html:570-604`、`ai-ppt-base/README.md:24-34` | 延迟淡出；补清单 |
| 28 | ppt.css 内联 8 主题变量与 css/themes/ 重复且已发散（dark-mode 值不同） | `ai-ppt-base/css/ppt.css:2213-2292` | 删除内联块（themes.json 唯一数据源） |
| 29 | i18n 无 key 校验工具，漏 key 只能运行时发现 | 缺 `scripts/i18n-check.mjs` | 扫 `t()`/data-i18n 用量 diff en.mjs，挂 npm test |
| 30 | sw.js CACHE_VERSION 靠人工同步 package.json | `web/sw.js:7-9` | core.test.mjs 加一致性断言 |
| 31 | /ppt-anim skill 只写 4 种动画，引擎已 7 种（zoom/blur/flip 缺失） | `skills/ppt-anim/SKILL.md:14-30` | 补 3 种 |
| 32 | /ppt-export skill 缺 video/html/site 子命令 | `skills/ppt-export/SKILL.md:9-16` | 补齐 |
| 33 | 模板 lint 无护栏测试；skill 完整性无测试 | `tests/core.test.mjs` | 加「4 模板 design-lint 零问题」+「SKILL.md frontmatter 校验」用例 |
| 34 | package.json scripts 缺 design-lint/export-video 等入口 | `package.json:8-24` | 补 npm scripts |
| 35 | README 快速开始产物清单漏 ai-ppt.json | `README.md:135-141` | 补上 |
| 36 | snapshot/backup 全量拷贝含 export/，`.backup/` 已 1.6GB 且无 prune；restore 注释自称排除 export 但代码没排 | `scripts/snapshot.mjs:83,130`、`backup.mjs` | 默认排除 export/（加 --with-export 选项）；backup 加 BACKUP_KEEP；修注释 |
| 37 | upgrade-decks 覆盖项目引擎前无快照 | `scripts/upgrade-decks.mjs:109` | 每项目先 createSnapshot（--no-snapshot 可关） |
| 38 | search 无排序、snippet 固定取前 200 字与查询无关 | `scripts/search.mjs:147-156,163-165` | 命中加权排序；snippet 取命中词上下文 |
| 39 | Front Matter 手写拼接（tag 含逗号/引号会写坏 FM）与重复解析实现 | `scripts/fragments.mjs:70-79`、`knowledge-cards.mjs:128-144`、`generate-from-notes.mjs:31-34`、`generate-from-graph.mjs:30-33` | 统一走 `front-matter.mjs` 的 stringify/split |
| 40 | content-extractor 的 cleanText 把段落换行全压成空格（后续 `\n` replace 成死代码） | `scripts/content-extractor.mjs:158-166` | `/\s+/g` 改 `[^\S\n]+` |
| 41 | renameNote/deleteNote 不清理 note-order.json（幽灵条目）、不让 graph 失效 | `scripts/vault.mjs:170-177,259-291` | rename/delete 同步清理 + 标记图谱脏 |
| 42 | `GET /api/projects/:name/full` 的 readConfig 不在 try 内，ai-ppt.json 损坏 → 整个聚合端点 500 | `routes/projects.mjs:213` | 降级对齐其他子项 |
| 43 | 错误状态码混乱：磁盘错误被报成 400（多处 `|| 400`） | `routes/projects.mjs:208`、`vault-notes.mjs:238,253`、`vault-fragments.mjs:157,168` 等 | 业务校验显式 400，兜底一律 500 |
| 44 | Onboarding：Esc 关闭不写 flag 下次又弹；老用户（已有笔记/项目）也被强制引导 | `web/js/modules/app.mjs:344-349,431-433` | Esc 也 persist；有数据时跳过 |
| 45 | PWA 无更新提示（skipWaiting 静默换版）；运行时缓存无上限（mp4 永久驻留） | `web/sw.js:85,95,121-123`、`app.mjs:446-451` | controllerchange → 「点击刷新」toast；大文件/媒体跳过 cache.put |
| 46 | 全局 `prefers-reduced-motion` 缺失；放映翻页固定 350ms 不照顾 reduced-motion | `web/css/web.css`（0 命中）、`ai-ppt-base/js/ppt.js:1178-1182` | 全局媒体查询；JS 检测后 0ms |
| 47 | vault 路由聚合靠 slice 下标硬编码，无测试护栏 | `routes/vault.mjs:21-34` | 加「聚合后 method+pattern 序列快照」测试 |
| 48 | `assertSafeProjectName` 宽松 vs `createProject` 严格，校验形同虚设 | `scripts/config.mjs:42-46,160` | 统一用 PROJECT_NAME_RE |
| 49 | findChrome 不校验 PUPPETEER_EXECUTABLE_PATH 存在性（findFfmpeg 有校验） | `scripts/export-pptx.mjs:672` vs `export-video.mjs:101` | 对齐校验 |
| 50 | 视频导出成功残留 frames/、逐页时长文案不准、CLI 未知参数静默 | `scripts/export-video.mjs:161,186-190` | 成功清 frames；文案改总时长；拒绝未知参数 |

---

## 批次二：中等功能修复与保护（数据安全/正确性）

1. **生成/AI 修改并发互斥**：chat 只查 chats store、generate 只查 generators store，同项目可并发写同一 index.html。抽 `hasAnyProjectTask(name)` 同时查 generators/chats/exports，冲突 409。`routes/projects.mjs:294,358`
2. **任务取消端点**：generate/chat/export 均无取消（kill 链路在 `spawnNdjsonTask` 现成）。加 `POST .../generate|chat|export/:type/cancel` + 前端按钮。`server.mjs:190`
3. **LLM 失败静默兜底**：401 也产出兜底模板置 ready；`diagnoseError`/`fallbackChain` 没透出。把最后真实错误经 NDJSON 透出，前端区分「LLM 生成 / 兜底模板」。`llm-adapter.mjs:32-35`、`generation-common.mjs:368`、`generate-deck.mjs:176`
4. **LLM 请求无超时无重试**：fetch 无 AbortSignal，挂起 = 任务永远 running。加超时（120s）+ 429/5xx 一次重试。`llm-adapter.mjs:116,164`
5. **编辑态未保存丢失**：editModeActive 时切项目/chat 完成/快照恢复/主题应用直接重写 iframe src。加守卫弹确认或自动保存。`web/js/modules/projects.mjs:78-92,319,474,560,582,613-616`
6. **生成弹窗参数撒谎**：单篇笔记生成时页数/受众/风格被静默忽略；includeLinked 硬编码 false。透传 params + 加复选框。`web/js/modules/generate.mjs:106-112,136-148`、`routes/vault-notes.mjs:263-272`
7. **userEdits 不可见不可解除**：配置面板加「N 页受保护 + 清除」+ 后端置空端点；且 userEdits 按页码引用，局部增删页后错位——改按 heading 匹配。`scripts/save-edits.mjs:48-53`、`generation-common.mjs:176-185`
8. **chat-note 无截断校验**：max_tokens 8192，长笔记静默截尾。长度 <60% 且指令无缩简语义时拒绝写入并提示。`scripts/chat-note.mjs:86-110`
9. **minSections 整份丢弃可用 LLM 输出**：差 1 页也换粗略兜底。低于预期保留 LLM 结果 emit 警告，硬下限才回退。`generation-common.mjs:361-366`
10. **PPTX 导出兜底渲染**：普通 `<p>`、`<ul>/<li>`、`<img>/<video>`、多 hero-stat 合并错误、老类名不匹配——实测真实 deck 只剩标题。加通用渲染兜底 + skipped 警告；颜色跟随 deck 主题。`scripts/export-pptx.mjs:24-33,198-205,510-628`
11. **测验作答闭环**：exams 只读展示答案。加「开始作答→判分→低分自动入错题」模式。`web/js/modules/exams.mjs:143-170`
12. **知识图谱失效机制**：笔记增删改后 graph 永远返回旧图。存内容指纹，脏则自动重建；大库构建 O(N×D) 阻塞事件循环需优化。`scripts/knowledge-graph.mjs:133-141,186-195`
13. **报告无处可看**：补 `GET/DELETE /api/vault/reports/:name` + 前端查看/删除入口。`routes/vault-graph.mjs:128`（列表端点目前是死代码）
14. **静态服务不支持 HTTP Range**：音频无法拖进度、iOS Safari 可能拒播、80MB 整读内存。`sendFile` 改流式 + 206。`server.mjs:131-142`
15. **已发布版本无法下线**：补 `DELETE .../publish/:version` 与整体下线。`routes/projects.mjs:582`
16. **笔记索引写放大 + 搜索无上限**：单篇保存重写全库索引文本；searchNotes 无 limit。`scripts/link-resolver.mjs:86,168-171,220-256`
17. **速记碎片不可编辑**：加编辑操作 + `PUT /api/vault/fragments/:id` 支持改 content。`web/js/modules/fragments.mjs:85-92`
18. **chat-modify 局部协议不支持删页/中间插页**：扩展 `=== slide N delete ===`、`=== slide new after N ===`。`scripts/chat-modify.mjs:49-97`
19. **LAN 模式零认证 + CSRF 面**：`AI_PPT_TOKEN` 可选认证；mutation 校验自定义头。`server.mjs:54,648-666`
20. **素材超限静默截断**（6000 字无提示）；LLM 等待期间 SSE 无心跳；降级链 model/耗时不透出。`generation-common.mjs:285,359`、`generate-deck.mjs:91`

---

## 批次三：功能项（需设计投入）

1. **放映引擎**：触屏滑动翻页（iPhone 无 Fullscreen API 时零翻页手段）、URL hash 深链（`#/n`）、B/W 黑屏白屏、演讲者模式三栏（当前页|下一页|备注）+ 计时暂停/倒计时、激光笔、标识笔 Ctrl+Z、页内 fragment 分步动画、autoplay/kiosk、16:9 选项、含备注打印版式。`ai-ppt-base/js/ppt.js`
2. **Web 管理界面深色模式**：`:root` 变量抽 `[data-theme]`，52 处 rgba 阴影 + ~20 个 hex 需变量化。`web/css/web.css`
3. **弹窗 a11y**：20+ 弹窗无 role/aria-modal/焦点圈定/焦点恢复；搜索结果/列表项不可聚焦、无方向键导航。`web/index.html:1169-1657`、`modals.mjs`
4. **i18n 补齐**：cards(39)/exams(86)/graph(9)/fragments(14)/vault(9) 处裸写中文未走 t()。
5. **图谱交互**：touch 事件、节点搜索定位、布局持久化、Map 索引替代 find、关闭入口（快赢在批次一）。`web/js/modules/graph.mjs`
6. **测验/复习体验**：完成页成绩统计 + 重练忘记项、复习键盘操作（空格翻卡、1-5 评分）、语音听记完成后试听/重录。
7. **全局搜索聚合 vault**：顶栏搜索只搜 projects，不搜笔记/碎片（产品是「以笔记为中心」）。`scripts/search.mjs:52-61`
8. **查询 DSL 增强**：contains/数值/日期比较、结果排序（前后端同步）。`scripts/vault-features.mjs:190-233`
9. **单文件 HTML 真单文件**：img/video/CSS url() base64 内联（设体积上限）。`scripts/export-single-html.mjs:20-39`
10. **块引用/查询块 N+1 请求**：批量端点或并发+缓存。`web/js/modules/vault.mjs:929-954`
11. **ppt.js 移动端侧边栏默认收起、主题变量双份删除、缩略图终态补偿三处复制抽函数**等（详见引擎审查节）。

---

## 批次四：文档与 DX

1. **README/README.en 严重脱节**：badge 停 2.7.0（实际 2.8.1），更新日志止 v2.6，v2.7–2.8.1（发布+二维码/视频导出/data-chart/场景模板/主题画廊/design-lint/i18n/PWA）全部未写；目录结构图过时（缺 templates/routes/vault/demo/published，scripts 只列 6/46）。
2. **skill 质量断层**：ppt-publish/ppt-theme 只有命令语法无实现步骤，ppt-theme 注意事项描述错误（实际改 body class + ai-ppt.json）；/ppt-structure 产出缺 css/themes/ 与 theme-links（按 T 切主题 404），应改调 `createProject()`；frontmatter 格式中英两套并存。
3. **两套服务启停脚本 PID 文件不同**（`.service.pid` vs `server.pid`），互相停不掉；6 个根目录脚本未登记。合并为一对。
4. **无 CI**：193 单测 + smoke 无自动化入口；tests badge 硬编码「193 passed」。
5. **根目录杂物**：`fix-themes.mjs`、`update-project-indexes.mjs`（一次性脚本）、`UPGRADE-PLAN*.md`、`KNOWLEDGE_BASE_PLAN.md`、`MEMORY.md`（停 v2.3.0，与 AGENTS.md 职责重叠且腐坏）——归档或删除。
6. **install-skills.sh 与 .js 漂移**：sh 不支持 Claude Code/--dry-run/--uninstall，README 却把 sh 列为方式一。
7. **重复实现**：`run()`/`whichCmd()`（parse-asset vs media-gen 逐字相同）、`isUnsafeName`/`escapeRegExp` 多份、CLI 进程工具可抽 `scripts/cli-utils.mjs`；store.mjs 事件语义不一致（注册 change 发 set/delete）。
8. **CLI 覆盖面不齐**：vault 无 rename/backup 查询、fragments 无 update、organize 只有 suggest 无 apply；CLI 帮助/退出码不统一。
9. **模板**：training-course/review-lesson 无 data-chart 示例（条目 16 只一半做到）；模板场景可扩充（产品发布/OKR 复盘/立项）。
10. **package.json `files` 漏 tests/、CONTRIBUTING.md**。

---

## 已核实无问题（避免重复排查）

- 路径注入防护（isSafeName / isWithinRoot）、上传后缀+魔数双校验、multipart 流式不驻留内存、孤儿 .part 清理。
- SSE 心跳/buffer 上限/旧连接取代/进程退出补终态；任务中断恢复（interrupted 标记）。
- 笔记渲染管线 XSS 防护（整体转义→占位→marked→回填）；碎片白名单校验。
- 快照 ID 防注入、restore 前安全快照、prune 保留策略。
- 静态 i18n 覆盖实测 ~100%（349 个 data-i18n key）；SW 预缓存清单与模块文件吻合。
- 快捷键清单与实现当前同步（但是三处手工维护，长期可数据驱动）。
- ffmpeg concat 末帧重复 + `-t` 裁剪正确；导出并发控制（409/429）正确。
- `npm test` 193/193 通过（审查时实跑）。

## 执行提示

- 改 `ai-ppt-base/` 后需 `npm run upgrade-decks` 同步到项目（条目 2）；改 `web/` 静态资源后 bump package.json version 对齐 sw.js CACHE_VERSION（条目 34）。
- 批量改动前 `npm run backup`（批次一 #36 修好后会自动排除 export/）。
- 新增 UI 文案必须走 t()/data-i18n 并同步 en.mjs（条目 35）。
- 新增快捷键需同步 `#help-panel` 清单（条目 29）。
