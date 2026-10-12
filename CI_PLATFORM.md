# v3.4.3 CI 平台与发布门禁确认

本项目采用双仓模式：

- **代码主仓库**：Gitee `lgh-2005/memo-workplace`，`master` 是发布源。
- **CI 执行平台**：GitHub Actions，工作流位于 `.github/workflows/ci.yml`，在 Node 22 和 Node 24 上运行语法、核心测试、发布门禁、安全扫描、文档一致性和移动模拟回归。
- **触发方式**：本地发布流程在 Gitee 推送后同步推送 GitHub 镜像；GitHub `master` 的 push 事件触发 CI。也支持 GitHub Actions 手动 `workflow_dispatch`。
- **线上发布**：CI 通过后，使用 ECS `/opt/workbench/scripts/deploy.sh` 发布 Gitee `master`，不由 CI 直接操作生产服务器。

确认标准：`git ls-remote gitee master` 与 `git ls-remote origin master` 指向同一提交；`release-gate.mjs --refs` 通过；GitHub Actions 页面对应提交为绿色后，才允许生产发布。生产发布完成后运行 `online-health.mjs` 并保存 JSON 结果。

v3.3.6 的 `npm test` 额外执行 `scripts/study-plan-smoke.mjs`，使用两个隔离用户验证考试计划、任务完成、听说训练会话和学习流水不串号。

v3.4.0 增加 `scripts/frontend-refinement-smoke.mjs`，在隔离沙箱端到端验证简化后的导航、报告、计划、模型分配和组卷操作；`npm run test:mobile` 在 Pixel 7 / iPhone 13 模拟环境检查新入口布局与触控契约。

v3.4.3 增加服务商弹窗在 Pixel 7 / iPhone 13 和短屏移动视口中的交互回归；v3.4.2 验证取消请求后的写队列串行保护、超时返回、响应关闭短路和默认模型服务商切换回归；外刊 gzip 分片按需解压、行偏移随机读取、文件替换失效和有界 LRU 淘汰属于 v3.4.1。
