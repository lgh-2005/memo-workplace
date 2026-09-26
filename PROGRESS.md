# 项目交接与当前进度 (Agent Handover State)

> 生成时间：2026-09-14（北京时间）· 最近更新：2026-09-25（v3.2.0）
> 生成者：AI 工程负责人（v3.2.0 多用户 P2/P3 合并交付已完成）
> 工作区根：`D:\ai\opencode\momo`
> 应用仓库根：`D:\ai\opencode\momo\english-workbench`（独立 git 仓库，分支 `master`）
> **当前版本：`v3.2.0`**（`package.json` = `3.2.0`，`public/index.html` 三处版本标识 = `v3.2.0`，零 dependencies）
> **Gitee HEAD：`726bd7f`**（v3.2.0 多用户 P2 数据分区收尾 + P3 集成改造）。线上 ECS `/opt/workbench` 已 ff 合并至 `726bd7f` 并重启，`workbench.service` active，多用户已启用（`config.multiUser=true`），线上冒烟 16/16；`external.format=v2` / `count=4070`。

---

## 0. ⭐ v3.2.0 多用户 P2 数据分区收尾 + P3 集成改造（最新，已完成）

**主题**：多用户路线图 **P2/P3 合并交付**。P2 把「用户级文件真正按用户落盘」收尾为「共享资源写操作仅管理员 + 全量备份集成」；P3 把三处原全局集成（墨墨 Token/频控/云词本、LLM 调用、自动同步）改造为 per-user，并为共享 LLM Key 补上**用量统计与看板**。详细见根工作区《版本号经历.md》v3.2.0 章节。

**决策基线（用户拍板）**：LLM 用量**仅统计与看板、不设额度硬拦截**；用量看板**普通用户看自己、管理员看全员**；共享内容导入/增删改/版本恢复**均仅管理员**；自动同步**启动即遍历所有用户装配**。

**关键成果**：
- **P2 共享资源只读**：新增 `requireAdmin(res, store, what)`，多用户下普通用户对共享资源只读，覆盖 `kb/import`·`exam/import`·`kb/record/update`·`kb/record/delete`·`kb/version/restore`·`unit/answers/save`·`mineru/parse` 七处，统一 403 `FORBIDDEN`；`llm_usage.json` 纳入 `USER_DATA_FILES` + 迁移 + 备份三处统一清单。
- **P3 墨墨 per-user**：`mmLimiter` Map（`limiterState()` 按 `userId` 隔离频控滑动窗口与自适应间隔）、`notepadCaches` Map（云词库缓存按用户隔离）。
- **P3 LLM 用量**：`llmChat`/`llmChatSSE` 抓上游 `usage`（流式带 `stream_options.include_usage`，mock 走 `estimateUsage`），按北京自然日聚合落 `data/users/<id>/llm_usage.json`；新增 `GET /api/llm/usage`（普通用户看自己、管理员 `scope=all` 看全员、越权 403）+ 前端「📊 AI 用量」看板。
- **P3 自动同步 per-user**：`autoTimers` Map，`armAutoSyncForUser`/`armAutoSync` 启动/迁移/配置变更遍历装配，删除用户自动撤下。

**验证**：`node --check` 0 错误；新增 `test_v320_multiuser_p3.js`(**56**，后端) + `test_v320_usage_ui.js`(**10**，浏览器) 全绿；全量回归 **本地 58 套件退出码 0**。

**发布**：commit `726bd7f`，Gitee `master` 已推；ECS `/opt/workbench` 已 ff 合并至 `726bd7f`（先 `tar` 备份 data 至 `data_backup_v320_20260926-203403.tar.gz`），服务重启后 `active`，线上冒烟 16/16（三方哈希一致，版本 v3.2.0），多用户保持启用。

---

## 0. ⭐ v3.1.0 多用户 P1 账户体系（已完成 · 前端）

**主题**：P0 后端底座（v3.0.0）就位后补齐**前端账户体系**，让「注册 → 登录 → 按角色使用 → 登出」在浏览器完整可用。后端（scrypt 注册/登录、邀请码、持久会话、角色、门禁）在 v3.0.0 已就绪，本版主要在前端落地并对管理员专属接口加固。详细见根工作区《版本号经历.md》v3.1.0 章节。

**决策基线（用户拍板）**：登录 UI = 遮罩「登录/注册」双标签 + 设置页「我的账户」区；普通用户**隐藏**管理员专属设置区；登出清会话+用户数据、**保留设备偏好**；本轮部署后**立即迁移启用**多用户。

