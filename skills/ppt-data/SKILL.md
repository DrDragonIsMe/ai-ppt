---
name: ppt-data
description: 在 ai-ppt 幻灯片中生成数据可视化组件
metadata:
  tags: ppt, data, chart, visualization, metrics
---

# ppt-data Skill

用于在 ai-ppt 幻灯片中生成各种数据可视化组件。

## 可用组件

### 数据指标

大数字展示，适合展示关键指标：
- `data-metric` - 单个大数字指标
- `data-compare` - 多个对比指标

### 图表

数据图表展示：
- `chart-line` - 折线/面积图（SVG，`data-chart` 声明数据，多序列）
- `chart-pie` - 饼图/环图（SVG，占比标签 + 图例）
- `chart-bars` - 分组/堆叠柱状图（SVG）
- `chart-bar` - 条形图（纯 CSS 静件，手写高度）
- `progress-ring` - 环形进度图

`chart-line` / `chart-pie` / `chart-bars` 为引擎内置 SVG 图表：在容器上用 `data-chart` JSON 声明数据，ppt.js 初始化时渲染为内联静态 SVG，打印/截图/缩略图天然正确。配色取 `var(--chart-1..6)`（`--chart-1` 跟随主题品牌色），主题 css 可覆盖。

### 时间与流程

流程与时间展示：
- `chart-steps` - 阶梯流程
- `timeline-horizontal` - 水平时间线

### 矩阵与成本

矩阵与成本分析：
- `data-matrix` - 数据矩阵（2x2 或 3x3）
- `waterfall` - 瀑布图

## 使用方式

### 生成数据指标幻灯片

```
/ppt-data metrics "关键指标"
```

生成包含数据指标的幻灯片。

### 生成条形图

```
/ppt-data bar chart "季度增长" [数据列表]
```

### 生成时间线

```
/ppt-data timeline "产品路线图" [里程碑]
```

### 生成瀑布图

```
/ppt-data waterfall "成本分析" [项目]
```

### 智能布局建议

```
/ppt-data suggest [数据描述]
```

根据数据类型，智能推荐最合适的可视化方式。

## 组件示例

### 折线/面积图（chart-line）

```html
<div class="chart-line" data-chart='{"labels":["Q1","Q2","Q3","Q4"],"series":[{"name":"客户数","data":[120,180,260,320]},{"name":"活跃数","data":[80,110,150,200]}],"area":true}'></div>
```

- `series` 支持多序列（自动出图例）；`area: true` 面积填充；`points: false` 隐藏数据点；`valueLabels: true` 显示每点数值。
- `data-chart` 属性外层单引号、JSON 内双引号，容器内部留空。

### 饼图/环图（chart-pie）

```html
<div class="chart-pie" data-chart='{"labels":["薪酬","考勤","招聘","其他"],"data":[45,25,20,10],"donut":true,"centerLabel":"构成"}'></div>
```

- `data` 与 `labels` 一一对应（也接受 `series[0].data`）；`donut: true` 渲染环图；自动生成占比标签与右侧图例。

### 分组/堆叠柱状图（chart-bars）

```html
<div class="chart-bars" data-chart='{"labels":["Q1","Q2","Q3","Q4"],"series":[{"name":"2024","data":[45,58,72,85]},{"name":"2025","data":[52,66,81,97]}]}'></div>
```

- 默认分组柱；`stacked: true` 堆叠柱（`segmentLabels: true` 显示分段值）；`valueLabels: false` 关闭柱顶数值。

### 条形图

```html
<div class="chart-bar">
  <div class="chart-bar-item">
    <div class="chart-bar-bar" style="height: 100px;"></div>
    <div class="chart-bar-value">45%</div>
    <div class="chart-bar-label">Q1</div>
  </div>
  <div class="chart-bar-item">
    <div class="chart-bar-bar" style="height: 130px;"></div>
    <div class="chart-bar-value">58%</div>
    <div class="chart-bar-label">Q2</div>
  </div>
</div>
```

### 环形图

```html
<div class="progress-ring">
  <div class="progress-ring-item">
    <svg class="progress-ring-svg" viewBox="0 0 120 120">
      <circle class="progress-ring-circle-bg" cx="60" cy="60" r="50"></circle>
      <circle class="progress-ring-circle" cx="60" cy="60" r="50" style="--progress-pct: 84;"></circle>
    </svg>
    <div class="progress-ring-value">84%</div>
    <div class="progress-ring-label">薪酬计算</div>
  </div>
</div>
```

### 数据矩阵

```html
<div class="data-matrix data-matrix-2x2">
  <div class="data-matrix-cell hot">
    <div class="data-matrix-value">高</div>
    <div class="data-matrix-label">效率提升</div>
  </div>
  <div class="data-matrix-cell warm">
    <div class="data-matrix-value">中</div>
    <div class="data-matrix-label">成本优化</div>
  </div>
  <div class="data-matrix-cell warm">
    <div class="data-matrix-value">高</div>
    <div class="data-matrix-label">风险控制</div>
  </div>
  <div class="data-matrix-cell">
    <div class="data-matrix-value">高</div>
    <div class="data-matrix-label">员工体验</div>
  </div>
</div>
```

## 支持平台

- Claude Code
- Kimi CLI
- Cursor / Codex
