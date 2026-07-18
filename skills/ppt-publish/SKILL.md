---
name: ppt-publish
description: 发布 ai-ppt 幻灯片并管理发布版本
metadata:
  tags: ppt, publish, release, version, share
---

# ppt-publish Skill

用于发布 ai-ppt 幻灯片并管理发布版本。

## 发布概念

### 草稿 vs 已发布

- **草稿**: `projects/` 目录下，可编辑修改
- **已发布**: `published/` 目录下，只读，永久链接

### 版本管理

每次发布创建新版本：
- `v1`, `v2`, `v3`... 每次递增
- `latest` 总是指向最新版本

## 使用方式

### 发布当前草稿

```
/ppt-publish publish <project-name>
```

将当前草稿发布为新版本。

示例：
```
/ppt-publish publish test-deck
```

### 查看发布历史

```
/ppt-publish history <project-name>
```

查看项目的所有发布版本。

### 访问最新版本

```
/ppt-publish latest <project-name>
```

返回最新版本的访问链接。

### 访问特定版本

```
/ppt-publish version <project-name> <version>
```

返回指定版本的访问链接。

### 列出所有发布

```
/ppt-publish list
```

列出所有已发布的项目。

## 访问链接

发布后，幻灯片可通过以下地址访问：

- 最新版: `http://localhost:3456/published/<project-name>/latest/index.html`
- 特定版: `http://localhost:3456/published/<project-name>/v1/index.html`

## 发布元数据

每个发布包含 `meta.json`：

```json
{
  "version": "v1",
  "publishedAt": "2024-07-11T10:30:00.000Z",
  "theme": "business-blue",
  "animation": "slide",
  "url": "/published/test-deck/v1/index.html"
}
```

## 工作流建议

1. 在 `projects/` 中编辑草稿
2. 预览和调整
3. 满意后执行 `/ppt-publish publish`
4. 分享最新版本链接给他人

## 注意事项

- 已发布版本不可修改，如需变更请在草稿中修改后重新发布
- 每个发布都是独立的，旧版本始终可用
- 发布不会影响正在进行的编辑
- 访问链接可以分享给团队成员

## 支持平台

- Claude Code
- Kimi CLI
- Cursor / Codex
