# TESTING.md — 测试来源、清单与验收硬门槛

> 本文件是 `v2.2.8` 的**可审计测试来源声明**，随产品仓库进入 Gitee，供审计确认测试基线、脚本清单与预期结果。
> 代码基线：`0705689`　·　对应 tag：`v2.2.8`　·　版本口径：`2.2.8`

## 1. 测试来源与隔离策略

- 全部测试脚本位于本地 `english-workbench/.workbuddy/`。
- 该目录因包含 500+ 历史调试夹具与运行截图，长期被 `.gitignore`（第 17 行 `.workbuddy/`）排除，**不入仓库**。
- 本文件固化「脚本来源 = 本地工作树对应 commit」的关系；`.gitignore` 的隔离策略保持不变（`git check-ignore -v .workbuddy/test_v228_concurrency.js` 仍返回 `.gitignore:17`）。
- 每个测试均在独立临时沙箱中复制 `server.js` + `public/*`，使用 mock LLM（`config.llm.mock=true`）与固定端口，**不触碰真实 `data/`**。

## 2. 真实数据哈希保护范围

以下三个文件在测试前后 SHA-256 必须不变；文件不存在时以 `null` 记初始值：

| 文件 | 说明 |
|---|---|
| `data/db.json` | 主数据库（含墨墨 Token 等密钥，永不入库） |
| `data/answers.json` | 真题标准答案（权威来源，仅人工录入） |
| `data/learning_attempts.json` | 学习流水（`schemaVersion:1`，上限 20000，本地缺省不存在） |

## 3. 脚本清单（27 套 · 全部预期退出码 `0`）

### 3.1 后端套件（14）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 1 | `.workbuddy/test_v220_storage.js` | 18 | 存储原子写/备份/损坏保护 |
| 2 | `.workbuddy/test_v220_regress.js` | 8 | Part B 2023 A–H 判分回归 + 真实三文件哈希 |
| 3 | `.workbuddy/test_v221_quiz.js` | 19 | 单词测验（flash/choice/spell） |
| 4 | `.workbuddy/test_v222_unit.js` | 25 | 单元题库与判分 |
| 5 | `.workbuddy/test_v223_report.js` | 13 | 学习诊断周报 |
| 6 | `.workbuddy/test_v224_vocab.js` | 23 | 词汇真题迁移 |
| 7 | `.workbuddy/test_v225_sentence.js` | 32 | 长难句三遍训练与复测 |
| 8 | `.workbuddy/test_v226_backup.js` | 23 | 备份与恢复 |
| 9 | `.workbuddy/test_v220.js` | 63 | 合并 E2E + 容量裁剪(20000)/未来任务与待重试保护 |
| 10 | `.workbuddy/test_v228_concurrency.js` | 22 | 流水并发安全 + 损坏文件保护 |
| 11 | `.workbuddy/test_v228_sourceref.js` | 23 | 真实划选 sourceRef 服务端来源校验 |
| 12 | `.workbuddy/test_v228_vocab.js` | 19 | 迁移信心 / 来源稳定 / 同词性干扰项 |
| 13 | `.workbuddy/test_v228_unit.js` | 28 | 单元 section 严格分支 / 错因权限 / 耗时口径 |
| 14 | `.workbuddy/test_v228_report.js` | 20 | 周报排除 pending / bySection / pendingRetries |

### 3.2 浏览器套件（12，Playwright）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 15 | `.workbuddy/test_v221_playwright.js` | 6 | 单词测验 UI |
| 16 | `.workbuddy/test_v222_playwright.js` | 7 | 单元题库 UI |
| 17 | `.workbuddy/test_v223_playwright.js` | 9 | 周报弹层异步明细 |
| 18 | `.workbuddy/test_v224_playwright.js` | 6 | 迁移训练 UI |
| 19 | `.workbuddy/test_v225_playwright.js` | 14 | 长难句 UI |
| 20 | `.workbuddy/test_v226_playwright.js` | 39 | 四风格×昼夜可读性 + 三视口无溢出 |
| 21 | `.workbuddy/test_v220_ui.js` | 36 | 真实作答三类测验 + 迁移真实信心 + 真实划选 |
| 22 | `.workbuddy/test_v228_sourceref_ui.js` | 28 | 真题/手工语料/单元三通道真实划选 |
| 23 | `.workbuddy/test_v228_vocab_ui.js` | 14 | 迁移独立信心组 UI |
| 24 | `.workbuddy/test_v228_unit_ui.js` | 16 | 单元 section 收集 + batchId |
| 25 | `.workbuddy/test_v228_report_ui.js` | 14 | 分题型统计 + 待重试提示 |
| 26 | `.workbuddy/test_v228_ui_contract.js` | 16 | 四风格口径 + 触控 ≥44px + 缩进 + 无溢出 |

