# ai-ppt 升级方案 - Workspace & 数据可视化

> 基于用户需求的全面升级计划。

## 需求概述

1. ✅ 动效选项（不包括主题自定义界面）
2. ✅ 数据表现组件升级 - 美观多变的数据可视化
3. ✅ Skill化 - 支持 Kimi/Claude/Codex，纳入 git 管理
4. ✅ 主题和动效在管理页面生成
5. ✅ 升级管理页面为 Workspace
6. ✅ PPT 调整预览 + 发布流程

---

## Phase 1: 数据可视化组件升级

### 目标

在 `ppt.css` 中增加丰富的数据可视化组件，支持多种数据展示形式。

### 新增组件清单

#### 1. 图表组件

```css
/* ===== 数据图表 ===== */

/* 条形图 */
.chart-bar {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding: 20px 0;
}

.chart-bar-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.chart-bar-bar {
  width: 100%;
  min-height: 60px;
  background: linear-gradient(to top, var(--accent), var(--accent-light));
  border-radius: 6px 6px 0 0;
  transition: transform 0.3s ease, box-shadow 0.3s ease;
}

.chart-bar-bar:hover {
  transform: scaleY(1.05);
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}

.chart-bar-label {
  font-size: 12px;
  color: var(--muted);
  text-align: center;
}

.chart-bar-value {
  font-weight: 700;
  color: var(--accent);
}

/* 进度环 */
.progress-ring {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 24px;
}

.progress-ring-item {
  text-align: center;
}

.progress-ring-svg {
  width: 120px;
  height: 120px;
  transform: rotate(-90deg);
}

.progress-ring-circle-bg {
  fill: none;
  stroke: var(--border);
  stroke-width: 10;
}

.progress-ring-circle {
  fill: none;
  stroke: var(--accent);
  stroke-width: 10;
  stroke-linecap: round;
  stroke-dasharray: 314;
  stroke-dashoffset: 314;
  transition: stroke-dashoffset 1s ease-out;
}

.progress-ring-label {
  margin-top: 8px;
  font-weight: 600;
  color: var(--ink);
}

.progress-ring-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--accent);
  margin-top: 4px;
}

/* 阶梯图 */
.chart-steps {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.chart-step {
  display: flex;
  align-items: center;
  gap: 16px;
}

.chart-step-number {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--accent);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  flex-shrink: 0;
}

.chart-step-content {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 20px;
}

.chart-step-title {
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 4px;
}

.chart-step-desc {
  font-size: 14px;
  color: var(--muted);
}
```

#### 2. 数据卡片组件

```css
/* ===== 数据卡片 ===== */

.data-metric {
  text-align: center;
  padding: 24px;
}

.data-metric-value {
  font-size: clamp(48px, 6vw, 72px);
  font-weight: 700;
  background: linear-gradient(135deg, var(--accent) 0%, var(--accent-dark) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  line-height: 1;
  letter-spacing: -0.02em;
}

.data-metric-unit {
  font-size: 0.4em;
  color: var(--muted);
  -webkit-text-fill-color: var(--muted);
}

.data-metric-label {
  margin-top: 12px;
  font-size: 16px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.data-metric-trend {
  margin-top: 8px;
  font-size: 14px;
  font-weight: 600;
}

.data-metric-trend.up {
  color: var(--success);
}

.data-metric-trend.down {
  color: var(--danger);
}

/* 对比卡片 */
.data-compare {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.data-compare-item {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  text-align: center;
}

.data-compare-title {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin-bottom: 12px;
}

.data-compare-value {
  font-size: 36px;
  font-weight: 700;
  color: var(--accent);
}

.data-compare-sub {
  font-size: 14px;
  color: var(--muted);
  margin-top: 4px;
}
```

#### 3. 矩阵/网格数据

```css
/* ===== 矩阵与网格 ===== */

.data-matrix {
  display: grid;
  gap: 8px;
}

.data-matrix-2x2 {
  grid-template-columns: 1fr 1fr;
}

.data-matrix-3x3 {
  grid-template-columns: 1fr 1fr 1fr;
}

.data-matrix-cell {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  text-align: center;
  transition: all 0.2s ease;
}

.data-matrix-cell:hover {
  border-color: var(--accent);
  transform: translateY(-2px);
}

.data-matrix-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--accent);
}

.data-matrix-label {
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* 热力图样式 */
.data-matrix-cell.hot {
  background: color-mix(in srgb, var(--accent) 20%, var(--surface));
}

.data-matrix-cell.warm {
  background: color-mix(in srgb, var(--accent) 10%, var(--surface));
}
```