**关键成果**：
- **登录遮罩自适应**：`applyAuthMode()` 依 `/api/auth/status` 的 `multiUser` 切换——多用户走用户名+密码登录 / 一次性邀请码注册（注册即登录），单用户仍为 Token 凭证。
- **账户区**：设置页「👤 我的账户」（默认展开）显示用户名 + 角色 + 「🚪 退出登录」。
- **角色显隐**：`data-admin-only` 标记管理员专属区（模型服务/登录与安全/数据备份），`applyRoleVisibility()` 按 `isAdminUser()` 显隐。
- **登出清理**：清内存 state + `wrtDraft_*` + `wb-pomo`，保留 `wb-theme`/`wb-style`/白噪音等设备偏好；遮罩复现。
- **接口加固**：多用户下备份 创建/列表/恢复 加 `isAdminCtx` 守卫（403）。

**验证**：`node --check` 0 错误；新增 `test_v310_multiuser_ui.js`(**28** 全绿，浏览器)；`test_v300_multiuser`(52)/`test_v280_auth`(49)/`test_v280_ui`(22)/`test_v226_backup`(25) 保持绿；全量回归 **30 后端/单测 + 26 浏览器套件退出码 0**。

**发布策略**：v3.1.0 推 Gitee + 同步线上，**部署后执行 `/api/admin/migrate` 启用多用户**。

---

## 0. ⭐ v3.0.0 多用户 P0 基础设施（已完成 · 仅后端）

**主题**：从「单人本地工作台」迈向「小圈子多用户学习网站」的第一批（P0）底座——把单租户架构（全体共享 `config`/`db` 单例、凭据全局唯一）改造为**请求级用户隔离**。**本版仅后端、无前端 UI**，为 P1 登录/注册界面、P2 隐私硬化、P3 共享 LLM Key + 每用户额度打地基。详细见根工作区《版本号经历.md》v3.0.0 章节。

**决策基线（用户拍板）**：小圈子邀请制（<50 人，每用户独立 JSON 目录，不引数据库）；每人自带墨墨 Token；管理员共享 LLM Key + 每用户额度（P3）；用户名+密码+一次性邀请码注册；会话持久化到磁盘；管理员全权配置；邀请码用后即废；升级默认 `multiUser=false` 零破坏迁入；admin 初始密码沿用现有 `config.auth.token`。

**关键成果**：
- **零破坏总开关** `config.multiUser`（默认 false）：关闭时所有路径回退旧单用户（`LEGACY_USER` + 扁平 `data/*.json`），行为与 v2.12.0 完全一致；刻意不复用 `auth.enabled`，保证 60 套既有测试零改动。
- **隔离机制**：`AsyncLocalStorage` 请求上下文绑定 `userId/role`；`config`/`db` 改**透明 Proxy**（业务代码 269 处 `config.` + 147 处 `db.` 零改动）；config 按 `USER_CONFIG_KEYS` 分流用户级/全局；用户级文件落 `data/users/<id>/`；`enqueueUserWrite` 每用户写串行队列防并发覆盖。
- **账户与会话**：`data/users.json`（`scryptSync` 加盐哈希）+ `data/sessions.json`（30 天，重启不掉线，绑定 `userId`，httpOnly Cookie `wb_session`）。
- **注册/权限**：用户名(2–20)+密码(6–128)+一次性邀请码，上限 50 人；管理员全权配置，普通用户改全局键 403 `FORBIDDEN`。
- **接口**：`/api/auth/status`·`login`·`register`·`logout`；管理员 `POST /api/admin/migrate`、`GET/POST /api/admin/invites`、`GET/DELETE /api/admin/users`。
- **备份集成**：`USER_DATA_FILES`/`backupFileSpecs`/`restoreFileSpecs` 三处统一按 `users/<id>/` 分层打包。
- **修得一处真缺陷**：迁移原读盘拆分 `config.json` 缺 `imageGen`/`dict` 默认键，致新用户 `GET /api/config` 抛 `Cannot read properties of undefined (reading 'baseUrl')`——改为以内存 `rawConfig` 深拷贝为基准。

**验证**：`node --check server.js/app.js` 0 错误；新增 `test_v300_multiuser.js`(**52** 全绿，含**重启后 Cookie 仍有效**)；`test_v226_backup` 断言更新为「三处共用清单」(25)；`test_v280_auth`(49)/`test_v280_ui`(22) 保持绿；全量回归 **30 后端/单测 + 25 浏览器套件退出码 0**（`test_v212*` 两套为 v1.x 遗留、依赖 v2.6.2 已删 AI 审读，属既有失败）。

**发布策略**：打包 v3.0.0 仅推 Gitee + 同步线上代码，**暂不启用多用户**；待 P1 前端登录/注册 UI 就绪后再执行迁移启用。

---

## 0. ⭐ v2.9.0 外刊全自动入库（已完成）

**主题**：把「外刊采集 → 网站可见」从手工搬运升级为**无人值守投递链路**，并根治线上 1.6G 内存隐患。详细见根工作区《版本号经历.md》v2.9.0 章节。

