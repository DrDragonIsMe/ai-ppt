# 贡献指南

感谢你对 ai-ppt 的关注。本文档说明开发环境搭建与提交流程，项目约定与架构细节见 [AGENTS.md](AGENTS.md)。

## 开发环境

要求 Node.js >= 18，无构建步骤。

```bash
git clone git@github.com:DrDragonIsMe/ai-ppt.git
cd ai-ppt
npm install            # 安装依赖，并自动执行 postinstall 安装 CLI skills
npm test               # 核心测试：node --test tests/core.test.mjs
npm run test:smoke     # 冒烟测试（覆盖 save-edits 等关键路径）
npm run web            # 启动 Web 控制台 http://localhost:3456
```

其他常用命令：

```bash
npm run intro                        # 打印快速上手指引
node install-skills.js --dry-run     # 预览 skills 安装动作（不改动文件）
npm run upgrade-decks -- --dry-run   # 预览基座引擎同步范围
```

## 目录结构

一页图见 [AGENTS.md](AGENTS.md) 的「目录结构」一节。要点：

- `ai-ppt-base/` 是 PPT 引擎（css/js）的**唯一升级源**，不要直接改各项目里的 `css/ppt.css` / `js/ppt.js`，改完基座用 `npm run upgrade-decks` 同步。
- `projects/<name>/` 存放所有业务 deck，每个 deck 必备 `ai-ppt.json`。
- `server.mjs` + `routes/` 是 Web 服务；`web/` 是无构建 ES Modules 前端。
- `scripts/` 是生成/导出/备份/搜索等工具脚本；`skills/` 是 CLI skill 定义（改完跑 `node install-skills.js` 同步到本机 CLI）。

## 提交前检查清单

1. **批量改动前备份**：`npm run backup`（产物在 `.backup/<ts>/`）。
2. **测试通过**：`npm test` 全绿；涉及 Web 服务行为时补跑 `npm run test:smoke`。
3. **约定同步**：改动涉及目录结构、脚本、工作流或约定时，同步更新 `AGENTS.md`；版本性变更记录到 `CHANGELOG.md`。
4. **skills 变更**：修改 `skills/` 后运行 `node install-skills.js` 重装验证幂等。
5. **不提交**：`.ai-ppt-config.json`、`.env.kimi`、`.ai-ppt-tasks.json`、`.backup/`、`.snapshots/`（均已 gitignore，提交前再确认一眼）。

## PR 规范

- 一个 PR 只做一件事，保持 diff 最小、可评审；不顺手重构无关代码。
- 提交信息用中文简述「做了什么 + 为什么」，引用相关 issue。
- 行为变更需在 PR 描述中说明验证方式（跑了哪些命令、结果如何）。
- 新功能优先复用现有模块（如 `scripts/fs-utils.mjs` 原子写盘、`scripts/front-matter.mjs` 解析），不引入第二份实现。

## 许可证

贡献的代码按仓库 [LICENSE](LICENSE)（MIT）发布。
