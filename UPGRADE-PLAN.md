# ai-ppt 升级方案

> 决策(已确认,2026-07-11):
> 1. **deck 视觉以 Web UI 为唯一基准**--采用 Web UI 的 token 与字体(`#0D9488` / `#1A2332` / `#F7F8FA` 冷灰 / 无衬线 `PingFang SC`)。三处 teal 统一到 `#0D9488`;字体子集由 Noto Serif SC 改为 Noto Sans SC。
> 2. 本轮**只出书面方案,不写代码**。
> 3. 推进顺序:先出完整四阶段方案(本文件)。
>
> 方案基准:`main` 分支 HEAD = `e0c7523`。工作区有未提交改动(把 teal-editorial 改写成 "Modern Business"),本方案即围绕"如何收口到 Web UI 视觉 + 修复既有缺陷"展开。

---

## 0. 背景与关键事实核实

### 0.1 工作区未提交改动(`git diff --stat HEAD`)

| 文件 | 变化 | 性质 |
|------|------|------|
| `ai-ppt-base/css/ppt.css` | +357/-255(911->1049 行) | 改写成 "Modern Business" 无衬线主题(非目标方向,但其布局类最全) |
| `ai-ppt-base/js/ppt.js` | +2 | 仅新增 `window.goTo = goTo;`(有用,`screenshot-check.mjs:32` 依赖) |
| `scripts/export-pptx.mjs` | ±32 | COLORS 改为 56B3A9 系;字体仍 `Songti SC`/`PingFang SC` |
| `scripts/screenshot-check.mjs` | ±2 | 默认 deck 名 |
| `AGENTS.md` / `MEMORY.md` | +5/+6 | 仅补"数据页排版原则"段落(与主题无关,保留) |
| `ai-ppt-base/fonts/*.ttf`(新) | 3 个 Noto Serif SC 子集 | 字体族将改为 Noto Sans SC,需重下 |
| `scripts/build-fonts.mjs`(新) | 下载子集 | family 参数改 Noto Sans SC |

### 0.2 三套来源的对比(决定合并策略)

| 来源 | teal | ink | cream | 字体 | 布局类完整度 |
|------|------|-----|-------|------|-------------|
| HEAD `ppt.css`(911 行,teal-editorial) | `#439288` | `#151A19` | `#FAFAF7` | 衬线正文 | 全(无 `.hero-headline`/`.hero-meta`) |
| 工作区 `ppt.css`(1049 行,Modern Business) | `#56B3A9` | `#111827` | `#FFFFFF` | 无衬线 | **最全**(含 `.hero-headline`/`.hero-meta`/扩写 `.section-hero`) |
| **Web UI `web/css/web.css`(基准)** | **`#0D9488`** | **`#1A2332`** | **`#F7F8FA`** | **无衬线 PingFang SC** | -- |

结论:目标 token = Web UI;布局类来源 = 工作区(最全)。**不是盲 `git checkout` HEAD**(会丢 `.hero-headline`/`.hero-meta`/扩写 `.section-hero`),也不是保留工作区 token(值不对)。

### 0.3 合并策略:工作区布局类 + Web UI token + 兼容别名

1. 以**工作区 `ppt.css`(1049 行)为布局基线**(类最全)。
2. **重写 `:root`** 为 Web UI token 值,并同时定义"兼容别名",让工作区里所有引用 `--accent`/`--surface`/`--border`/`--muted` 等的规则无需逐处改即可解析到 Web UI 值。
3. **深色面重映射**:工作区用 `var(--ink)` 作 `.code-block`/`.highlight-box`/`.ppt-table th`/`.toast`/`.help`/`.progress` 的底色;Web UI 用 `--navy:#0F172A` 作深色面。将这些组件底色改为 `var(--navy)` 以精确对齐 Web UI。
4. **字体**:标题与正文统一 `PingFang SC / Noto Sans SC` 无衬线。
5. `ppt.js` 保留 `window.goTo`(HEAD 没有,有用)。

**deck `:root` 目标值**