**关键成果**：
- **发布格式 v2（瘦索引 + 分片 gzip 全文）**：`articles_index.jsonl`（元数据，3.6MB/4070 篇，常驻内存）+ `articles_body/body-XX.jsonl.gz`（16 分片，点开某篇只解一片）+ `sentences_index.jsonl.gz`（句子索引）。整包 **141MB → 26MB**；`loadExternalKb()` 由全量 parse（446MB heap）降为读索引。**旧版整包目录自动回退兼容**（`externalStatus().format` = `v1`/`v2`）。
- **采集侧脚本**（本地源=唯一真相，已部署 HK）：`build_release_v2.py`（自包含，全量 8s）+ `build_release_incremental.py`（夜间编排，45 天回看窗口，窗口外从上一版带过）。
- **投递链路**：HK cron `0 4 * * *` 构建 → ECS cron `30 4 * * *` 跑 `/opt/workbench/scripts/pull_external.sh`（`~/.ssh/hk_pull` 免密 rsync → sha256 与 manifest 核对 → 归档旧版留 5 份 → 原子替换 → 只读冒烟）。服务端 mtime 热重载，**无需重启**。
- **香港补齐**：把本地独有的经济学人/卫报/科学美国人/大西洋月刊/CSMonitor 全量并集推到 HK，现 **11 源完整**（4070 篇）。
- **环境修复**：HK sshd `PubkeyAuthentication no` → `yes`（备份 `sshd_config.bak-v290`）；ECS 生成 `hk_pull` 免密密钥。

**验证**：`node --check` 0 错误；`test_v290_external`(25) 全绿；全量回归 **50/52**（仅 `test_v212*` 两套 v1.x 遗留失败，已 stash 对照确认非本次回归）；线上只读冒烟 **16/16**；ECS 冷启 RSS ~96MB，首次检索后 ~232MB 并**稳定持平**（10 轮 100 次检索无增长；`--max-old-space-size=150` 压测下 12 次检索全 200）。经二次优化（句子索引极简化，见下），线上检索后 RSS 由初版 457MB 降至 232MB。

---

## 0. ⭐ v2.2.8 学习诊断闭环稳定性收口（已完成）

**主题**：执行 `.opencode/plans/v2.2.8-closure-and-release.md`，修复 v2.2.7 审计发现的六类问题，使学习诊断闭环达到可重复验证、可安全部署状态。分 `.a`–`.g` 七个分版逐项交付并上线，最终版本冻结为 `2.2.8`。

**分版交付链**（均已 push Gitee + 部署 ECS，详见根工作区《版本号经历.md》）：

| 分版 | commit | 主题 |
|---|---|---|
| v2.2.8.a | `a850648` | TODO 1 学习流水并发安全（`updateLearningAttempt`）+ 损坏文件保护（`LEARNING_STORE_CORRUPT`）|
| v2.2.8.b | `8d1cab0` | TODO 2 真实划选 `data-rid`/`sourceRef` + 服务端来源校验收紧 |
| v2.2.8.c | `0e23324` | TODO 3 迁移训练独立信心组 + 同词性干扰项 + token 绑 rid |
| v2.2.8.d | `07a86a0` | TODO 4 单元按 section 严格分支 + batchId + 错因权限 + `sessionDurationMs` |
| v2.2.8.e | `a23ef0b` | TODO 5 周报排除 pending + bySection 分题型 + `pendingRetries` |
| v2.2.8.f | `eb728f9` | TODO 6 测试进程收口（`process.exitCode`）+ 真实 UI 覆盖 |
| v2.2.8.g | `850b093` | TODO 7 四风格口径（8→4）+ 触控统一 ≥44px + `.st-sentence` 2em 缩进 |

**测试命令**（本地 `english-workbench/`，全部退出码 0）：
- 后端 14 套件：`test_v220_storage.js`(18) / `test_v220_regress.js`(5) / `test_v221_quiz.js`(19) / `test_v222_unit.js`(25) / `test_v223_report.js`(13) / `test_v224_vocab.js`(23) / `test_v225_sentence.js`(32) / `test_v226_backup.js`(23) / `test_v220.js`(63) / `test_v228_concurrency.js`(22) / `test_v228_sourceref.js`(23) / `test_v228_vocab.js`(19) / `test_v228_unit.js`(28) / `test_v228_report.js`(20)
- 浏览器 12 套件：`test_v221_playwright.js`(6) / `test_v222_playwright.js`(7) / `test_v223_playwright.js`(9) / `test_v224_playwright.js`(6) / `test_v225_playwright.js`(14) / `test_v226_playwright.js`(39) / `test_v220_ui.js`(36) / `test_v228_sourceref_ui.js`(25) / `test_v228_vocab_ui.js`(14) / `test_v228_unit_ui.js`(16) / `test_v228_report_ui.js`(14) / `test_v228_ui_contract.js`(16)
- 统一入口辅助：`.workbuddy/_test_util.js`（`stopServer`/`cleanupSandbox`）。

