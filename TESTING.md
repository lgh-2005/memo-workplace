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
| 27 | `.workbuddy/test_v228_online_smoke.js` | 16 | 线上只读 API/页面/版本/无持久化写/静态资源三方哈希 |

### 3.4 v2.6.3 增量套件（1）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 28 | `.workbuddy/test_v263_answers_verify.js` | 7 | 真题库答案回填 E2E：单元总数 243/有答案 165、全部客观题单元已录标准答案、answerState.has、错答案判 0 正确且回传正确答案、2010 真题 45 题答案齐备 |

### 3.5 v2.7.0 增量套件（2）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 29 | `.workbuddy/test_v270_track.js` | 22 | 真题库「考试大类」分轨（后端）：分轨统计与缺省归类、track 过滤、题型标签前缀随大类、单元库分轨与 trackLabel、详情回传 track、导入接口按 track 落盘 |
| 30 | `.workbuddy/test_v270_track_ui.js` | 17 | 真题库/单元题库 track 切换交互（浏览器）：chip 计数、切轨仅显本轨卷、track 徽标、标题随轨、390px 无溢出、控制台 0 错误 |

### 3.6 v2.7.1 增量套件（2）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 31 | `.workbuddy/test_v271_cet6.js` | 33 | 六级真题整卷入库（后端）：听力/选词/长篇匹配板块识别与「六级-」标签、单元切片 gkey（listening~pid / banked_cloze~0 / long_match~0）、长篇匹配 scored=true（无选项客观题）、标准答案命中与客观题提交判分、真实 exams.jsonl 76 套六级 + 28 套考研数据核验（客观题答案 100% 覆盖） |
| 32 | `.workbuddy/test_v271_cet6_ui.js` | 22 | 六级整卷与单元题库渲染（浏览器）：六大板块渲染、听力按段占位、选词内联 10 空 + 15 词池、匹配 10 下拉、答题卡按轨道动态生成（含听力/选词/匹配、写作气泡 57）、六级筛选项、390px 无溢出、控制台 0 错误 |

### 3.7 v2.7.2 增量套件（1）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 33 | `.workbuddy/test_v272_bubble_ui.js` | 18 | 移动端划词助手（浏览器，`hasTouch`+`isMobile` 触摸上下文）：长按取词命中整词、气泡结构与左右边界 clamp、触发端 `user-select:none`（原生划选取不到文本 = 系统菜单根除）、`contextmenu` 正文拦截/输入框放行、输入框 `user-select:text` 保留、整句扩展、复制反馈、控制台 0 错误 |

> 合计 **33** 套、断言总数 **676**（16 后端 398 + 17 浏览器 262 + 1 线上冒烟 16）。共用收口工具 `.workbuddy/_test_util.js`（`stopServer`/`cleanupSandbox`），所有脚本以 `process.exitCode` 退出。