```css
:root {
  /* Web UI 主 token(deck 唯一视觉基准) */
  --ink:#1A2332; --cream:#F7F8FA;
  --tile:#EEF1F5; --tile-strong:#E0E4EA;
  --teal:#0D9488; --teal-light:#14B8A6; --navy:#0F172A;

  /* 兼容别名:让工作区布局类解析到 Web UI 值 */
  --accent: var(--teal);            /* #0D9488 */
  --accent-light: var(--tile);     /* #EEF1F5 */
  --accent-dark: var(--teal-light);/* #14B8A6 */
  --surface: #FFFFFF;              /* 卡片白底,叠在冷灰页面上 */
  --surface-subtle: var(--tile);
  --border: var(--tile-strong);
  --border-strong: var(--tile-strong);
  --slate: var(--ink);             /* 配合 opacity 做层级,见 §0.4 */
  --muted: var(--ink);

  --font-heading: "PingFang SC", "Noto Sans SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --font-body: "PingFang SC", "Noto Sans SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --font-mono: "SF Mono", "Fira Code", "Menlo", monospace;

  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
}
```

### 0.4 Web UI 设计语言规格(本轮新增项的基准)

从 `web/css/web.css` 提取,作为 deck 组件重做时的对照:

| 维度 | Web UI 取值 | deck 对应 |
|------|------------|-----------|
| 强调色 | `--teal #0D9488` | kicker 底、badge、icon、big-number、focus、按钮、section-title 色 |
| 深色面 | `--navy #0F172A` | code-block、table th、highlight-box、toast、help、progress |
| 页面底 | `--cream #F7F8FA`(冷灰) | slide 背景 |
| 卡片 | 白底 + `1px solid var(--tile-strong)` + `0 1px 3px rgba(0,0,0,0.04)` | tile/visual-card |
| 层级手法 | **opacity 0.45 / 0.55 / 0.6 / 0.75** 取代另设灰 token | 次级文字、meta、label |
| section-title | 13px / 700 / `letter-spacing:0.08em` / uppercase / teal | deck `.section-title` 对齐 |
| 状态色 | soft-pill:`rgba(色,0.12)` 底 + 实色字 | deck `.badge` 改 soft-pill |
| radius | card 12px、input/btn 6px、pill 20px | deck 对齐 |
| 字体 | 无衬线 PingFang SC | 标题+正文统一 |
| 动效 | `background/transform 0.2s ease`、revealUp | deck 已有,保留 |

---

## 阶段 1 · 止血(安全 + 可见 Bug)

> 目标:消除 CRITICAL/HIGH 安全问题与用户能直接看到的 bug。**不重排主题 token**(阶段 2 做)。预计半天。

### 1.1 [S1 CRITICAL] 修复路径穿越
- **文件**:`server.mjs:264-280`(serveStatic)、`server.mjs:308-315`(projectMatch 静态分支)
- **问题**:`path.join(root, urlPath)` 不校验结果是否仍在 `root` 下;`GET /projects/x/../../server.mjs` 可越狱读任意文件。
- **改动**:`const resolved = path.resolve(root, urlPath);` 后断言 `resolved === root || resolved.startsWith(root + path.sep)`,否则 403;对 project 静态分支的 `name` 段再校验 `getProjectDir(name)` 归属。
- **验证**:`curl 'http://localhost:3456/projects/q3-sales-preview/..%2f..%2fserver.mjs'` 应 403。
- **回滚**:还原 `serveStatic`。