**验收硬门槛达成**：26 套件退出码全 0；无残留 `server.js` 子进程；真实 `data/{db,answers,learning_attempts}.json` 哈希不变；并发不丢流水；损坏文件不被覆盖；三类来源真实 sourceRef；迁移真实信心落盘；周报不统计 pending。

**线上事实**：ECS `/opt/workbench` 与 Gitee `850b093` 同步，`workbench.service` active；线上学习流水 `learning_attempts.json` 为空态（85B）；`config.json` 1712B；`db.json` 3,669,749B；线上无 `answers.json`。版本标识 `v2.2.8` 两处一致。

---

## 1. 🎯 核心目标与技术栈

### 核心功能
个人**考研英语一**学习系统「英语学习工作台」。核心闭环：墨墨背单词 Open API 数据同步 → AI 单词教练互动（注入真题/外刊/个人语料证据）→ 助记生成并推回墨墨云词库。周边模块：真题库、语料库（4070 篇自动外刊 + 手工语料，v2.9.0 全自动入库）、单元题库、单词测验、学习诊断周报、长难句三遍训练、番茄钟/禅模式、数据备份、沉浸式划选精读。

### 技术栈与架构决策（已冻结，勿轻易改动）
- **后端**：零依赖 Node.js 原生 `http`，单文件 `english-workbench/server.js`。无 `dependencies`。本地 Node v24，云服务器 Node v22。
- **前端**：原生 JS + CSS 单页多 Tab，无框架、无构建步骤。`english-workbench/public/{index.html,app.js,style.css}`。
- **持久化**：JSON / JSONL 文件。`data/db.json`、`data/chat_sessions.json`、`data/config.json`、`data/kb_versions.json`、`data/learning_attempts.json`（学习流水，`schemaVersion:1`，上限 20,000 条，tmp+rename 原子写）；`data/` 整体 gitignore（含密钥）。
- **启动**：`node server.js`，默认 `PORT=5178`、`HOST=127.0.0.1`；云端 systemd `workbench.service` 绑定 127.0.0.1，前置 Nginx 反代 + Cloudflare HTTPS；**Basic Auth 已于 2026-09-26 移除**，公网唯一登录入口为应用内多用户登录。
- **版本号**：`v2.2.8`（`package.json` + 桌面/移动端页头两处同步）。
- **界面风格**：**4 种**（默认清新 / 复古街机 / 潮流波普 / 方块像素）× 2 昼夜 = 8 套主题。
- **Git 拓扑**：应用仓库 remote `gitee` = `https://gitee.com/lgh-2005/memo-workplace.git`（**主力，唯一发布目标**）；`origin` = GitHub 镜像（不强制推）。根工作区 `D:\ai\opencode\momo` 本身也是 git 仓库（分支 `main`）但**零提交、全部 untracked**，勿把它当发布仓库。

---

## 2. ✅ 历史版本 (Completed)
主题：**真题库第八轮（r8）AI 审读修复 + 练习端 Part B 选项池 A–H 打通**。

> **2026-09-13 线上实操复检（Playwright + 网站 AI 审读）**：逐卷点开 30 套真题执行「AI 审读」，仅 2010 卷报 1 条疑点（完形 Q7 选项 D）。核对发现：**库数据 `(D) so long as` 正确**，但 ECS 的审读「原件参考」`corpus/archive/真题/2010.tex` 为旧版（仍含 `so long so`），LLM 拿正确库数据去比错误原件 → **假疑点，fix 方向是改错**。根因：archive 被 gitignore，`git pull` 不更新，ECS 副本停留在 pre-r8/r10（25/30 卷陈旧，含 `self-condident`/`straitford`/`so long so`）。已从本地（texsrc 同步版，30 卷 md5 一致）重新打包 scp 覆盖 ECS archive（备份 `/root/workbench-archive-zhenti-backup-20260913-085946/`），**未改库数据**。重审 30 卷全部 0 疑点。

#### r8 审读定性（14 条，逐条对照原件）
- **真修复 7 处（`english-corpus/texsrc/`，均已重导入库）**：
  - 2000：`self-condident` → `self-confident`；`two years ago.What` → `two years ago. What`（raw_text/2000.txt 作 `[A] self-confident`、`ago. What`）。
  - 2002：Q39 选项 `{Desperate}` → `{Desperate.}`（raw OCR `[D] Desperate.`，与其余选项句末标点一致）。
  - 2003：Q24 四选项 `straitford` → `Straitford`（专有名词首字母，raw OCR 正文与选项均 `Straitford`）。