#### 4. 时间线 & 瀑布图

```css
/* ===== 时间线 & 瀑布 ===== */

.timeline-horizontal {
  display: flex;
  align-items: flex-start;
  gap: 0;
  position: relative;
  padding-top: 20px;
}

.timeline-horizontal::before {
  content: '';
  position: absolute;
  top: 8px;
  left: 40px;
  right: 40px;
  height: 2px;
  background: var(--border);
}

.timeline-horizontal-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  position: relative;
  z-index: 1;
}

.timeline-horizontal-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent);
  border: 3px solid var(--cream);
  box-shadow: 0 0 0 2px var(--accent-light);
}

.timeline-horizontal-content {
  text-align: center;
}

.timeline-horizontal-title {
  font-weight: 600;
  color: var(--ink);
  font-size: 14px;
}

.timeline-horizontal-desc {
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
}

/* 瀑布图 */
.waterfall {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.waterfall-item {
  display: flex;
  align-items: center;
  gap: 16px;
}

.waterfall-label {
  width: 100px;
  text-align: right;
  font-weight: 500;
  color: var(--ink);
  flex-shrink: 0;
}

.waterfall-bar {
  flex: 1;
  height: 40px;
  background: var(--surface-subtle);
  border-radius: 6px;
  overflow: hidden;
  position: relative;
}

.waterfall-fill {
  height: 100%;
  border-radius: 6px;
  transition: width 0.8s ease-out;
}

.waterfall-fill.positive {
  background: linear-gradient(to right, var(--success), #a7f3d0);
}

.waterfall-fill.negative {
  background: linear-gradient(to right, var(--danger), #fecaca);
}

.waterfall-fill.neutral {
  background: linear-gradient(to right, var(--accent), var(--accent-light));
}

.waterfall-value {
  width: 80px;
  text-align: left;
  font-weight: 600;
  color: var(--ink);
}
```

### 5. 动画效果升级

```css
/* ===== 动画效果 ===== */

/* Reveal Up 动画 */
@keyframes revealUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Reveal Left 动画 */
@keyframes revealLeft {
  from { opacity: 0; transform: translateX(-30px); }
  to { opacity: 1; transform: translateX(0); }
}

/* Reveal Right 动画 */
@keyframes revealRight {
  from { opacity: 0; transform: translateX(30px); }
  to { opacity: 1; transform: translateX(0); }
}

/* Fade In 动画 */
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* Scale In 动画 */
@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.9); }
  to { opacity: 1; transform: scale(1); }
}

/* Stagger 类 - 用于控制延迟 */
.reveal-item {
  opacity: 0;
  animation: revealUp 0.5s ease forwards;
}

.reveal-item:nth-child(1) { animation-delay: 0.1s; }
.reveal-item:nth-child(2) { animation-delay: 0.2s; }
.reveal-item:nth-child(3) { animation-delay: 0.3s; }
.reveal-item:nth-child(4) { animation-delay: 0.4s; }
.reveal-item:nth-child(5) { animation-delay: 0.5s; }
.reveal-item:nth-child(6) { animation-delay: 0.6s; }

/* 使用示例：
<div class="tile-row">
  <div class="tile reveal-item">...</div>
  <div class="tile reveal-item">...</div>
</div>
*/
```

### 6. 动效预设类

```css
/* ===== 动效预设 ===== */

/* 无动画 */
.anim-none * {
  animation: none !important;
  transition: none !important;
}

/* 渐入 */
.anim-fade .slide.active .kicker,
.anim-fade .slide.active h1,
.anim-fade .slide.active h2,
.anim-fade .slide.active .lead,
.anim-fade .slide.active .tile {
  animation: fadeIn 0.4s ease forwards;
}

/* 滑入 */
.anim-slide .slide.active .kicker,
.anim-slide .slide.active h1,
.anim-slide .slide.active h2,
.anim-slide .slide.active .lead,
.anim-slide .slide.active .tile {
  animation: revealUp 0.5s ease forwards;
}

/* 弹性弹出 */
.anim-bounce .slide.active .kicker,
.anim-bounce .slide.active h1,
.anim-bounce .slide.active h2,
.anim-bounce .slide.active .lead,
.anim-bounce .slide.active .tile {
  animation: scaleIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}
```

