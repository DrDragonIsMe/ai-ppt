---
name: ppt-design
description: ai-ppt 幻灯片设计判断力 skill，蒸馏自 GitHub 的 impeccable（pbakaus/impeccable）与 taste-skill（Leonxlnx/taste-skill）。在生成、编辑、审查任何 deck 时使用：先读懂简报，再决定版式与密度，避免"一眼 AI"的模板化幻灯片。
metadata:
  tags: ppt, design, taste, anti-slop, typography, layout, ai-ppt-base
---

# ppt-design：让 AI 生成的 PPT 有设计品味

蒸馏自两个开源设计 skill，并针对 ai-ppt 引擎（HTML slides + `css/ppt.css`）重写：

- **impeccable**（github.com/pbakaus/impeccable）：产品级界面设计规范与"绝对禁令"。
- **taste-skill**（github.com/Leonxlnx/taste-skill）：反模板化前端 skill，核心是"先读懂简报，再调旋钮"。

本 skill 只保留与幻灯片相关的部分。生成（`generate-deck.mjs`）、搭建（`/ppt-structure`）、编辑（`/ppt-edit`）、审查任何 deck 时都适用。

## 0. 先读懂简报（Design Read）

动手之前，先输出一行"设计解读"，再让版式跟随判断：

> "解读为：给\<受众\>的\<题材\>，基调\<克制/高端/活力/信赖\>，用\<主题\> + \<密度\> + \<动画\>。"

判断信号：

1. **受众**：管理层汇报 → 克制、大字、少页；全员动员 → 高能量、大数字；技术评审 → 密度可高、表格图表为主。
2. **题材**：销售/业绩 → 数据组件优先；产品介绍 → 卡片+表格；培训/理念 → 引用块+时间轴。
3. **已有素材**：用户给了主题/品牌色，以它为锚，不要另起炉灶。
4. **约束**：正式场合（董事会、监管、客户交付）优先可读性与对比度，压倒一切风格偏好。

简报模糊且走向真的分叉时，只问一个问题（如"偏克制商务还是偏活力发布会？"），能推断就不要问。

## 1. 三个旋钮

| 信号 | 版式变化 | 动画强度 | 信息密度 |
|---|---|---|---|
| 管理层 / 董事会 / 正式商务 | 低（每页一个版式打透） | `anim-fade` 或 `none` | 低，每页 1 个观点 |
| 产品发布 / 全员大会 | 高（版式轮换） | `anim-slide` | 中低 |
| 培训 / 知识传递 | 中 | `anim-fade` | 中高 |
| 数据复盘 / 技术评审 | 中 | `anim-fade` 或 `none` | 高，图表表格为主 |

动画通过 `ai-ppt.json` 的 `animation` 字段全局设置（`anim-fade` / `anim-slide` / `anim-bounce` / `none`），整个 deck 只选一种，不要逐页混用。

## 2. 版式原则

- **一页一个核心观点**。标题即结论；细节由讲者口述，不堆在页面上。
- **版式要轮换**。相邻两页不要用同一种结构。可用版式库（均为引擎内置类）：
  - 封面/收尾：`section-hero` 居中大字
  - 观点强调：`quote-block`
  - 要点并列：`tile-row` / `two-col` / `visual-row` + `visual-card`（一组 ≤4 个）
  - 数据：`split-visual` + `hero-stat` + `big-number`（≤4 个，见 AGENTS.md 第 10 条）、`chart-bar`、`progress-ring`、`waterfall`、`data-matrix`、`ppt-table`
  - 流程/节奏：`chart-steps`、`timeline`、`timeline-horizontal`
  - 标签/关键词：`badge-row`
- **卡片是偷懒的答案**。能用表格、图表、时间轴、大数字讲清楚的，不要一律换成"图标+标题+一段字"的卡片。一个 deck 里卡片页不超过 1/3。
- **节奏感靠对比**：密的一页（表格/图表）之后跟一页疏的（大数字/引用），不要每页信息量雷同。

## 3. 绝对禁令（命中即重写）

- **渐变文字**。`.gradient-text` 已弃用，强调用字重或字号，不用 `background-clip: text`。
- **每页都挂"眉毛"**。`kicker` / `section-title`（小字全大写标签）全页重复是最典型的 AI  scaffolding。封面和收尾可以用；内容页最多 1/3 使用，且用词要有信息量（如"Q3 复盘"），不要用 "Overview / Product / Data" 这类空词充数。
- **同质化卡片连击**：连续多页"N 张一样的卡片 + 图标 + 标题 + 一段字"。
- **大段正文**：任何一页正文超过 3 行（约 90 字），拆页或改口述。
- **编造数据**：没有来源的百分比、客户数、指标一律不写；数据页只呈现素材里真实存在的数字。
- **元信息上封面**：封面不放描述 deck 自身原则的 badge（如"少文字/多图形"之类），封面只有标题、副标题、署名/日期。
- **文字溢出**：标题超过一行半就要缩短文案或降低字号，绝不让字顶出容器。
- **手写新样式/新动画**：只用 `ppt.css` 内置类；确需新组件，先改基座再 `npm run upgrade-decks`。

## 4. 排版与对比度

- 标题：中文 ≤ 20 字，一行半以内；h1/h2 已内置 `text-wrap: balance`。
- 正文：`--slate`；次要说明才用 `--muted`，正文字号下对比度必须 ≥ 4.5:1，不要为了"高级感"用浅灰。
- 彩色/深色底上不用灰字，用白的或同色系更深的颜色。
- 数字强调一律 `.big-number`（已内置 `white-space: nowrap`），不要手写 inline `font-size`。
- 对齐：内容页标题左对齐（引擎默认），只有封面/收尾/引用页居中。

## 5. 交付前检查清单（生成或编辑后逐页过一遍）

1. 每页能否一眼说出"这一页就讲一件事"？
2. 相邻页版式是否有重复？
3. `kicker` / `section-title` 是否泛滥（>1/3 页面）？
4. 有没有 `.gradient-text`、手写 SVG 图标、inline 样式堆砌？
5. 所有数字是否来自素材？同行数字是否 ≤4 个且用了 `.big-number`？
6. 有没有超过 3 行的正文段落？
7. 标题有没有溢出或折行难看？
8. 卡片页占比是否 ≤1/3？
9. 主题（`theme-*`）与基调是否匹配受众？全 deck 是否只有一种动画？
10. 打印导出走查：`/ppt-export` 或截图检查首尾页与最密的一页。

## 6. 与现有流程的关系

- `scripts/generate-deck.mjs` 的生成 prompt 已内置本 skill 的核心规则；Web UI 生成即自动生效。
- `/ppt-structure` 新 deck 的 starter 模板遵循本 skill。
- `/ppt-edit` 修改页面时，新增内容同样按第 2-4 节执行。
- 样式层面的改动只发生在 `ai-ppt-base/`，改完 `npm run upgrade-decks` 同步，不要直接改项目里的 `css/ppt.css`。
