# 主题系统 · ai-ppt

## 概述

ai-ppt 现在内置了 8 种精心设计的主题，支持一键切换。主题选择会保存在 localStorage 中，下次打开时自动应用。

## 主题列表

| 主题 ID | 名称 | 主色 | 适用场景 |
|---------|------|------|----------|
| `web-ui` | Web UI | `#0D9488` | 专业、克制、现代（默认主题）|
| `business-blue` | 商务蓝 | `#2563EB` | 金融、咨询、B2B 演示 |
| `elegant-purple` | 优雅紫 | `#7C3AED` | 设计、时尚、高端服务 |
| `warm-orange` | 温暖橙 | `#EA580C` | 消费、零售、生活方式 |
| `sunset-red` | 日落红 | `#E11D48` | 营销、活动、消费品 |
| `tech-green` | 科技绿 | `#65A30D` | 新能源、环保、科技初创 |
| `minimal-gray` | 极简灰 | `#171717` | 设计工作室、极简品牌 |
| `dark-mode` | 暗黑模式 | `#22D3EE` | 科技产品发布、夜间演示 |

## 使用方式

### 方式一：使用主题切换器

1. 在演示文稿页面右上角，点击「主题」按钮
2. 从下拉列表中选择想要的主题
3. 主题即时生效

### 方式二：使用快捷键

- 按 **T 键** 循环切换所有主题

### 方式三：访问主题展示页

打开 `theme-showcase.html` 可以预览所有主题，点击主题卡片即可应用。

## 自定义主题

### 步骤 1：创建主题 CSS 文件

在 `ai-ppt-base/css/themes/` 目录下创建新的 CSS 文件，例如 `my-theme.css`：

```css
:root {
  /* Brand / Accent */
  --teal: #你的主色;
  --teal-light: #次亮色;
  --accent: #你的主色;
  --accent-light: #浅色背景;
  --accent-dark: #深色版本;

  /* Ink + Neutrals */
  --ink: #文字颜色;
  --navy: #深色区域背景;
  --slate: #次级文字;
  --muted: #更弱的文字;
  --cream: #页面背景;
  --surface: #卡片背景;
  --surface-subtle: #次级表面;
  --tile: #瓦片背景;
  --tile-strong: #强调瓦片;
  --border: #边框颜色;
  --border-strong: #强调边框;

  /* Status colors (optional) */
  --danger: #红色;
  --success: #绿色;
  --info: #蓝色;
}
```

### 步骤 2：在 ppt.js 中注册主题

编辑 `ai-ppt-base/js/ppt.js`，在 `themes` 数组中添加新主题：

```javascript
const themes = [
  // ... 现有主题
  { id: 'my-theme', name: '我的主题', color: '#你的主色' },
];
```

### 步骤 3：升级现有项目

运行升级脚本，将新主题复制到所有现有项目：

```bash
npm run upgrade-decks
```

## 主题开发建议

1. **颜色对比度**：确保文字与背景有足够的对比度（WCAG AA 标准）
2. **一致性**：保持所有组件使用相同的变量，不要硬编码颜色
3. **测试深色模式**：如果创建深色主题，确保所有组件都能正常显示
4. **导出测试**：测试 PPTX/PDF 导出效果，确保颜色能正常显示

## 文件结构

```
ai-ppt-base/
├── css/
│   ├── ppt.css              # 主样式（包含 Web UI 主题）
│   └── themes/
│       ├── theme-switcher.css  # 主题切换器 UI
│       ├── web-ui.css       # 默认主题（冗余，ppt.css 已包含）
│       ├── business-blue.css
│       ├── elegant-purple.css
│       ├── warm-orange.css
│       ├── sunset-red.css
│       ├── tech-green.css
│       ├── minimal-gray.css
│       └── dark-mode.css
├── js/
│   └── ppt.js               # 包含主题切换逻辑
├── index.html               # 演示文稿
└── theme-showcase.html      # 主题展示页
```

## 技术实现

- 主题通过 CSS 变量实现，无运行时依赖
- 使用 `localStorage` 保存用户主题偏好
- 主题切换器在打印/导出时自动隐藏
- 支持从 URL 加载外部主题 CSS（未来可扩展）

## 未来扩展

可能的功能：

- 自定义主题编辑器
- 主题预设（字体、间距、动画）
- 一键导入/导出主题
- 更多内置主题（渐变色、霓虹色、复古色等）