### 更新文件

- `ai-ppt-base/css/ppt.css` - 增加上述组件
- `ai-ppt-base/index.html` - 增加示例幻灯片展示新组件

---

## Phase 2: Skill 化 & Git 管理

### 目标

创建可复用的 Skills，支持多平台，纳入 Git 管理。

### 新增 Skills

#### 1. `ppt-theme` - 主题管理 Skill

```
skills/
└── ppt-theme/
    └── SKILL.md
```

功能：
- 列出可用主题
- 应用/切换主题
- 导出当前主题配置

#### 2. `ppt-data` - 数据可视化 Skill

```
skills/
└── ppt-data/
    └── SKILL.md
```

功能：
- 生成数据可视化幻灯片
- 支持条形图、环形图、矩阵、瀑布图等
- 智能数据布局建议

#### 3. `ppt-anim` - 动效配置 Skill

```
skills/
└── ppt-anim/
    └── SKILL.md
```

功能：
- 设置动画类型（无/渐入/滑入/弹性）
- 配置动画速度和延迟
- 预览动画效果

#### 4. `ppt-publish` - 发布管理 Skill

```
skills/
└── ppt-publish/
    └── SKILL.md
```

功能：
- 发布幻灯片到 `published/` 目录
- 生成发布版本的唯一 URL
- 查看发布历史

### Skill 平台适配

每个 Skill 需要：
- 支持 Claude Code CLI
- 支持 Kimi CLI
- 支持 Cursor/Codex 风格的提示词

### Git 管理更新

更新 `.gitignore`：
```gitignore
# 已有的
node_modules/
*.zip
.DS_Store
.env.kimi
export/

# 新增
published/
*.tmp
```

创建 `SKILLS_README.md` 文档说明 Skill 使用方法。

---

## Phase 3: Workspace 管理页升级

### 目标

将管理页升级为完整的 Workspace，支持主题选择、动画配置、实时编辑预览、发布流程。

### 新的布局结构

```
┌─────────────────────────────────────────────────────────┐
│  ai-ppt Logo  │  新建项目                              │
├───────────────┼─────────────────────────────────────────┤
│  项目列表     │                                         │
│               │  ┌───────────────────────────────────┐  │
│  ✅ test-deck │  │  预览区域                        │  │
│     q3-sales  │  │                                 │  │
│     product   │  │  [实时幻灯片预览]               │  │
│               │  │                                 │  │
│               │  └───────────────────────────────────┘  │
│               │                                         │
│               │  ┌───────────────────────────────────┐  │
│               │  │  配置 Tab 区                    │  │
│               │  │  [内容] [样式] [动画] [发布]      │  │
│               │  └───────────────────────────────────┘  │
│               │                                         │
│               │  操作按钮: [保存] [预览] [发布] [导出]│  │
└───────────────┴─────────────────────────────────────────┘
```

### 新增 Tab 面板

#### Tab 1: 样式（主题选择）

功能：
- 8个主题的卡片式选择
- 主题效果实时预览
- 主题切换动画

API 扩展：
```
GET  /api/themes - 列出所有可用主题
POST /api/projects/:name/theme - 应用主题
```

#### Tab 2: 动画

功能：
- 动画类型选择（无/渐入/滑入/弹性）
- 动画速度调节（快/中/慢）
- 即时应用预览

API 扩展：
```
POST /api/projects/:name/animation - 应用动画配置
```

#### Tab 3: 发布

功能：
- 查看当前草稿状态
- 点击"发布"创建发布版本
- 查看发布历史
- 访问发布版本的 URL

API 扩展：
```
POST /api/projects/:name/publish - 发布
GET  /api/projects/:name/published - 列出发布版本
GET  /published/:name/:version/index.html - 访问已发布版本
```

### 实时预览机制

- 使用 iframe 加载预览
- 配置变更时实时更新
- WebSocket 或轮询方式同步

---

