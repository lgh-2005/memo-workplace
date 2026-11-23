# v3.8.2 CI 平台与发布门禁确认

v3.8.2 新增 `scripts/static-cache-smoke.mjs`（静态资源条件请求 + 复制入口 HTTP 降级，**29 断言**），已接入 `npm test` 与发布门禁；`release-check.mjs` 新增 2 项（该套件存在且已接入 `test.mjs`；`server.js` 必须含 `serveStaticFile` 与 `'Cache-Control': 'no-cache'`），`release-gate.mjs` 必需文件清单同步加入该套件，版本断言升至 3.8.2。当前 `release-check` 共 **38 项**。

该套件的三个特点：

1. **既测 HTTP 头也测浏览器行为**。「304 省字节」只看响应头就能验，但「复制在 HTTP 下真的能用」必须开真浏览器——套件用 Playwright 把 `navigator.clipboard` 主动置为 `undefined` 来精确复现线上非安全上下文，再断言 `copyText` 仍返回 true，避免「源码看起来有兜底」的自欺。
2. **反向验证过**（非恒真）：改回 `no-store` → 1 项失败；`copyText` 改名 → 3 项失败；注入裸 `navigator.clipboard.writeText(` → 1 项失败。
3. **踩过一次误报并已修正**：首版断言在统计 `navigator.clipboard.writeText(` 时未剥离 JSDoc 注释，把文档里的示例文字算成真实调用而误报；现改为「先剥离块注释再计数」，并在断言处注释说明原因。

**CI 影响**：本套件用 Playwright 起 Chromium，CI 已有 `playwright install --with-deps chromium` 步骤（各既有浏览器套件同样依赖），无需新增 CI 步骤或依赖。

## v3.8.1 CI 平台与发布门禁确认（历史）

v3.8.1 新增 `scripts/vocab-chat-smoke.mjs`（词汇精练单次会话请求数回归，20 断言），已接入 `npm test` 与发布门禁；`release-check.mjs` 新增 1 项（该套件存在且已接入 `test.mjs`），`release-gate.mjs` 必需文件清单同步加入，版本断言升至 3.8.1。

该套件的特点：**不只看接口状态**，而是用「假上游 LLM」直接观测服务端真正发给上游的 `messages` 组成与调用次数，因此能锁死「同一用户消息重复两次」「叠加操作产生多次上游调用」这类只看 HTTP 状态码发现不了的缺陷。套件已在**修复前代码**上反向验证：还原三处修复后实测 **9 项失败**（含 `roles=[system,user,user]`、`chat=2`、组字态 Enter 发出请求），确认断言有效而非恒真。

依赖说明：浏览器相关断言需要 `playwright`（devDependency，与 `mobile-device-check.mjs` 同源）。未安装时自动 `SKIP` 并明确打印，**不伪造通过**；纯接口与源码契约断言（13 项）在任何环境都执行。

v3.8.0 新增 `scripts/exam-analysis-smoke.mjs`（真题参考解析全链路，51 断言，含前端「零内联事件处理器」硬断言与生成器 JSON 修复器单测），已接入 `npm test` 与发布门禁；`release-check.mjs` 新增 3 项（解析回归脚本存在并接入、批处理生成器存在、解析目录随仓库分发），版本断言升至 3.8.0。

> v3.7.1 增量：服务端 Piper 解释器路径改为跨平台候选探测（`venv/bin/python` / `venv/bin/python3` / `venv/Scripts/python.exe`）。CI 不安装 `runtime/piper`，`tts-smoke` 的句子分支走 503 优雅降级断言；本地装好 Piper 后同一套件走 200 音频断言。

v3.7.0 新增 `scripts/ecdict-smoke.mjs`（离线词库：词库缺失降级 503、精确/大小写/规则还原/exchange 变形/词组、未收录、前缀联想、查询缓存性能，25 断言；沙箱通过 `ECDICT_HOME` 指向临时目录，无真实词库时只跑降级分支并输出 SKIP）。

v3.6.0 新增 `scripts/publication-tracks-smoke.mjs`（外刊刊物数据轨 + 按考试圈定语料范围，13 断言）。

本项目采用双仓模式：

- **代码主仓库**：Gitee `lgh-2005/memo-workplace`，`master` 是发布源。
- **CI 执行平台**：GitHub Actions，工作流位于 `.github/workflows/ci.yml`，在 Node 22 和 Node 24 上运行语法、核心测试、发布门禁、安全扫描、文档一致性和移动模拟回归。
- **触发方式**：本地发布流程在 Gitee 推送后同步推送 GitHub 镜像；GitHub `master` 的 push 事件触发 CI。也支持 GitHub Actions 手动 `workflow_dispatch`。
- **线上发布**：CI 通过后，使用 ECS `/opt/workbench/scripts/deploy.sh` 发布 Gitee `master`，不由 CI 直接操作生产服务器。

确认标准：`git ls-remote gitee master` 与 `git ls-remote origin master` 指向同一提交；`release-gate.mjs --refs` 通过；GitHub Actions 页面对应提交为绿色后，才允许生产发布。生产发布完成后运行 `online-health.mjs` 并保存 JSON 结果。

v3.3.6 的 `npm test` 额外执行 `scripts/study-plan-smoke.mjs`，使用两个隔离用户验证考试计划、任务完成、听说训练会话和学习流水不串号。

v3.4.0 增加 `scripts/frontend-refinement-smoke.mjs`，在隔离沙箱端到端验证简化后的导航、报告、计划、模型分配和组卷操作；`npm run test:mobile` 在 Pixel 7 / iPhone 13 模拟环境检查新入口布局与触控契约。

v3.4.3 增加服务商弹窗在 Pixel 7 / iPhone 13 和短屏移动视口中的交互回归；v3.4.2 验证取消请求后的写队列串行保护、超时返回、响应关闭短路和默认模型服务商切换回归；外刊 gzip 分片按需解压、行偏移随机读取、文件替换失效和有界 LRU 淘汰属于 v3.4.1。

v3.5.3 将语音运行时（Piper venv + 模型 + 合成缓存）移至 `runtime/`，不进入 CI 与仓库，也不参与 `data/` 备份。v3.5.2 的 `scripts/today-snapshot-smoke.mjs` 通过 `MAIMEMO_BASE` 注入假墨墨服务端，验证同步以本次今日词表快照为唯一真源（重建 / 部分返回 / 空返回均清空旧 `w.today`）；v3.5.1 的 `scripts/today-response-smoke.mjs` 验证严格「今日」作答筛选口径；v3.5.0 的 `scripts/tts-smoke.mjs` 验证 `/api/tts` 单词真人音源失败降级、句子在未部署 Piper 时返回 503、`/api/tts/status` 能力字段与 CSP `media-src` 放行。