- **误报终裁 7 条（保持原文）**：
  - 1998 四条（`Au Bong Pain` / `Gallileo` / `continental plate come` / `stars, plants`）系**原卷自带拼写**——已用 1998 官方 PDF 文本层逐字确认；权威复原稿亦照录，按「以原件为准」保留。
  - 2000 `conditionally speeding`（raw OCR + 中译「有条件地」一致）；2010 Part B `41→42→43→44→E→45`（TeX 源本身如此，Directions 明示仅 E 预置）；2017 `consolidated Dickens' as`（各复原稿均缺 reputation，原卷如此）。

#### 练习端 Part B 缺陷修复
- `public/app.js`：新题型空位下拉不再写死 `ABCDEFG`，改按单元实际选项池生成（2023 A–H 的 H 可选）；录入面板让 Part B 41–45 空可从独立「选项池」条目继承答案键。
- `server.js`：`/api/unit/answers/save` 校验 `^[A-G]$` → `^[A-Z]$`（支持 H）；`/api/unit/answers/submit` 判分排除 `number == null` 的选项池占位条目。

#### 源码层遗留改动（r7 后未提交，随本版一并提交）
- `corpus_tools/tex_parser.py`：`import unicodedata` + 11 类清理。`server.js`：AI 审读送审含 options、定位覆盖「正文+选项」、LIMIT 120000。`app.js`+`style.css`：`allowU()` 放行 `<u>` 划线段。

#### 追加：AI 审读提示词补丁 + r10 修复（09-12 复核，Playwright 实操验收）
- **`server.js` `quality_review` 提示词新增规则 1a/1b**：原件已有写法（含原件自身拼写/语法/专名如 `Au Bong Pain`/`Gallileo`）一律不报；仅「整理结果与原件不符或截断丢词」才算问题。
- **r10 源修复 2 处**：2000 `comprehension.”No doubt` → `comprehension.” No doubt`；1999 `Amazon .com` → `Amazon.com`。已重导校验。
- **验收（每卷重审 3 次报错 ≤ 2 条）**：`.workbuddy/sweep_seq_r214.js` r11/r12/r13 三轮全库 30 卷 **全部 0 issues、无 ERR**；`negctl_review.js` 负控注入漏词仍被捕获。
- **playwright-cli 实操**：真题库 1998/2000/2010「AI 审读」均「✅ 未发现明显疑点」；单元题库 2023 新题型下拉与标准答案下拉均 `ABCDEFGH`。

#### 验证（全绿）
- `node --check public/app.js` / `server.js` 0 错误；全量重导 30 卷；`verify_store_v213.py` 30 卷全 OK，`FAILS: NONE`。
- 落库抽验：`self-confident` / `Desperate.` / 四处 `Straitford` 已在 `exams.jsonl`，旧串 0 命中。
- `.workbuddy/e2e_partb_v214.js`：2023 选项池 A–H、含 H 标准答案可保存、提交判分 5/5。

#### 部署（已完成，2026-09-12 22:03）
- `git push gitee master`：`0a259b5..05435c4`（提交 `05435c4`）。
- ECS 备份 `/root/workbench-pre-v2.1.4-backup-20260912-220217/`（config.json / kb_versions.json / exams.jsonl.online 1005KB / records.jsonl.online 76KB）。
- 流程：`git checkout -- corpus/exams.jsonl`（线上改动已备份）→ `git fetch origin` → `git merge --ff-only origin/master`（`0a259b5..05435c4`）→ `sudo systemctl restart workbench`（active）；**`records.jsonl` 未触碰**。
- 线上验证：`git rev-parse --short HEAD` = `05435c4`；`package.json` / 页头 = `v2.1.4`；`/api/exam/records` 返回 30 卷（1994–2023）；抽查 `self-confident`/`Straitford` 命中、旧串 0 命中；2023 Part B 池键 `A–H`；公网 `http://121.43.177.191/` 页头 v2.1.4（Basic Auth 200）。

### v2.1.3（上一版，已上线 ECS）
主题：**真题库以本地 TeX 源全量重导 + `tex_parser.py` 解析缺陷修复**。用户明确「真题库现有真题全部不要，用本地 TeX 源重新导入，只用 2024 及以前」。

#### 数据结果
- 真题库 `corpus/exams.jsonl` 由旧数据（本地 1 条 PDF / ECS 30 条带缺陷）**全量重导**为本地 TeX 源 30 卷：
  - 覆盖 **1994–2023**（无 2024 TeX 源），共 **1394 题**。
  - 卷题量：1994–2000 各 35 题；2001–2004 各 45 题；2005–2023 各 51 题。