### 1.2 [S2 HIGH] 修复 SSRF
- **文件**:`scripts/content-extractor.mjs:6-19`、`:17`
- **改动**:URL 协议白名单 `http/https`;解析 IP 拒绝 `127/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`::1`、`fc00::/7`;`redirect:'manual'` 手动判断 Location;`AbortController`+10s 超时;流式读累计上限 1MB 截断。
- **验证**:写入 `sourceUrl:"http://169.254.169.254/latest/meta-data/"` 触发生成,应在 extract 步骤报错。
- **回滚**:还原 `extractFromUrl`。

### 1.3 [S3 HIGH] API Key 不落盘 + 收紧 CORS
- **文件**:`scripts/config.mjs:228-231`、`:185-204`、`scripts/generate-deck.mjs:338-344`、`server.mjs:288`、`server.mjs:196-208`
- **改动**:① `ai-ppt.json` 只存 `presetId/provider/baseUrl/model`,不存 `apiKey`;② Key 从 `.env.kimi`/环境变量启动注入,Web UI"临时 key(仅本会话)"不回写;③ CORS 收敛到 `localhost/127.0.0.1`(待定是否加 bearer,见待定决策);④ 迁移:读 cfg 时剥离已存 apiKey 并提示。
- **验证**:`grep apiKey projects/*/ai-ppt.json` 为空;跨域页面调 `POST /api/projects` 被拦。
- **回滚**:还原 writeConfig(不推荐)。

### 1.4 [B1 HIGH] 修复 `var(--teal)` 失效
- **文件**:`ai-ppt-base/index.html:225,229,233,237`、`web/css/web.css:63,236,294,313,345`
- **现状**:工作区 deck CSS 删了 `--teal`,引用解析失败;Web UI 的 `--teal:#0D9488` 本身正常。
- **改动**:阶段 2 重写 deck `:root` 会定义 `--teal:#0D9488`,自动修复 deck 侧;**阶段 1 先保险**--在当前工作区 `:root` 临时补 `--teal:#0D9488;`(与目标值一致,避免阶段 1 期间数据页无色)。
- **验证**:base deck 第 8 页大数字呈 teal;F12 无空解析。
- **回滚**:移除临时 `--teal`(阶段 2 会正式定义)。

### 1.5 [B5/B7 MED] Web UI 状态同步与静默失败
- **文件**:`web/js/web.js:237-243`(saveConfig 硬编码 draft)、`:83-95`(loadModels 空选)、`:267-316`(SSE 静默)、`:262,297`
- **改动**:① `saveConfig` 保存后 `GET /api/projects/:name/config` 重新拉真实 cfg 再 render;② `loadModels` 失败保留"加载失败"占位 option;③ SSE `onerror` 关流时 `showToast('生成连接中断')` 并可重试。
- **验证**:ready 项目改标题保存,徽标保持 ready;断网生成出现 toast。
- **回滚**:还原对应函数。

### 阶段 1 验收清单
- [ ] 路径穿越 403
- [ ] SSRF 内网/元数据被拒
- [ ] `ai-ppt.json` 无明文 apiKey
- [ ] `var(--teal)` 在 deck 解析为 `#0D9488`
- [ ] Web UI 保存不篡改 status;SSE 断开有提示

---

## 阶段 2 · 引擎统一(对齐 Web UI + 字体接入 + 导出对齐)

> 目标:把 deck 主题、字体、导出、生成兜底全部对齐到 Web UI 视觉基准。预计 1 天。**依赖 1.4 已合并或先合**。

### 2.0 [新增项] deck 视觉对齐 Web UI
- **文件**:`ai-ppt-base/css/ppt.css`(`:root` 重写 + 深色面重映射 + 组件风格对齐)、`ai-ppt-base/index.html`(示范 deck 校验)
- **改动**(按 §0.3 / §0.4 执行):
  1. 重写 `:root` 为 §0.3 的 Web UI token + 兼容别名块。
  2. 深色面重映射:`.code-block`/`.highlight-box`/`.ppt-table th`/`.toast`/`.help`/`.progress` 的 `background: var(--ink)` -> `var(--navy)`。
  3. `.section-title` 对齐 Web UI:`font-size:13px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:var(--teal)`。
  4. 次级文字层级改用 opacity(对齐 Web UI 手法):`.project-meta`/`.tile p`/`p.lead` 等用 `color:var(--ink); opacity:0.6/0.75`,替代单独灰 token。
  5. 卡片阴影对齐:`.tile`/`.visual-card` 阴影收敛为 `0 1px 3px rgba(0,0,0,0.04)`,边框 `1px solid var(--tile-strong)`。
  6. **保留**工作区新增的 `.hero-headline`/`.hero-meta`/扩写 `.section-hero`(经别名解析无需改)。
- **验证**:浏览器开 base deck--冷灰底、白卡极淡阴影、teal#0D9488 强调、navy 深色面、无衬线;F12 computed style 无 `var(--*)` 空解析;screenshot-check 5 断点(320/768/1024/1440/1920)视觉回归。
- **回滚**:`git checkout` 工作区版 `:root` 后重粘别名。

### 2.1 主题合并落地(把 2.0 的改动合并进基线)
- **文件**:`ai-ppt-base/css/ppt.css`、`ai-ppt-base/js/ppt.js`
- **步骤**:
  1. 保留工作区 1049 行布局基线(不 checkout HEAD)。
  2. 用 §0.3 的 `:root` 覆盖当前 `:root`。
  3. 执行 2.0 第 2-5 步的组件级 remap。
  4. `ppt.js` 保留 `window.goTo = goTo;`。
- **验证**:与 2.0 一致;另 `diff -q ai-ppt-base/css/ppt.css projects/q3-sales-preview/css/ppt.css` 在 `upgrade-decks` 后为空。
- **回滚**:还原 `:root` 与组件 remap。

### 2.2 字体子集化接入(改为 Noto Sans SC)
- **文件**:`scripts/build-fonts.mjs`、`ai-ppt-base/css/ppt.css`(@font-face)、`scripts/config.mjs:45-51`(ensureBaseEngine)、`scripts/upgrade-decks.mjs:10-11,78-111`、`ai-ppt-base/fonts/*`(重下)
- **改动**:
  1. `build-fonts.mjs`:`family` 参数 `Noto Serif SC` -> `Noto Sans SC`;删除旧 `noto-serif-sc-*.ttf`,重下 `noto-sans-sc-{400,600,700}.ttf`;字符提取范围已含 `ai-ppt-base/index.html` + `projects/*/index.html`,保留;"字符集为空则跳过"保护。
  2. `ppt.css` 顶部加 `@font-face` 三档字重 `src: url('fonts/noto-sans-sc-<w>.ttf') format('truetype')`,`font-display: swap`。
  3. `--font-heading`/`--font-body` 首位放 `"Noto Sans SC"`(本地子集优先,系统 PingFang SC 兜底)。
  4. `ensureBaseEngine`(建项目)与 `upgrade-decks.mjs`(同步)新增 `fonts/` 目录拷贝。
- **验证**:新建项目 `ls projects/new/fonts/` 有 3 个 ttf;Puppeteer `file://` 导出前 page 能加载本地字体。
- **回滚**:删 `@font-face` 与 `fonts/` 拷贝;若放弃子集化则连 `build-fonts.mjs`+`fonts/` 一并删。
- **注意**:`@font-face` 路径用相对 `fonts/...`,随项目分发后单 deck 可独立移动(符合 AGENTS.md 路径约定)。

