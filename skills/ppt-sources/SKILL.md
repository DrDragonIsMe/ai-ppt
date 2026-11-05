---
name: ppt-sources
description: 用 CLI/脚本管理 ai-ppt 多数据源素材库（添加目录源/链接源/站点入口源、刷新抓取、列条目、搜索）
metadata:
  tags: ppt, sources, materials, collect, search, refresh
---

# ppt-sources Skill

管理 ai-ppt 的「素材库」：把本地目录、网页链接、站点入口、知识库笔记注册成素材源，刷新抓取后形成统一文本条目，供营销大纲与 PPT 生成取材。

## 素材库概念

- **源注册表**：仓库根 `sources.json`（`{version:1, sources:[Source]}`），已 gitignore，属生成物，绝不提交。
- **抓取缓存**：`vault/.meta/source-cache/<sourceId>/`（`manifest.json` + `items/<itemId>.md`），已 gitignore。
- **源类型**：`type ∈ dir | url | site | vault`（`scripts/sources/registry.mjs` 的 `SOURCE_TYPES`）。
- **条目 id**：`<sourceId>--<12位sha256hex>`，例 `src-docs-marketing--4fcf73800c1d`（`scripts/sources/store.mjs` 的 `makeItemId`）。
- **条目文件**：带 Front Matter 的 markdown（`title / source_id / origin / fetched_at / hash / tags`），正文为统一纯文本。

## 素材源类型与默认参数

| 类型 | target | 默认收集范围 |
| --- | --- | --- |
| `dir` | 仓库内目录（相对或绝对路径） | 仅文本类：`**/*.md|markdown|txt|html|htm|csv|json|docx|pdf` |
| `url` | 单个网页的 http(s) URL | 单页，不受 maxPages 限制 |
| `site` | 站点入口 URL | 按 `depth` 爬取，默认深度 1 |
| `vault` | `vault/` 下相对子路径（空 = 整个 vault） | 仅 `**/*.md` |

`options` 可调项：`include`（glob 数组）、`maxPages`（1–500，默认 30）、`maxBytesPerItem`（1KB–10MB，默认 512KB）、`depth`（0–5，默认 1，仅 site）、`label`（展示名）、`anyOfTags`。

## 添加源（无 CLI 脚本，走 Web 控制台「素材库」tab 或 HTTP API）

建源没有独立 CLI 脚本（`scripts/sources/` 下只有采集与刷新），用 `curl` 调 HTTP 端点即可：

```bash
# 仓库内部目录源（无需外部授权；服务默认端口 3456）
curl -X POST http://localhost:3456/api/sources \
  -H 'Content-Type: application/json' \
  -d '{"type":"dir","name":"市场素材","target":"docs/marketing"}'

# 链接源（单网页）
curl -X POST http://localhost:3456/api/sources \
  -H 'Content-Type: application/json' \
  -d '{"type":"url","name":"官网介绍","target":"https://example.com/intro"}'

# 站点入口源（按 depth 爬子页）
curl -X POST http://localhost:3456/api/sources \
  -H 'Content-Type: application/json' \
  -d '{"type":"site","name":"官网","target":"https://example.com","options":{"depth":1}}'

# vault 源（可带子目录，空 target = 整个 vault）
curl -X POST http://localhost:3456/api/sources \
  -H 'Content-Type: application/json' \
  -d '{"type":"vault","name":"培训笔记","target":"training"}'
```

响应 `201`，body 为 `{source}`（含自动生成的 `src-<slug>` id）。

### 外部目录源是双闸（重要）

仓库**根之外**的绝对路径目录源，两道闸都过才放行：

1. 服务启动时设环境变量 `AI_PPT_ALLOW_EXTERNAL_SOURCES=1`；
2. 建源请求体带 `acknowledgeExternalPath:true`。

缺任一 → 400。仓库**内部**目录不需要该标记。刷新时还会重查授权：关掉 env 后，已存在的外部源再刷新会 403——「关掉 env」对存量外部源同样生效。

## 刷新抓取