- 唯一导入源：`D:\ai\opencode\momo\english-corpus\texsrc\*.tex`，经 `corpus_tools/import_cli.py tex` 通道。
- 重导前本地旧库已备份（`corpus/exams.jsonl.bak-v213-*`，gitignored）；原件归档 `corpus/archive/真题/*.tex`（gitignored）。

#### `corpus_tools/tex_parser.py` 修复（7 类）
1. **`\newlinespread{X}{...}` 包裹体剥离**：先移除命令保留正文，修正 1995/1998/1999/2000/2009 翻译整段被 catch-all 吞掉。
2. **翻译句变体抽取**：兼容 2020 `(49) \uline{...}` 无 `\transnum` 写法；翻译答案句数上限 5，源缺陷多余句（2023 stray Scovell 段落）连同所在段落剔除。
3. **裸选项兜底**：个别小题漏写 `\fourchoices`（1994 P4、1996 P4、1999 P3）的裸 `{..}×4` 识别；题干开头重复选项词前缀自动去除（1999「far reaching」）。
4. **A./B./C./D. 文本选项识别**：修正 2008 Text1 等纯文本选项（含续行）导致的缺题。
5. **Directions 过滤锚定段落开头**：修正旧年说明段泄漏进正文；同时不再误删句中含 directions 的句子（1994/1998）。
6. **Part B 全面重写**：选项池统一为 `{A..H}` 字典（2023 A–H 8 项，其余 A–G 7 项）；空位 41–45 归一为 `〖N〗` 并补齐逐空题目；兼容 `\linefill` / tabular「41. &」/ `(41)` 段落标记（2022）/ 独立数字行（2023 排序题）；`<<<ENDLIST>>>` 复位采集状态。
7. **旧卷结构映射**：year<2005 阅读「Part B」映射为翻译（part C），修正 2002–2004 翻译误归 part_b。

#### 配套修复
- **`corpus_tools/exam_norm.py`**：`score_items` 对 `number is None` 的选项池条目置 `score=None`，避免重复计分。
- **`.gitignore`**：新增 `__pycache__/`。
- **版本号**：`package.json` → `2.1.3`；`public/index.html` 桌面 + 移动端标识 → `v2.1.3`。

#### 验证与评估（全绿）
- `.workbuddy/gate_v213.py`：按年代期望门禁，30 卷全 OK（含 import_cli 全管线）。
- `.workbuddy/pipeline_v213.py`：30 卷 parse+normalize 干跑无崩、分数正常。
- 经本地 server `/api/exam/import`（每批 10，base64）全量重导；`corpus/exams.jsonl` = 30 records / 1394 题。
- `.workbuddy/verify_store_v213.py`：实际 store 逐卷校验 30 卷全 OK（pids 按年代期望 5/4、pbAnchors、池键、翻译锚、选项数、评分）。
- `.workbuddy/eval_browse_v213.js` + `analyze_eval_v213.js`：**Playwright 逐卷浏览全库**，渲染结构全部正确（完形/阅读/新题型/翻译/写作各段计数符合预期，`hasRawAnchor` 0 泄漏）；截图 `shot_2007.png` / `shot_2020.png`。唯一 console error 为 favicon 404（非阻断）。
- 抽查：1999 #11 dedup、1994 阅读 11–30 齐全、2023 翻译 46–50、2022 Part B、2023 池 A–H、2005 锚 41–45。

#### 部署（已完成）
- 提交 `0a259b5` 已推送 Gitee 主干。
- ECS 部署前备份至 `/root/workbench-pre-v2.1.3-backup-20260911-194630/`（config.json / kb_versions.json / exams.jsonl / records.jsonl）；`corpus/exams.jsonl` 定向丢弃换新，`records.jsonl` 未触碰；ff-only 合并 `923d505..0a259b5` 成功；`workbench.service` active。
- 线上验证：页头 `v2.1.3`；`/api/exam/records` 返回 30 条（1994.tex–2023.tex）；抽查 2005/2020/2023 段计数与池键（2023 = A–H，其余 A–G）全部符合预期。

### v2.1.2（上一版，已上线）
AI 审读修正方案采纳/拒绝写回、记录级最近 5 版历史回溯、沉浸式划选精读（PC 浮动卡片/移动端底部抽屉）。提交 `923d505` 已推 Gitee + ECS ff-only 部署 + 线上验证。

近期提交链（新→旧）：