### 2.3 导出对齐(PPTX/PDF)
- **文件**:`scripts/export-pptx.mjs:11-19`(COLORS)、`:21-22`(FONT)、`renderHero`/`renderSlide` 新类分支
- **改动**:
  1. `COLORS` 对齐 Web UI:`teal:'0D9488'`、`ink:'1A2332'`、`cream:'F7F8FA'`、`tile:'EEF1F5'`、`tileStrong:'E0E4EA'`、`navy:'0F172A'`、`slate:'1A2332'`(配合导出端用实色,不走 opacity)。
  2. 字体:`FONT_HEADING`/`FONT_BODY` 均改 `'PingFang SC'`(无衬线,与 deck/ Web UI 一致)。**待定决策 1 由此结案:正文中文用 PingFang SC 无衬线。**
  3. `renderSlide` 新增对 `.hero-headline`/`.hero-meta`/`.section-hero` 的渲染分支(目前会漏内容)。
- **验证**:`npm run export-pptx -- q3-sales-preview` 后用 Keynote/PowerPoint 打开:teal#0D9488、冷灰底、navy 表头、无衬线、无元素缺失。
- **回滚**:还原 COLORS/FONT。

### 2.4 生成兜底去硬编码 + 修正状态标注
- **文件**:`scripts/generate-deck.mjs:158-177`、`:356-363`、`:163-175`
- **改动**:① cover/quote/stats/thankyou 文案改 `cfg.params` 派生或中性占位;② `sections.slice(0,6)` -> `Math.min(sections.length, cfg.params.slideCount - 4)`;③ 走兜底时 `setStatus(name,'draft')` + `errorMessage:'未配置 LLM,已生成占位骨架'`。
- **验证**:无 key 生成任意文章,cover 出该文章标题;`ai-ppt.json.status==='draft'`。
- **回滚**:还原函数。

### 2.5 LLM 调用健壮性
- **文件**:`scripts/llm-adapter.mjs:54-99`、`:38-39`、`:8-28`、`:74-89`
- **改动**:`callOpenAI` 加 `AbortController` 30s 超时;5xx/429 退避重试 1 次;错误经 `emit('llm-error',msg)` 上抛而非静默;`callBailian` 改 stdin 传 prompt。
- **验证**:`baseUrl` 指向不通地址,30s 内报 `llm-error` 并走兜底。
- **回滚**:还原。

