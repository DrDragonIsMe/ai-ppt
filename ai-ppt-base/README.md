# HTML 幻灯片演示系统

一个基于 HTML/CSS/JS 的轻量级幻灯片方案，采用冷调编辑感 + 电压青（#00B498）accent 风格，支持全屏放映、键盘导航、多页预览与 PDF 导出。

## 项目结构

```
.
├── index.html          # 幻灯片内容
├── css/
│   └── ppt.css         # 主题与放映样式
├── js/
│   └── ppt.js          # 导航、全屏、预览、PDF 导出引擎
└── theme-ref/
    └── teal-editorial-preview.html  # 风格参考
```

## 使用方式

直接用浏览器打开 `index.html` 即可放映。

### 键盘操作

| 按键 | 功能 |
|------|------|
| `→` | 下一页 |
| `←` | 上一页 |
| `Cmd + →` | 跳到最后一页 |
| `Cmd + ←` | 回到第一页 |
| `↑` | 多页预览（点击卡片跳转） |
| `↓` | 导出 PDF（打开系统打印对话框） |
| `F` | 切换全屏 |
| `ESC` | 退出全屏 / 退出预览 |
| `?` | 显示/隐藏快捷键帮助 |

### 鼠标操作

- 全屏模式下，点击鼠标左键可翻页。
- 非全屏模式下，左键不触发翻页，避免误操作。

## 编辑幻灯片

幻灯片内容写在 `index.html` 的 `<main id="stage">` 内，每个幻灯片是一个 `<section class="slide">`：

```html
<section class="slide">
  <div class="slide-content">
    <div class="kicker">标签</div>
    <h1>标题</h1>
    <p class="lead">导语段落</p>
  </div>
</section>
```

第一个幻灯片需要加上 `active` 类：

```html
<section class="slide active">
```

## 可用样式类

- `.kicker` — 顶部小标签
- `.section-title` — 章节标题
- `.section-hero` — 居中式封面/章节页
- `.lead` — 导语/大段落
- `.tile` — 卡片容器
- `.tile-row` — 卡片网格（自动多列）
- `.visual-card` — 视觉化卡片（带图标/数字，居中）
- `.visual-row` — 视觉卡片网格
- `.big-number` / `.big-number-label` — 巨型数字与标签
- `.hero-stat` — 居中数字强调区
- `.quote-block` — 引用块
- `.timeline` / `.timeline-item` — 时间轴
- `.badge-row` / `.badge` — 标签云
- `.ppt-table` — 幻灯片表格
- `.two-col` — 双栏/多栏布局
- `.split-visual` — 左右分栏视觉区
- `.highlight-box` — 高亮数据卡片
- `.gradient-text` — 渐变文字
- `.code-block` — 代码块
- `.btn-primary` / `.btn-secondary` — 按钮

## 导出 PDF / PPTX

- **浏览器打印**：按 `↓` 键触发系统打印对话框，选择「存储为 PDF」。打印样式已针对每页一张幻灯片优化。
- **服务端导出（推荐）**：在仓库根目录运行以下命令，可生成 `projects/<deck-name>/export/` 下的产物：
  - `npm run export-pptx -- <deck-name>` — 可编辑文字版 PPTX
  - `npm run export-pptx-image -- <deck-name>` — 高清图片版 PPTX（还原度最高）
  - `npm run export-pdf -- <deck-name>` — PDF（自动查找系统 Chrome）
- **Web 管理界面**：`npm run web` 打开管理台，生成或选择项目后按 `Ctrl+P` / `Cmd+P` 可调出导出面板。

## 预览

在支持 `/ppt-preview` skill 的 CLI 环境中，运行：

```bash
/ppt-preview
```

即可启动本地 HTTP 服务并在浏览器中打开当前 deck。

## 新建 deck

在支持 `/ppt-structure` skill 的 CLI 环境中，运行：

```bash
/ppt-structure <deck-name>
```

会从 `ai-ppt-base` 复制引擎文件并在 `projects/<deck-name>/` 下生成新的 `index.html`。

## 安装 CLI Skills

如果 `/ppt-preview`、`/ppt-structure`、`/ppt-edit` 指令不可用，回到仓库根目录安装 skills：

```bash
# 方式一：Shell 脚本
./install-skills.sh

# 方式二：Node 脚本
node install-skills.js

# 方式三：npx
npx ai-ppt-skills
```

安装后重启 CLI 会话即可使用 `/ppt-preview`、`/ppt-structure`、`/ppt-edit`、`/ppt-export`。

## 更新日志

### v1.7 — Web 管理、PPTX 与高清图片导出（2026-07）

- **Web 管理界面**：通过 `npm run web` 在浏览器中管理项目、配置来源与参数、自动生成幻灯片。
- **服务端导出**：支持导出可编辑文字 PPTX、高清图片 PPTX 与自动查找 Chrome 的 PDF。
- **更多视觉组件**：新增 `.visual-card`、`.hero-stat`、`.quote-block`、`.timeline`、`.badge-row`、`.split-visual`、`.gradient-text` 等类。

### v1.4 — PDF 页眉标题 + 专业水印（2025-07）

- **PDF 导出页眉**：点击 `↓` 导出前自动设置静态文档标题，浏览器打印对话框显示正确文件名。
- **打印水印**：每页添加半透明文字水印"内部资料，请勿非法传播"，防止外泄。
- **页边距优化**：通过 `@page` 调整上下边距，避免内容被裁剪。

### v1.3 — 打印输出介质自适应（2025-07）

- **物理打印**：幻灯片以 `100vw × 100vh` 渲染，A4 纸等比缩放内容，不再强制压缩到固定 297mm。
- **虚拟 PDF 导出**：浏览器 PDF 渲染器使用完整页面区域，保持满屏比例。
- **预览空白修复**：打印模式下 `.overview-card .slide-content` 强制 `opacity: 1 !important`，解决向上箭头打开多页预览时每个页面显示为空白的 bug。

### v1.2 — PDF 导出与预览修复（2025-07）

- **PDF 导出尺寸修复**：打印模式下 `.slide` 强制 `width: 100%` + `height: 100vh`，`.slide-content` 的 `max-width` 限制被覆盖为 `none`，解决 PDF 在 A4 纸上只占中心小区域的问题。
- **预览空白修复**：打印模式下 `.overview-card .slide` 和 `.overview-card .slide-content` 强制 `opacity: 1 !important`，解决向上箭头打开多页预览时每个页面显示为空白的 bug。
