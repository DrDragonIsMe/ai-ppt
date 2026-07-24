# ai-ppt

个人知识中枢：**速记碎片 → AI 整理与加权星图 → PPT/配图/视频表现 → 智能测验迭代** 的闭环系统。基于 HTML/CSS/JS 的轻量级幻灯片引擎（键盘导航、全屏放映、多页预览、PDF 导出）+ 内置知识库 vault（双链笔记、速记碎片、知识卡片、测验、错题集），支持从 URL、文章、笔记或星图选区自动生成完整 deck，并可用 AI 生成配图与视频。附带 Claude CLI / Kimi CLI 的 skill 扩展：`/ppt-preview`、`/ppt-structure`、`/ppt-edit`、`/ppt-export`、`/ppt-list`、`/ppt-delete`、`/ppt-design` 等 11 个（见下文「可用 skill」）。

## 概念模型

系统由两类实体构成，「选材」是连接两者的桥梁：

- **知识库（个人资产）**：速记碎片 → AI 整理 → 笔记 / 知识卡片 → 加权星图 → 测验与错题巩固。知识库内容与任何项目无关，长期沉淀。
- **PPT 作品（项目）**：`projects/` 下的每个项目就是一份 PPT 作品，生命周期为流水线四步：**① 选材 → ② 生成 → ③ 修改 → ④ 发布**（导出 PDF / PPTX / 单文件 HTML）。
- **选材**：在项目工作区内从知识库勾选笔记 / 卡片 / 碎片 / 错题作为素材（持久化到 `ai-ppt.json.sourceSelection`），也可以直接粘贴文章或提供 URL；素材汇总后进入生成步骤。

```
知识库（个人资产，与项目无关）                PPT 作品（projects/<name>）
┌───────────────────────────────┐        ┌─────────────────────────────┐
│ 速记碎片 → AI 整理 → 笔记/卡片  │        │  ① 选材 → ② 生成 → ③ 修改    │
│ → 加权星图 → 测验/错题巩固     │ ─选材─▶ │  → ④ 发布（PDF/PPTX/HTML）  │
└───────────────────────────────┘        └─────────────────────────────┘
```

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
│   ├── hualong-xrs-strategy/
│   ├── q3-sales-preview/
│   ├── xinrenxinshi-huaxia-bank/
│   ├── xinrenxinshi-intro/
│   └── ...
├── web/                          # Web 管理界面
│   ├── index.html
│   ├── css/web.css
│   └── js/modules/               # 无构建 ES Modules，入口 app.mjs
├── server.mjs                    # Web 服务入口
├── skills/                       # CLI skills（11 个，见下文「可用 skill」）
├── scripts/                      # 升级、生成、导出、备份工具
│   ├── upgrade-decks.mjs         # 用基座 css/js 覆盖所有项目
│   ├── generate-deck.mjs         # 从 URL/文章生成 deck
│   ├── export-pptx.mjs           # 导出 PPTX
│   ├── export-pdf.mjs            # 导出 PDF（可选 Puppeteer）
│   ├── backup.mjs                # 项目与技能备份
│   └── config.mjs                # 项目配置读写
├── tests/                        # node --test 核心测试
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
- 按 `Ctrl+P` / `Cmd+P` 展开项目工具栏的导出下拉（PPTX / 高清图片 PPTX / PDF / 单文件 HTML）

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
| `Ctrl + P` / `Cmd + P` | 打印 / 导出下拉（Web UI） |
| `F` | 全屏 |
| `T` | 切换主题 |
| `s` | 缩略图侧边栏（全屏时隐藏） |
| `Shift + S` | 演讲者模式（备注 + 下一页预览 + 计时） |
| `M` | 标识笔（全屏下可用，圈点内容按页保存） |
| `1`-`5`（标识笔下） | 画笔 / 箭头 / 矩形 / 圆 / 椭圆 |
| `C`（标识笔下） | 清除本页标记 |
| `Esc`（标识笔下） | 退出标识笔 |
| `?` | 帮助面板（全屏时隐藏） |
| `ESC` | 退出 |

### Web 管理界面

| 按键 | 功能 |
|------|------|
| `?` | 帮助面板 |
| `Ctrl + N` | 新建项目 |
| `Ctrl + S` | 保存笔记 / 保存项目配置（按上下文分派） |
| `Ctrl + P` | 导出下拉 |
| `Ctrl + G` | 生成幻灯片 |
| `Ctrl + O` | 打开预览 |
| `Ctrl + K` | 全局搜索 |
| `Ctrl + Shift + O` | 快速跳转笔记 |
| `Ctrl + Shift + N` | 全局速记 |
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
| `/ppt-design` | 幻灯片设计规范（生成/编辑/审查时遵循） |
| `/ppt-anim` | 配置动画效果 |
| `/ppt-data` | 数据可视化组件 |
| `/ppt-theme` | 管理与切换主题 |
| `/ppt-publish` | 发布 deck 与管理发布版本 |

## 知识中枢工作流