### 3.3 线上只读冒烟（1）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 27 | `.workbuddy/test_v228_online_smoke.js` | 12 | 线上只读 API/页面/版本/无持久化写 |

> 合计 **27** 套、断言总数 **553**（14 后端 336 + 12 浏览器 205 + 1 线上冒烟 12）。共用收口工具 `.workbuddy/_test_util.js`（`stopServer`/`cleanupSandbox`），所有脚本以 `process.exitCode` 退出。

> **说明**：`english-workbench/.workbuddy/` 目录下共 32 个 `test_*.js`，其中 6 个（`test_hl.js`、`test_v117d.js`、`test_v117ef.js`、`test_v212.js`、`test_v212_ui.js`、`test_v117*` 等）为 v1.x 历史遗留调试脚本，**不属于 v2.2.8 验收范围**；上表 27 套为本版验收清单，与计划「14 后端 + 12 浏览器 + 1 线上冒烟」一一对应。

## 4. 运行顺序（建议）

先跑后端（无浏览器依赖），再跑浏览器，最后跑线上冒烟：

```text
node .workbuddy/test_v220_storage.js
node .workbuddy/test_v220_regress.js
node .workbuddy/test_v221_quiz.js
node .workbuddy/test_v222_unit.js
node .workbuddy/test_v223_report.js
node .workbuddy/test_v224_vocab.js
node .workbuddy/test_v225_sentence.js
node .workbuddy/test_v226_backup.js
node .workbuddy/test_v220.js
node .workbuddy/test_v228_concurrency.js
node .workbuddy/test_v228_sourceref.js
node .workbuddy/test_v228_vocab.js
node .workbuddy/test_v228_unit.js
node .workbuddy/test_v228_report.js
node .workbuddy/test_v221_playwright.js
node .workbuddy/test_v222_playwright.js
node .workbuddy/test_v223_playwright.js
node .workbuddy/test_v224_playwright.js
node .workbuddy/test_v225_playwright.js
node .workbuddy/test_v226_playwright.js
node .workbuddy/test_v220_ui.js
node .workbuddy/test_v228_sourceref_ui.js
node .workbuddy/test_v228_vocab_ui.js
node .workbuddy/test_v228_unit_ui.js
node .workbuddy/test_v228_report_ui.js
node .workbuddy/test_v228_ui_contract.js
```

线上只读冒烟（需本机 `Desktop/password.txt`；Basic Auth 用户 `贾忖`）：

```text
# canonical 入口为 ECS 直连（国内备案不便，本项目不依赖域名）
node .workbuddy/test_v228_online_smoke.js
# 严格模式：configured 入口不可达即失败，禁止回退
ONLINE_REQUIRE_ORIGIN=1 node .workbuddy/test_v228_online_smoke.js
```

## 5. 线上冒烟入口与写接口红线

- **canonical 入口**：`http://121.43.177.191`（ECS 直连，Basic Auth）。
  - 本工作台为个人自用，国内备案不便，**不绑定域名**；`memo.luguhu.online` 不作为发布依赖。
  - 可通过 `ONLINE_BASE` 覆盖入口；默认值与回退值均为 ECS 直连。
- **只允许**：`GET /`、`GET /api/status`、`GET /api/learning/report?days=7`、`GET /api/unit/records` 及页面只读渲染。
- **严禁**：`/api/sync`、`/api/unit/answers`（保存/提交）、`/api/quiz/submit`、`/api/learning/vocab/submit`、`/api/learning/sentence/submit`、`/api/mnote`、`/api/backup`、`/api/restore`、`/api/exam/import`、`/api/kb/import` 等一切持久化写接口。冒烟脚本内置路由拦截断言。

## 6. 当前发布状态（截至本文件提交）

- ✅ 本地 / Gitee `master` / tag `v2.2.8` / ECS `/opt/workbench` 均为 `0705689`；`workbench.service` `active`。
- ✅ 27 套件全部退出码 `0`，无残留 `server.js` 子进程，真实 `data/` 三文件哈希不变。
- ✅ 线上只读冒烟通过（ECS 直连入口）。
- ✅ tag `v2.2.8` 已推送 Gitee（附注 tag，peeled `0705689`）。
- ⏳ **Gitee Release 尚未创建**：账号未完成手机身份绑定，`release create` 返回 HTTP 400（平台账号级限制）。绑定后以既有 `v2.2.8` tag 创建，**不得**新建同名 tag 或移动 tag。
- ℹ️ 线上学习流水 `data/learning_attempts.json` 为空态；线上无 `data/answers.json`。

> 本文档**不得**在 Gitee Release 实际创建成功前声称 "Release 已完成"。
