---
name: ppt-anim
description: 配置 ai-ppt 幻灯片的动画效果
metadata:
  tags: ppt, animation, transition, motion
---

# ppt-anim Skill

用于配置 ai-ppt 幻灯片的动画效果。

## 动画类型

### `anim-none` - 无动画

所有元素直接显示，没有过渡效果。
适用场景：严肃正式的演示、快速切换的场景。

### `anim-fade` - 渐入

元素淡入显示，柔和优雅。
适用场景：品牌发布、艺术展示。

### `anim-slide` - 滑入（默认）

元素从下方滑入，有层次感。
适用场景：大多数商务演示。

### `anim-bounce` - 弹性弹出

元素弹性弹出，活泼有活力。
适用场景：产品发布、创意展示。

## 使用方式

### 查看当前动画

```
/ppt-anim current
```

显示当前使用的动画类型。

### 切换动画类型

```
/ppt-anim use <animation-type>
```

示例：
```
/ppt-anim use fade
/ppt-anim use bounce
```

### 列出可用动画

```
/ppt-anim list
```

显示所有可用动画类型及其说明。

### 调整动画速度

```
/ppt-anim speed <fast|normal|slow>
```

调整动画的速度：
- `fast` - 快速
- `normal` - 正常
- `slow` - 缓慢

### 预览动画效果

```
/ppt-anim preview
```

预览当前设置的动画效果。

## CSS 类说明

在 `index.html` 的 `<body>` 或 `<div id="app">` 上添加动画类：

```html
<body class="anim-fade">
  ...
</body>
```

## 动画细节

### 延迟时间

- Kicker (小标签): 0.1s
- 标题: 0.15s
- 引导文字: 0.22s
- 卡片 1: 0.22s
- 卡片 2: 0.32s
- 卡片 3: 0.42s
- 卡片 4: 0.52s

### 动画时长

- 渐入: 0.5s
- 滑入: 0.6s
- 弹性: 0.5s (带弹性曲线)

## 支持平台

- Claude Code
- Kimi CLI
- Cursor / Codex
