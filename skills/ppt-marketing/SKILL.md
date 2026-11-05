---
name: ppt-marketing
description: 从素材库出营销大纲（选角度集）再批量生成营销 PPT 的完整步骤，含无 LLM 降级预期与导出/发布后续动作
metadata:
  tags: ppt, marketing, outline, angle, batch, generate
---

# ppt-marketing Skill

完整流程：多源素材库取材 → 营销大纲（`marketing/outlines/<mo-xxx>.json`）→ 按角度批量生成 deck（`projects/mkt-<angleKey>-<slug>/`）→ 导出 / 发布。

## 概念

- **角度集**：内置 `marketing-standard`（默认）。6 个角度 = 6 个独立叙事立场，各产出一份独立 deck：
  `pain` 客户痛点 / `capability` 产品能力 / `scenario` 行业场景 / `diff` 差异化竞争 / `roi` ROI 价值 / `proof` 成功案例与落地路径。
- **deckName**：`mkt-<angleKey>-<产品名slug>`，例 `mkt-pain-ai-ppt-知识中枢`。
- **大纲 id**：`mo-<base36时间戳>`；**批次 id**：`mb-<base36时间戳>`。
- **事件协议**：stdout 逐行 NDJSON，事件型 `progress | step | outline | deck | lint | error | done`。

## Step 1 · 生成营销大纲

```bash
node scripts/marketing/generate-outline.mjs \
  --source src-docs-marketing,src-other \
  --product "产品名称" \
  --audience "目标听众" \
  --tone "语气，如：务实、场景化、少形容词" \
  --angle-set marketing-standard \
  --title "大纲标题" \
  --slides 5 \
  --include-stale
```

- **参数就这么几个**：`--source`（逗号分隔源 id）、`--product`、`--audience`、`--tone`、`--angle-set`、`--title`、`--slides`（每角度页数，3–8，默认 5）、`--include-stale`（纳入被标 stale 的素材）。
- **取材**：跨源汇总 `vault/.meta/source-cache/` 条目 → 按角度关键词分档摘要 → 逐角度调 LLM（并发 1）→ 严格校验（角度数、thesis 互不重复、slides 形状、evidenceItemIds 存在性）→ 落盘。
- **防编造**：LLM 输出的 `evidenceItemIds` 只允许指向素材库真实条目，指向不存在条目的引用会被剔除并在事件里计数报告。
- **产物**：`marketing/outlines/<mo-xxx>.json`（已 gitignore）。`done` 事件带 `outlineId / angleKeys / deckNames / itemCount / corpusChars / llmUsed / llmFailed / llmShortCircuited / llmReason / fallbackOnly / perSource / warnings`。
- 素材库为空直接报错（`EMPTY_MATERIAL`）：先 `/ppt-sources` 建源并刷新，再回来生成。

### 无 LLM 时的降级预期（重要，别把兜底当 AI 产出）

LLM 不可用（远程无 API Key）或调用失败（模型未开通/404 等）**不会中断流程**，逐角度走确定性兜底大纲，且如实报告：

- `done` 事件真实形状：`llmUsed:0, llmFailed:1, llmShortCircuited:true, llmReason:"…404 UnsupportedModel…"`，每角度 `generatedBy:'fallback'`（该字段落盘在大纲 JSON 的 `angles[].generatedBy`）。
- **看到 `llmShortCircuited:true` 意味着**：第一个角度 LLM 调用失败后，其余角度不再等待网络超时、直接兜底——不是「网络慢」，是模型配置有问题。
- **兜底文案是拼装出来的**：thesis 取角度集定义、素材按角度关键词分桶、每页引用真实条目——但句式是模板拼装、不是 AI 写的，给客户前务必人工润色。
- 要恢复 LLM：改顶栏齿轮「设置」面板里的模型配置（系统级 `.ai-ppt-config.json`，三组配置 `modelConfig` 对所有项目生效），核对 baseUrl / apiKey / 模型名真实可用；优先级是环境变量 `OPENAI_*` > 配置文件 > 内置默认。
- `llmReachable` 的判定信号：远程端点必须有 apiKey；本地端点（`lmstudio` 或 `localhost/127.0.0.1`）不需要 key。