## Phase 4: 发布系统

### 目录结构

```
ai-ppt/
├── projects/
│   └── test-deck/
│       ├── index.html
│       ├── css/
│       ├── js/
│       └── ai-ppt.json
│
└── published/
    └── test-deck/
        ├── v1/
        │   ├── index.html
        │   ├── css/
        │   ├── js/
        │   └── meta.json
        ├── v2/
        │   └── ...
        └── latest -> v2
```

### 发布元数据 (meta.json)

```json
{
  "version": "v1",
  "publishedAt": "2024-07-11T10:30:00.000Z",
  "theme": "business-blue",
  "animation": "slide",
  "url": "/published/test-deck/v1/index.html"
}
```

### 服务器路由扩展

```javascript
// /published/:name/latest/index.html -> 重定向到最新版本
// /published/:name/v1/index.html -> 具体版本
```

---

## Phase 5: LLM 生成提示词升级

### 目标

让 LLM 能够生成使用新数据组件的幻灯片。

### 提示词模板更新

在 `generate-deck.mjs` 中更新系统提示词：

```javascript
const systemPrompt = `You are an expert presentation designer.

Available slide layouts:
- cover-slide: 封面
- section-hero: 章节标题页
- visual: 视觉要点卡片
- stats: 数据指标展示
- data-matrix: 矩阵数据
- data-chart: 图表
- timeline: 时间线
- waterfall: 瀑布图
- quote: 引用
- thank-you: 结束

Available components (use the right class names):
- .data-metric for big numbers
- .chart-bar for bar charts
- .progress-ring for circular progress
- .chart-steps for step-by-step
- .data-compare for comparisons
- .timeline-horizontal for timeline
- .waterfall for waterfall charts

Respond only with HTML fragments for slides.`;
```

### 新增幻灯片生成函数

```javascript
function slideDataChart(title, dataPoints) {
  // ...
}

function slideMetricGrid(title, metrics) {
  // ...
}

function slideWaterfall(title, items) {
  // ...
}
```

---

## Phase 6: 导出更新

### 目标

确保 PPTX/PDF 导出支持新组件。

### PPTX 导出更新

更新 `export-pptx.mjs`：
- 识别新的数据组件类名
- 将数据组件转换为 PPT 原生形状
- 保留颜色主题

---

## 执行顺序总览

1. Phase 1: 数据可视化组件 (CSS + 示例)
2. Phase 2: Skills 系统
3. Phase 3: Workspace 管理页升级
4. Phase 4: 发布系统
5. Phase 5: LLM 提示词升级
6. Phase 6: 导出适配

---

## 文件变更清单

### 新增

- `ai-ppt-base/css/themes/` - 主题文件 (已完成)
- `skills/ppt-theme/SKILL.md`
- `skills/ppt-data/SKILL.md`
- `skills/ppt-anim/SKILL.md`
- `skills/ppt-publish/SKILL.md`
- `published/` - 发布目录 (运行时创建)
- `SKILLS_README.md`
- `UPGRADE-PLAN-WORKSPACE.md` (本文件)

### 修改

- `ai-ppt-base/css/ppt.css` - 增加数据组件和动画
- `ai-ppt-base/js/ppt.js` - 动画控制、主题切换增强
- `ai-ppt-base/index.html` - 数据组件示例
- `web/index.html` - Workspace 升级
- `web/js/web.js` - Workspace 逻辑
- `web/css/web.css` - Workspace 样式
- `server.mjs` - 新增 API 路由
- `scripts/config.mjs` - 主题/动画配置存储
- `scripts/generate-deck.mjs` - 新组件生成
- `scripts/export-pptx.mjs` - 新组件导出支持
- `scripts/upgrade-decks.mjs` - 升级逻辑更新
- `.gitignore` - 新增忽略规则

---

## 验收标准

- 数据组件能正常显示和交互
- 8个主题都能正常切换
- Workspace 能实时预览变更
- 发布流程顺畅，访问 URL 正常
- LLM 能生成使用新组件的幻灯片
- 导出 PPTX/PDF 效果良好
- Skills 可在 Claude/Kimi/Codex 使用

## 安全考虑

- 发布目录隔离，不会影响草稿
- 主题文件不会执行任意代码
- API Key 继续保持不落盘