从速记到复习的完整闭环，均在 Web UI（`npm run web`）中完成：

1. **速记**：`Ctrl+Shift+N` 随时记录碎片到 `vault/fragments/` 收件箱，正文中的 `#标签` 自动提取。
2. **AI 整理**：碎片面板点「AI 整理」，对每条收件箱碎片给出建议（升格为卡片/笔记/错题、补标签、关联笔记、合并、暂不处理），逐条确认后执行；无可用模型时按确定性规则给出建议。
3. **星图**：知识星图节点带 `weight`（链接度数 + 被提及次数）与 `reviews`（复习次数），可「只看高频」聚焦核心知识；选中若干节点可一键生成 PPT。
4. **智能组卷 / 复习 PPT**：从低熟练卡片、到期复习卡片与历史错题的选题池生成测验（LLM 变式题，无模型时降级直选）；卡片/错题集可一键生成复习 PPT，配图走 AI 生图。

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
| `projects/hualong-xrs-strategy/` | 华龙区 × 薪人薪事：产业纵深分析与数字劳动力合作路径 |
| `projects/q3-sales-preview/` | Q3 销售队伍建设动员 |
| `projects/xinrenxinshi-huaxia-bank/` | 薪人薪事 × 华夏银行 |
| `projects/xinrenxinshi-intro/` | 薪人薪事产品介绍 |

## 更新日志

### v2.6.0 — 易用性修复与信息架构收拢（2026-07）

- **笔记保存**：`Ctrl+S` 按上下文分派（保存笔记 / 保存项目配置），2 秒防抖自动保存、脏标记（●）、beforeunload 防丢、localStorage 草稿恢复。
- **弹窗统一**：新增 `modals.mjs`（`showInputModal`/`showConfirmModal`），全站原生 prompt/confirm 清零。
- **「生成 PPT」单入口**：`generate.mjs` 的 `#gen-modal` + `openGenerateModal(source)` 统一笔记/多选/星图/复习四个来源。
- **导出单入口**：项目工具栏 `#export-dropdown`（PPTX / 高清图片 PPTX / 浏览器打印 PDF / 单文件 HTML），`Ctrl+P` 展开。
- **侧边栏「学习」tab**：测验/错题集/复习训练合并；设置入口收拢到顶栏齿轮。
- **底层**：搜索索引改为按项目自动重建；项目快照保留 20 份、vault 备份保留 200 份并自动 prune；清理 `web.js`、`build-fonts` 等死代码。

### v2.3.2 — AI 修改结果显示修改明细（2026-07）

- 笔记/PPT 的 AI 对话修改完成后，结果气泡除「修改完成」外会展示**修改明细**：优先显示 LLM 输出的逐条修改点（prompt 新增 `---修改说明---` 输出约定），缺失时自动回退为行级 diff（`-` 删除 / `+` 新增，LCS 实现，上限 40 行）。
- 修改明细随 SSE `done.details` 下发，PPT 对话历史（chat-history.json）同步保存，刷新后仍可回顾。

### v2.3.1 — 模型密钥挂钩与系统级设置入口（2026-07）

- **API Key 可选持久化**：设置面板三组模型的 API Key 均可勾选「保存到本地配置」（`.ai-ppt-config.json`，已 gitignore）；后端取 key 优先级为 环境变量 > 配置文件，`GET /api/config` 只返回 `apiKeySet` 掩码绝不返回明文。勾选一次后 AI 对话修改/生成不再反复报「未配置 LLM」。
- **系统级齿轮入口**：顶栏右侧新增 ⚙ 按钮，随时一键打开系统设置（侧边栏「设置」tab 保留）。
- **错误提示引导**：chat/生成/AI 扩展遇到「未配置可用 LLM」时，自动追加「请到「设置」面板检查文本模型与 API Key」。

### v2.3.0 — 系统设置区与 AI 对话强化（2026-07）

- **独立「设置」区**：文本 / 生图 / 生视频三组模型配置从项目「选材」tab 提升到系统级「设置」面板，对所有项目生效（复用 `GET/POST /api/config` 与 `POST /api/media/test` 探针，API Key 不落盘）；面板内置数据备份入口（`POST /api/backup`，返回 `{dir}`），随时一键备份。
- **笔记 AI 对话修改**：笔记编辑器新增「AI 修改」，自然语言指令改写笔记；`POST /api/vault/notes/:name/chat` 立即返回 202，`GET .../chat/events` SSE 实时推送进度。底层 `scripts/chat-note.mjs`（NDJSON 协议）修改前自动备份原笔记到 `.snapshots/_vault/`，并要求 LLM 保留 Front Matter 与 `[[wikilink]]`，失败时不改动文件。
- **PPT AI 对话历史持久化**：「AI 修改」聊天记录写入 `projects/<name>/chat-history.json`（最多 50 条），`GET /api/projects/:name/chat/history` 读取回填，刷新页面不丢历史。

> 完整历史（v1.2 → v2.5.0）见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

MIT