## Step 2 · 按大纲批量生成 deck

```bash
node scripts/marketing/batch-generate.mjs <outlineId> \
  --angles pain,capability \
  --batch-id mb-x \
  --overwrite \
  --slides 8 \
  --theme web-ui \
  --animation slide
```

- **参数**：`<outlineId>` 必填；`--angles`（逗号分隔角度 key，省略 = 全部角度）；`--batch-id`（进度记录，`marketing/batches/<batchId>.json`）；`--overwrite`（已存在项目默认**跳过**，加该参数才覆盖，覆盖前自动快照）；`--slides`（每 deck 页数，4–15，默认 8）；`--theme`（默认 `web-ui`）；`--animation`（默认 `slide`）。
- **产物**：`projects/<deckName>/`（`index.html` + `ai-ppt.json`；`sourceSelection.kind='outline'` 绑定大纲与角度；`userEdits` 原样保留）。落盘后自动跑设计检查（`lint` 事件）与封面截图。
- **逐角度串行**（LLM 并发 1）；单 deck 失败不阻断整批，失败记入汇总（`failedCount`）。
- **无 LLM 时同样产出可用 deck**：用大纲已定稿的页面结构直排兜底模板（`buildDeckFallback`）。
- **取消**：`curl -X POST http://localhost:3456/api/marketing/batch/cancel`——落标记文件，当前 deck 完成后停止（正在跑的 LLM 调用不被强杀，其结果被忽略）。
- `done` 事件带 `batchId / total / doneCount / skippedCount / failedCount / cancelledCount / rows（每 deck 状态）/ deckNames / projectDirs / previewBase:'/projects/'`。

## Step 3 · 导出 / 发布

- **预览**：`projects/<deckName>/index.html`（Web 控制台「作品」tab，或浏览器直开；`done` 事件的 `rows[].previewUrl` 即 `/projects/<deckName>/index.html`）。
- **导出**：`/ppt-export <deckName> pdf|pptx|pptx-image`（产物 `projects/<deckName>/export/`）；视频导出 `deck.mp4` 也在此目录，属生成物不入库。
- **发布**：`/ppt-publish publish <deckName>`（→ `published/<deckName>/vN/`，`latest` 为最新版软链）。
- **大纲可后续编辑**：`PUT /api/marketing/outline/:id`（title / product / angles / status，整份替换角度数组），编辑后重新跑 Step 2 即可。

## Web 控制台双入口

- 侧边栏「素材库」tab：源管理 + 营销生产线（大纲生成 / 批量生成进度 SSE，`GET /api/marketing/outline/events`、`GET /api/marketing/batch/events`）。
- 大纲 CRUD / 角度集 / 批次历史端点：`GET /api/marketing/outlines`、`GET /api/marketing/outline/:id`、`GET /api/marketing/angle-sets`、`GET /api/marketing/batches`、`GET /api/marketing/batch/current`（共 13 条路由）。
- **全局同一时刻只允许 1 个大纲生成与 1 个批次**（并发触发 409）。

## 硬约束警告（用户红线）

- `marketing/outlines/`、`marketing/batches/` 与抓取缓存 `vault/.meta/source-cache/` **都是生成物**，已被 `.gitignore` 锚定（`/marketing/`、`vault/.meta/source-cache/`），**绝不 `git add`**。
- **视频/大素材不入库**：素材源只收文本条目；导出视频 `deck.mp4`、deck 封面 `cover.png` 均已被 gitignore。需要大文件时放在 `projects/<name>/assets/`（同样不入库）或仓库外自行管理。

## 实现位置

- 大纲生成：`scripts/marketing/generate-outline.mjs`（CLI 参数仅 `--source --product --audience --tone --angle-set --title --slides --include-stale`）
- 批量生成：`scripts/marketing/batch-generate.mjs`（CLI `<outlineId> --angles --batch-id --overwrite --slides --theme --animation`）
- 角度集：`scripts/marketing/angles.mjs`；素材汇总与分档摘要：`scripts/marketing/material.mjs`
- 大纲/批次存取：`scripts/marketing/store.mjs`；LLM 可达性：`scripts/marketing/llm.mjs`
- HTTP 端点：`routes/marketing.mjs`（头部注释即路由表）