> **说明**：`english-workbench/.workbuddy/` 目录下共 47 个 `test_*.js`。其中 6 个（`test_hl.js`、`test_v117d.js`、`test_v117ef.js`、`test_v212.js`、`test_v212_ui.js`、`test_v117*` 等）为 v1.x 历史遗留调试脚本，不属于验收范围；其余为 v2.2.8 基础 27 套 + 后续版本增量（v2.3.x–v2.5.0 功能套件、v2.6.3 答案回填、v2.7.0 分轨、v2.7.1 六级、v2.7.2 划词气泡）。上表 33 套为与「16 后端 + 17 浏览器 + 1 线上冒烟」基线口径对齐的核心验收清单。

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
node .workbuddy/test_v263_answers_verify.js
node .workbuddy/test_v270_track.js
node .workbuddy/test_v271_cet6.js
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
node .workbuddy/test_v270_track_ui.js
node .workbuddy/test_v271_cet6_ui.js
```

线上只读冒烟（需本机 `Desktop/password.txt`；Basic Auth 用户 `贾忖`）：

```text
# canonical 入口为 ECS 直连（国内备案不便，本项目不依赖域名）
node .workbuddy/test_v228_online_smoke.js
# 严格模式：configured 入口不可达即失败，禁止回退
ONLINE_REQUIRE_ORIGIN=1 node .workbuddy/test_v228_online_smoke.js
# 静态资源三方哈希比对基准 ref（默认 v2.2.8）
ONLINE_HASH_REF=v2.2.8 node .workbuddy/test_v228_online_smoke.js
```

> 静态资源哈希比对统一按 **LF 归一**（`CRLF→LF` 后再算 SHA-256），以消除 Windows 工作树（`core.autocrlf=true`）与仓库 blob / 服务器之间的行尾差异。

## 5.5 v2.4.4 专项增量（2026-09-19）

v2.2.8 以来的后续版本持续扩充 `.workbuddy/` 套件（`test_v233_selection.js` / `test_v234_llmops.js` / `test_v234_ui.js` / `test_v235_thinkstrip.js` / `test_v236_story.js` / `test_v236_story_ui.js`），并新增 **v2.4.4 底座专项**：

| 脚本 | 断言数 | 覆盖 |
|---|---|---|
| `.workbuddy/test_v244_thinkslider.js` | 24 | 思考强度滑块后端语义（off 未配置/显式 off → `reasoning_effort:none + enable_thinking:false` 双保险；minimal/xhigh/max 直通且无关闭注入；非法档位白名单回落；词文成章 analyze 不再注入 `_noThinking`（thinking=high 原样透传、response_format 保留）；Max Tokens 500000 无封顶；负数回落 1；6 预设零内置 max_tokens） |

> v2.4.4 全量回归：**38 套件（含 6 个历史调试脚本）全部退出码 0**。`test_v234_ui.js` 三处断言随滑块语义最小修补（SELECT→range 刻度 0=off、medium 档回填校验刻度 3 + badge dataset.level、meta 徽章中文化「中」）。

## 5.6 v2.5.0 写作升格专项（2026-09-19）

| 脚本 | 断言数 | 覆盖 |
|---|---|---|
| `.workbuddy/test_v250_writing.js` | 26 | inspect 校验线（缺题干/超大图 400）+ 三段式锚点输出 + 带图审题（vision 直通 + image_url 内容块 + 纠偏注入）；elevate SSE 分块事件（>3）+ 五锚点全齐 + `:::sentence` 块 + **思考体拆块打穿拦截**（进 thinking 事件不污染正文，跨 4 块的 `اقة…-in></think` 也拦住）+ done 携带 id/score + 详情回读（essay/prompt/imageHint/report/words）+ 删除 404；非流式上游 fallback；历史列表/金句入库（noteType+source）/data/essays.json 落盘/空正文 400 |
| `.workbuddy/test_v250_writing_ui.js` | 21 | 子版块导航与 pane 互斥 + 审题结果 markdown 渲染 + 确认行出现 + 提交后 SSE 流式（真实 fetch 收流）→ 评分卡 13/20 + L1/L2 对比卡 + 范文卡 + PATTERNS 金句 2 条 ⭐ 存入助记库（db.notes 校验）+ 历史出现与回看再渲染 + 1440 无溢出 + 390 触控 ≥44px + 控制台 0 错误 |

> v2.5.0 全量回归：**40 套件全部退出码 0**。工程要点：elevate 的 `sseSend` 不得再带 finished 闸（finishUp 先置位再发 done——曾出现 done 自拦截 bug，v2.5.0.a 修正）。



## 5. 线上冒烟入口与写接口红线

- **canonical 入口**：`http://121.43.177.191`（ECS 直连，Basic Auth）。
  - 本工作台为个人自用，国内备案不便，**不绑定域名**；`memo.luguhu.online` 不作为发布依赖。
  - 可通过 `ONLINE_BASE` 覆盖入口；默认值与回退值均为 ECS 直连。
- **只允许**：`GET /`、`GET /api/status`、`GET /api/learning/report?days=7`、`GET /api/unit/records` 及页面只读渲染。
- **严禁**：`/api/sync`、`/api/unit/answers`（保存/提交）、`/api/quiz/submit`、`/api/learning/vocab/submit`、`/api/learning/sentence/submit`、`/api/mnote`、`/api/backup`、`/api/restore`、`/api/exam/import`、`/api/kb/import` 等一切持久化写接口。冒烟脚本内置路由拦截断言。

## 6. 当前发布状态（截至本文件提交）

- ✅ 本地 / Gitee `master` / tag `v2.2.8` / ECS `/opt/workbench`：产品文件与 tag `v2.2.8`（`0705689`）逐文件一致；`workbench.service` `active`。
- ✅ 27 套件全部退出码 `0`，无残留 `server.js` 子进程，真实 `data/` 三文件哈希不变。
- ✅ 线上只读冒烟通过（canonical 入口 = ECS 直连），含**静态资源三方哈希一致性**：`index.html`/`app.js`/`style.css` 的「线上服务 = tag `v2.2.8` = 本地工作树」SHA-256 按 LF 归一后**完全相等**。
- ✅ tag `v2.2.8` 已推送 Gitee（附注 tag，peeled `0705689`）。
- ✅ **Gitee Release `v2.2.8` 已创建**（标题「v2.2.8 学习诊断闭环稳定性收口」，target `0705689`）。
- ℹ️ 线上学习流水 `data/learning_attempts.json` 为空态；线上无 `data/answers.json`。
- ℹ️ 域名按用户决策**不启用**（国内备案不便，canonical 入口为 ECS 直连 IP）。
