# v3.3.4 CI 平台确认

本项目采用双仓模式：

- **代码主仓库**：Gitee `lgh-2005/memo-workplace`，`master` 是发布源。
- **CI 执行平台**：GitHub Actions，工作流位于 `.github/workflows/ci.yml`，在 Node 22 和 Node 24 上运行 `npm test`。
- **触发方式**：本地发布流程在 Gitee 推送后同步推送 GitHub 镜像；GitHub `master` 的 push 事件触发 CI。也支持 GitHub Actions 手动 `workflow_dispatch`。
- **线上发布**：CI 通过后，使用 ECS `/opt/workbench/scripts/deploy.sh` 发布 Gitee `master`，不由 CI 直接操作生产服务器。

确认标准：`git ls-remote gitee master` 与 `git ls-remote origin master` 指向同一提交；GitHub Actions 页面对应提交为绿色后，才允许生产发布。