| 提交 | 版本 | 内容 |
|---|---|---|
| `dc43076` | v2.2.8 | post-audit TODO6：线上静态资源三方哈希（LF 归一）+ Release 完成状态（docs-only）|
| `a41fe08` | v2.2.8 | post-audit TODO1：新增 `TESTING.md` 可审计测试来源（docs-only，产品代码不变）|
| `0705689` | v2.2.8 | TODO8 版本与文档统一冻结（`2.2.8.g` → `2.2.8`）|
| `850b093` | v2.2.8.g | TODO7 统一 UI 契约：四风格文案、触控 ≥44px、`.st-sentence` 2em 缩进 |
| `eb728f9` | v2.2.8.f | TODO6 测试进程收口（`process.exitCode`）+ 真实 UI 覆盖 |
| `a23ef0b` | v2.2.8.e | TODO5 周报排除 pending + 分题型统计 + `pendingRetries` |
| `07a86a0` | v2.2.8.d | TODO4 单元严格 section 分支 + batchId + 错因权限 + `sessionDurationMs` |
| `0e23324` | v2.2.8.c | TODO3 迁移训练独立信心组 + 同词性干扰项 + token 绑 rid |
| `8d1cab0` | v2.2.8.b | TODO2 真实划选 `data-rid`/`sourceRef` + 服务端来源校验收紧 |
| `a850648` | v2.2.8.a | TODO1 学习流水并发安全 + 损坏文件保护 `LEARNING_STORE_CORRUPT` |
| `a7cd90a` | v2.2.7 | v2.2 学习诊断闭环（单词测验/单元/周报/迁移/长难句/备份）|
| `05435c4` | v2.1.4 | 真题库 AI 审读零疑点（3 轮复核）+ 审读提示词原件基线补丁 + Part B 选项池 A–H + `tex_parser` 11 类清理 |
| `0a259b5` | v2.1.3 | 真题库以本地 TeX 源全量重导 30 卷 1394 题 + `tex_parser` 七类解析缺陷修复 |
| `923d505` | v2.1.2 | AI 审读采纳/拒绝写回、记录级最近 5 版历史回溯、沉浸式划选精读 |

---

## 3. ⏳ 正在进行中 / 中断时的状态 (In Progress)

- **v2.2.8 已上线**（Gitee tag `v2.2.8` = `0705689`；HEAD `a41fe08` 仅追加 `TESTING.md`；ECS `/opt/workbench` 产品文件与 tag 逐文件一致，`workbench.service` active）。
- **测试套件**：27 套（14 后端 + 12 浏览器 + 1 线上只读冒烟），全部退出码 0，断言总数 556；来源清单见 `english-workbench/TESTING.md`（已入库）。线上冒烟含**静态资源三方哈希一致性**（线上=tag `v2.2.8`=本地，LF 归一）。
- 线上学习流水 `data/learning_attempts.json` 当前为空态（85B）；`data/answers.json` 线上不存在；`data/db.json` 约 3,669,685B。
- ECS 侧 `corpus/exams.jsonl`、`corpus/records.jsonl` 仍为线上进程可写的 modified 状态（正常，未触碰）；服务器另有若干历史 untracked 文件（`texsrc.tar.gz`、`texsrc_tmp/`、`audit_quality.js`、`batch_import.js` 等），非本次产生，勿清理。
- **Gitee Release `v2.2.8` ✅ 已完成**（id `1143796`，target `0705689`，标题「v2.2.8 学习诊断闭环稳定性收口」）。
- **域名（用户决策：不启用）**：国内备案不便，本项目**不依赖域名**；canonical 入口为 ECS 直连 `http://121.43.177.191`（**应用内多用户登录，2026-09-26 起已去除 nginx Basic Auth**）。`memo.luguhu.online` 子域 NXDOMAIN 属既有基础设施状态，**不作为发布阻断项**。
- **已知非阻塞遗留（有意保留，勿当 bug）**：
  1. `server.js` 的 `GLOSS_SYSTEM` 常量、`kbCorpusForWord()` 已无引用，属死代码。
  2. `app.js` 注释写「`{spacing}` 占位符」，实际默认模板用 `{spelling}`；运行时代码两者兼容。
  3. 旧年真题翻译编号已按原件修正为 1994–2000 → 31–35、2001–2004 → 41–45（经 1998 官方 PDF 与 raw OCR 核验，写入 `tex_parser.py`）。
  4. 2024 真题（仅 `zhen/2024.pdf`，无 TeX 源）本轮未入库。
  5. 1998/2000/2010/2017 的「原卷自带拼写/结构」已终裁为误报；后续 AI 审读若再报同项，直接忽略。

---

## 4. 🚀 紧接着的下一步动作 (Next Immediate Steps)