### 阶段 2 验收清单
- [ ] deck `:root` = Web UI token + 兼容别名;深色面用 `--navy`
- [ ] `.section-title` uppercase teal;卡片极淡阴影;opacity 层级
- [ ] `fonts/` 为 Noto Sans SC,随 `ensureBaseEngine`/`upgrade-decks` 分发
- [ ] PPTX 导出色/字体与 deck 一致;新类有渲染分支
- [ ] 兜底无 Q3 硬编码,状态标 `draft`
- [ ] LLM 调用有超时/重试/错误上报

---

## 阶段 3 · 工具链与一致性

> 目标:让升级/备份/发布/文档可信。预计 1 天。**依赖 2.2 完成**。

### 3.1 `upgrade-decks.mjs` 增强
- **文件**:`scripts/upgrade-decks.mjs:10-11,78-111,88-91`
- **改动**:同步列表 `css/ppt.js` + `fonts/`;`ai-ppt.json` 写 `engineVersion`(读 `package.json`);`--dry-run` 输出受影响项目与文件清单。
- **验证**:`npm run upgrade-decks -- --dry-run` 列出每个项目将更新的文件含 `fonts/`。
- **回滚**:还原。

### 3.2 `backup.mjs` 补全
- **文件**:`scripts/backup.mjs:13`、`:31-47`
- **改动**:纳入 `ai-ppt-base/`、`scripts/`、`install-skills.js/.sh`;排除 `node_modules`、`export/`、`.DS_Store`、`*.zip`、`.backup/`;`.env.kimi` 单独提示。
- **验证**:`npm run backup` 后 `.backup/<ts>/` 含 `ai-ppt-base/` 与 `scripts/`,不含 `export/*.pptx`。
- **回滚**:还原。

### 3.3 仓库卫生
- **文件**:`.gitignore`、`projects/`
- **改动**:`.gitignore` 加 `.DS_Store`、`*.zip`、`projects/*/export/`;`git rm --cached` 清已提交的 `.DS_Store`、`xinrenxinshi-huaxia-bank.zip`。
- **验证**:`git status` 干净后再次生成/导出不产生新 tracked 杂物。
- **回滚**:还原 `.gitignore`。

### 3.4 文档与版本对齐
- **文件**:`README.md`、`AGENTS.md`、`MEMORY.md`、`package.json:3`、`skills/ppt-edit/SKILL.md:57`
- **改动**:
  1. `package.json` version `1.1.0` -> `1.8.0`(本轮升级起一个新 minor)。
  2. README 结构块(`:7-46`):删不存在的 `aoji-company/test-new-css/yellow-books/xinrenxinshi-usagestobank`;补 `ai-ppt-base/fonts/`、`scripts/llm-adapter.mjs`、`content-extractor.mjs`、`build-fonts.mjs`。
  3. README "可用 Deck" 表(`:242-249`)对齐实际 `projects/`。
  4. README changelog 加 v1.8.0:**"deck 视觉统一对齐 Web UI(#0D9488/无衬线 PingFang SC),字体子集改 Noto Sans SC 接入分发,安全加固(路径穿越/SSRF/apiKey 不落盘)"**;更正 v1.7.2/v1.7.3 里"衬线标题/teal#439288"的描述(已为新方向取代)。
  5. `ppt-edit/SKILL.md:57`:`.cover-slide` -> `.section-hero`。
  6. `AGENTS.md`/`MEMORY.md`(项目内):补"deck 视觉基准 = Web UI""字体子集 Noto Sans SC""apiKey 不落盘""路径校验"约定;删除/修正"teal-editorial 衬线 #439288"旧描述。
- **验证**:通读三份文档,与代码 grep 交叉核对类名/路径/版本号/teal 值一致。
- **回滚**:`git checkout` 对应文档。

### 3.5 清理 `ai-ppt.json` 残留字段
- **文件**:`scripts/config.mjs:206-213`、各 `projects/*/ai-ppt.json`
- **改动**:迁移逻辑无条件移除 `params.model`(被 `modelConfig.model` 取代);移除 `apiKey`(配合 1.3)。
- **验证**:升级后所有 `ai-ppt.json` 无 `params.model`、无 `apiKey`。
- **回滚**:还原 migrate。