```bash
# CLI（逐行 NDJSON 事件，协议同生成任务）
node scripts/sources/refresh.mjs <sourceId>

# HTTP（202 + SSE；同 id 正在刷新 → 409；全局并发上限 2 → 429）
curl -X POST http://localhost:3456/api/sources/<sourceId>/refresh
# 进度：GET /api/sources/<sourceId>/refresh/events
```

- **增量语义**：同一 origin（文件路径/URL/笔记名）的 itemId 多次刷新间保持稳定；hash 未变的条目不重写；上游消失的条目在整批成功后清理。
- **失败保命**：部分抓取失败（5xx/401/403/429/超时/目录瞬时不可读）时，对应条目标 `stale` 保留、绝不误删；`done` 事件的 `degraded:true / staleCount:N` 如实报告。
- **`done` 事件字段**：`sourceId / added / updated / unchanged / removed / errors / itemCount / fingerprint / truncated / preserved / degraded / staleCount / policySkipped / droppedCount / totalCandidates / lastFetchedAt`。

## 列条目与搜索

```bash
# 全部源（附 itemCount / truncated / degraded / preserved 等抓取质量标记）
curl http://localhost:3456/api/sources

# 单源条目
curl http://localhost:3456/api/sources/<sourceId>/items

# 跨源搜索（q 对 title/origin 大小写无关子串过滤，limit 截断）
curl 'http://localhost:3456/api/sources/items?q=<关键词>&limit=20'
```

库函数等价物：`listItems({sourceId, q, limit})` 读 manifest（不读正文）；`readItem(itemId)` 返回 `{itemId, sourceId, frontMatter, content}`（`scripts/sources/store.mjs`）。

## 试抓预览（不落盘）

```bash
curl -X POST http://localhost:3456/api/sources/preview \
  -H 'Content-Type: application/json' \
  -d '{"type":"url","name":"x","target":"https://example.com"}'
# 或引用已有源：{"id":"<sourceId>"}
```

返回首条匹配条目的 `{ok, kind, origin, title, bytes, truncated, content}`（只取 1 条、正文截短）。

## 更新 / 删除

```bash
curl -X PUT http://localhost:3456/api/sources/<sourceId> \
  -H 'Content-Type: application/json' -d '{"name":"改名"}'

curl -X DELETE 'http://localhost:3456/api/sources/<sourceId>?purge=true'
# purge=true 一并删除该源抓取缓存；不传则只注销源
```

改 `target`/`type` 会剥离旧的 `acknowledgeExternalPath` 标记，外部目录需重新确认（防止「一次确认 → 永久任意改路径」）。

## 安全边界（为什么指个目录不一定能用）

- **禁入目录段**：`.git` / `.backup` / `.snapshots` / `node_modules`——即便被包在源 target 内也不采集。
- **敏感位置**：`.ssh` / `.aws` / `.docker` / `.config` / `keychain`、`/etc`、`/var/root`、`.env*`、`*.pem` / `*.key` / `credentials*` 等一律拒收。
- dir 绝对路径默认只允许仓库根内；越界走上面的双闸。
- 符号链接逃逸会被 realpath 重查拦截（词法路径 + 真实路径双重判定）。

## 硬约束警告（用户红线）

- `sources.json` 与 `vault/.meta/source-cache/` 均为生成物/抓取缓存，已被 `.gitignore` 锚定，**绝不 `git add`**。
- **视频/大素材不入库**：dir 源默认 `include` 只收文本类，`*.mp4 / *.mov / *.gif` 等非文本文件不会成为条目；素材库只存文本，大文件留在源目录外自行管理。

## 实现位置

- 源注册表与校验：`scripts/sources/registry.mjs`
- 刷新/预览编排：`scripts/sources/refresh.mjs`
- 缓存与条目读写：`scripts/sources/store.mjs`
- 路径基准与安全清单：`scripts/sources/paths.mjs`
- 采集器：`scripts/sources/collect-{dir,url,site,vault}.mjs`
- HTTP 端点：`routes/sources.mjs`（`GET/POST /api/sources`、`PUT/DELETE /api/sources/:id`、`POST /api/sources/:id/refresh`、`GET /api/sources/:id/items`、`GET /api/sources/items`、`POST /api/sources/preview`）
