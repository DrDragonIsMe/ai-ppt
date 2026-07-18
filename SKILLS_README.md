# ai-ppt Skills

ai-ppt 提供以下 Skills 用于管理和编辑幻灯片。

## Skills 列表

### ppt-theme

**主题管理**

切换和管理幻灯片主题。

- 列出主题: `/ppt-theme list`
- 切换主题: `/ppt-theme use <theme-name>`
- 查看当前: `/ppt-theme current`
- 导出配置: `/ppt-theme export`

**主题选项**: web-ui, business-blue, elegant-purple, warm-orange, sunset-red, tech-green, minimal-gray, dark-mode

### ppt-data

**数据可视化**

生成各种数据可视化组件。

- 数据指标: `/ppt-data metrics "标题"`
- 条形图: `/ppt-data bar chart "标题" [数据]`
- 时间线: `/ppt-data timeline "标题" [里程碑]`
- 瀑布图: `/ppt-data waterfall "标题" [项目]`
- 智能推荐: `/ppt-data suggest [描述]`

### ppt-anim

**动画配置**

配置幻灯片动画效果。

- 列出动画: `/ppt-anim list`
- 切换动画: `/ppt-anim use <type>`
- 查看当前: `/ppt-anim current`
- 调整速度: `/ppt-anim speed <fast|normal|slow>`
- 预览效果: `/ppt-anim preview`

**动画选项**: none, fade, slide, bounce

### ppt-publish

**发布管理**

发布幻灯片并管理版本。

- 发布: `/ppt-publish publish <project>`
- 历史: `/ppt-publish history <project>`
- 最新版: `/ppt-publish latest <project>`
- 特定版: `/ppt-publish version <project> <version>`
- 列出所有: `/ppt-publish list`

## 支持平台

- Claude Code
- Kimi CLI
- Cursor / Codex

## 安装

使用 Claude Code:

```bash
ai-ppt-skills
```

手动安装:
将 `skills/` 目录复制到你的 Claude Code skills 目录。

## Git 管理

所有 Skills 都纳入 Git 版本控制。
