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
- `chart-bar` - 条形图
- `progress-ring` - 环形进度图

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
      <circle class="progress-ring-circle" cx="60" cy="60" r="50" style="--progress: 50;"></circle>
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
