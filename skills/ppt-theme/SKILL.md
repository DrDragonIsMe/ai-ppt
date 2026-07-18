---
name: ppt-theme
description: 管理和切换 ai-ppt 幻灯片主题
metadata:
  tags: ppt, theme, style, colors
---

# ppt-theme Skill

用于管理和切换 ai-ppt 幻灯片的主题。

## 主题列表

- `web-ui` - 默认主题，青色，专业克制
- `business-blue` - 商务蓝，稳重专业
- `elegant-purple` - 优雅紫，高端创意
- `warm-orange` - 温暖橙，活力亲切
- `sunset-red` - 日落红，热情有冲击力
- `tech-green` - 科技绿，环保可持续
- `minimal-gray` - 极简灰，克制高级
- `dark-mode` - 暗黑模式，沉浸护眼

## 使用方式

### 列出可用主题

```
/ppt-theme list
```

显示所有可用主题及其描述。

### 查看当前主题

```
/ppt-theme current
```

显示当前使用的主题。

### 切换主题

```
/ppt-theme use <theme-name>
```

示例：
```
/ppt-theme use business-blue
/ppt-theme use dark-mode
```

### 导出当前主题配置

```
/ppt-theme export
```

导出当前主题的 CSS 变量配置。

### 主题预览

```
/ppt-theme preview <theme-name>
```

预览指定主题的效果（如可用）。

## 项目位置

项目通常位于：
- 当前目录下
- `projects/` 子目录下

## 注意事项

- 主题切换会修改项目的 `css/themes/` 目录下的文件
- 当前主题设置会保存在项目的 `ai-ppt.json` 配置中
- 切换主题后，建议刷新浏览器预览效果