### 阶段 3 验收清单
- [ ] `upgrade-decks --dry-run` 含 fonts/ + engineVersion
- [ ] backup 含 ai-ppt-base + scripts,不含 export/
- [ ] .gitignore 干净,无 .DS_Store/.zip 入库
- [ ] package.json 版本与 changelog 一致;文档 teal 值统一 #0D9488
- [ ] 文档类名/路径与代码一致

---

## 阶段 4 · 设计提升(可选)

> 目标:把 deck 从"对齐 token"提升到"有 Web UI 那种克制气质";Web UI 视觉不动(用户喜欢),只补无障碍。预计 1 天。可与阶段 3 并行。
> **注意:本轮不再"重做 Web UI 视觉"--用户明确喜欢 Web UI 现有风格,只做 a11y 修补。**

### 4.1 Web UI 无障碍修补(不碰视觉)
- **文件**:`web/index.html`、`web/css/web.css`(仅 ARIA 相关)、`web/js/web.js`
- **改动**:tabs 加 `role=tablist/tab/tabpanel`+`aria-selected`;modal 加 `role=dialog`/`aria-modal`/Esc 关闭/焦点陷阱;删除按钮加 `aria-label`;toast 加 `aria-live=polite`/`role=status`;`<label for>` 关联 input。
- **验证**:键盘 Tab 走查;`axe-core` 扫描 0 critical;Lighthouse a11y > 90。
- **回滚**:`git checkout` 对应属性(纯属性,易回滚)。

### 4.2 deck 版式 opinionated 化(以 Web UI 审美为基准)
- **文件**:`ai-ppt-base/css/ppt.css`(版式)、`ai-ppt-base/index.html`(示范)
- **方向**:用现有组件做更克制排版--数据页 bento(4 格不等宽,去掉等宽三卡的模板感)、引用页全屏大字、封面大字+留白、badge 改 soft-pill;减少视觉冗余,层级靠 opacity 与字号差。
- **验证**:screenshot-check 5 断点视觉回归;cover/data/quote 三版式截图对比基线。
- **回滚**:`git checkout` 对应文件。

---

## 执行顺序与依赖

```
阶段1(止血)── 1.1/1.2/1.3/1.4/1.5 互不依赖,可并行
                 │(1.4 先补 --teal:#0D9488)
                 ▼
阶段2(对齐 Web UI)── 2.0 deck 视觉对齐 ── 2.1 落地合并
   2.2 字体(Noto Sans SC)─┐
   2.3 导出对齐 ───────────┤(依赖 2.0 token)
   2.4 兜底 ───────────────┤
   2.5 LLM ────────────────┘
                 ▼
阶段3(工具链)── 3.1 需 2.2 的 fonts 分发;3.2/3.3/3.4/3.5 可并行
                 ▼
阶段4(设计,可选)── 4.1 Web UI a11y / 4.2 deck 版式,可与阶段3并行
```

## 风险与回滚

| 风险 | 影响 | 缓解 |
|------|------|------|
| `:root` 别名遗漏某 token | 移植类渲染异常 | F12 全量扫 computed style;回滚别名块 |
| `@font-face` 路径在打包/移动后失效 | 字体回退系统字 | 相对路径 `fonts/...`+`upgrade-decks` 随项目分发 |
| apiKey 改内存持有后重启丢失 | 生成回退兜底 | 启动从 `.env.kimi` 注入;Web UI 提示重填 |
| 字体子集字符不全 | 个别字回退系统字 | `build-fonts.mjs` 扫描全量 `index.html`;缺字告警 |
| Noto Sans SC 子集体积大于 Serif | 首屏略慢 | 子集化本身已按用字裁剪;`font-display:swap` |
| deck 视觉大改后旧导出物不一致 | 历史 PPTX 风格断层 | 在 changelog 标注 v1.8.0 为视觉断点;可重导出 |

## 待定决策(执行前需确认)

1. ~~PPTX 正文中文字体~~:**已结案**--用 `PingFang SC` 无衬线,与 deck/ Web UI 一致(见 2.3)。
2. **CORS 收敛程度**:`localhost` only,还是加 `AI_PPT_TOKEN` bearer?取决于是否需远程访问。
3. **阶段 4 是否纳入本轮**:还是先只做 1-3,设计提升单独立项。(注:阶段 4 已不含"重做 Web UI",仅 deck 版式 + Web UI a11y。)