v2.2.8 修复/收口/校验/**发布**均已完成，剩余计划 TODO 9：

1. **post-audit 计划已基本收口**：TODO 1（`TESTING.md`）、TODO 2（测试补强）、TODO 3（文档统一）、TODO 4（Gitee Release）、TODO 6（静态资源三方哈希）均已完成；TODO 5 因用户决策**不启用域名**而废止。
2. **可选：归档同步**：`corpus/archive/真题/*.tex`（gitignored）未随仓库上云；若 AI 审读需引用重导原件，手动 scp 到 ECS `/opt/workbench/corpus/archive/真题/`。
3. **后续可选（v2.2.9 规划）**：post-audit TODO 7 翻译数据质量补丁（翻译题号集合校验 400、`meta.charCount` 用 `Array.from` 计字符、周报区分「翻译字符数」与「作文词数」），单独 `2.2.9`/`v2.2.9` 交付，不碰 `v2.2.8` tag。
4. **继续产品迭代**：以用户新的明确需求为准。历史缺口备查：翻译/写作专属训练、错词周报、助记编辑导出、采集批次回流自动化、2024 真题（仅 PDF 无 TeX 源）是否入库。

---

## 5. ⚠️ 避坑提醒与隐式上下文 (Caveats & Gotchas)

1. **禁止在 ECS 上执行 `git checkout .` / `git reset --hard`**：`corpus/exams.jsonl`、`corpus/records.jsonl` 是**线上进程可写数据**（服务器端长期 modified），强拉会覆盖线上题库。标准更新流程：先 `tar` 备份 `data/`，再用 `git fetch origin master && git checkout origin/master -- <产品文件> && git merge origin/master --ff-only`，绝不冲掉线上脏数据。
2. **密钥与凭据**：`english-workbench/data/` 已 gitignore（含墨墨 Token、LLM/搜索/词典/MinerU 全部 API Key），**永不入库**。**网站 Basic Auth 已于 2026-09-26 移除**，登录唯一走应用内多用户（管理员 `admin`，密码见 `config.auth.token`）；原 Basic Auth 用户名 `贾忖`/桌面 `password.txt` 凭据仅存档、不再使用。
3. **导入通道契约**：`corpus_tools/import_cli.py` 支持 `tex | pdf | md`；`POST /api/exam/import` 单批 ≤20 文件、单文件 ≤30MB；记录 id 由 `rid(path,'tex')` 生成（**与源路径相关**，换路径会生成新 id）。
4. **真题库前端结构契约**：完形/Part B 正文用 `〖N〗` 锚点；Part B 选项池为 `{A..H}` 字典（`number=null`），另有 41–45 逐空题目；翻译用 `〖N〗…〖/N〗`。改渲染须同时对齐 `public/app.js` 的 `part_b.render` 与 `kbExamPassageAndQuestions`。
5. **三端数据边界**：真题（`corpus/exams.jsonl`，网站可读写）、自动外刊（v2.9.0 起为 `corpus/external/current/articles_index.jsonl` + `articles_body/*.jsonl.gz` 瘦索引格式，`managed=external` **只读**）、手工语料（`records.jsonl`，`managed=manual`）。自动外刊不得混入 `records.jsonl`；旧版整包 `articles.jsonl` 目录仍兼容读取（`/api/kb/status` 的 `external.format` = `v1`/`v2`）。
6. **学习流水契约**：`data/learning_attempts.json` 由 `loadLearningStore()`/`saveLearningStore()` 管理，`schemaVersion:1`，上限 `MAX_LEARNING_ATTEMPTS`(20000)，写前重读、损坏抛 `LEARNING_STORE_CORRUPT` 不覆盖；并发提交须走 `updateLearningAttempt()`。
7. **版本号联动**：`package.json` + `public/index.html` 桌面端与移动端；另需在**根仓库** `版本号经历.md` 追加章节（该文件不在应用仓库内，不会随 `git push gitee` 带走）。
8. **测试脚本不入库**：全部测试位于 `.workbuddy/`（被 `.gitignore` 忽略）；版本来源为本地工作树对应 commit。
9. **测试对环境有副作用**：本机 `data/config.json` 会被「提示词历史」类测试改写，测试前先备份、测试后还原。启动本地多实例务必换 `PORT`。
10. **根仓库（`D:\ai\opencode\momo`）是「资料仓」而非发布仓**：`main` 分支零提交、全部 untracked；只放 `AGENTS.md`、`PROGRESS.md`、`版本号经历.md`、各评估文档与子项目。
11. **云端回滚点**：`data/backups/pre-v2.2.8.{f,g}-*.tar.gz`（本轮）及更早备份。回滚前先备份现网两份 corpus 数据。
12. **自动备份机制**：服务端每 6 小时备份 `db.json/config.json/chat_sessions.json/records.jsonl/exams.jsonl/kb_versions.json` 到 `data/backups/`，保留 10 份。
13. **Playwright 资源路径**：`require(path.join(process.env.APPDATA, 'npm', 'node_modules', '@playwright', 'cli', 'node_modules', 'playwright'))`；本地站点 `http://127.0.0.1:5178`，线上冒烟脚本仍附带 Basic Auth 头但服务器已忽略（2026-09-26 起）。
