# TESTING.md — 测试来源、清单与验收硬门槛

> v3.3.2 增量：`.workbuddy/test_v332_mobile_ui.js` 覆盖 360×800、390×844、700×900、768×1024 四视口，验证移动端安全区、横向子导航、触控目标、操作行换行、弹层滚动、无溢出与控制台无错误（30 断言，全部通过）。
>
> v3.3.3 增量：仓库内 `npm test` 提供可复现入口，隔离沙箱启动服务并验证语法、安全响应头、跨站写请求拒绝与登录接口频控；`.github/workflows/ci.yml` 在 Node 22/24 自动执行。
>
> v3.3.4 增量：`npm test` 增加 CSP 与静态路径穿越断言；`npm run test:release` 检查发布/回滚脚本的运行时排除规则、dry-run 入口与备份版本号；ECS 通过 `deploy.sh --dry-run` 和 `rollback.sh <snapshot> --dry-run` 做无停机演练。
>
> v3.3.5 增量：新增隔离式备份恢复演练、发布门禁、线上只读健康检查、敏感信息扫描、文档一致性检查和移动端回归入口。无 Android 真机时执行 Pixel 7 / iPhone 13 Playwright 模拟；连接真机后可执行 ADB + Chrome DevTools 检查。
>
> v3.3.6 增量：`scripts/study-plan-smoke.mjs` 在双用户隔离沙箱覆盖考试计划保存/非法日期、任务完成同步、听力/口语评分、会话防重放、流水隔离和同源麦克风策略；Playwright 移动模拟覆盖听说页与任务中心的无溢出、44px 触控和手动识别降级。
>
> v3.4.2 增量：覆盖取消请求后的请求体收口、per-user 写队列超时与串行尾部保护、已关闭响应安全短路，以及管理员默认模型服务商切换回归。外刊分片缓存专项 `scripts/external-body-cache-smoke.mjs` 属于 v3.4.1，继续纳入回归。
>
> v3.4.3 增量：移动端 Playwright 回归覆盖服务商新增/编辑弹窗、窄高视口中的独立表单滚动、固定操作栏、关闭交互和焦点返回。

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

## 3. 脚本清单（46 套 · 全部预期退出码 `0`）

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
| 21 | `.workbuddy/test_v220_ui.js` | 37 | 真实作答三类测验 + 迁移真实信心（v3.2.1 起基础信心改智能判断）+ 真实划选 |
| 22 | `.workbuddy/test_v228_sourceref_ui.js` | 28 | 真题/手工语料/单元三通道真实划选 |
| 23 | `.workbuddy/test_v228_vocab_ui.js` | 14 | 迁移独立信心组 UI |
| 24 | `.workbuddy/test_v228_unit_ui.js` | 16 | 单元 section 收集 + batchId |
| 25 | `.workbuddy/test_v228_report_ui.js` | 14 | 分题型统计 + 待重试提示 |
| 26 | `.workbuddy/test_v228_ui_contract.js` | 16 | 四风格口径 + 触控 ≥44px + 缩进 + 无溢出 |

### 3.3 线上只读冒烟（1）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 27 | `.workbuddy/test_v228_online_smoke.js` | 16 | 线上只读 API/页面/版本/无持久化写/静态资源三方哈希；**v2.9.0 起自动登录换取会话 Cookie**（线上 Token 登录启用后只读 API 需鉴权），期望版本与哈希基准默认自动取自本地工作树（`package.json`/`HEAD`），免手填 `ONLINE_VER`/`ONLINE_HASH_REF` |

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

### 3.7 v2.7.2 增量套件（3）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 33 | `.workbuddy/test_v272_bubble_ui.js` | 24 | 移动端划词助手（浏览器，`hasTouch`+`isMobile` 触摸上下文）：长按取词命中整词、气泡结构与左右边界 clamp、自绘高亮框 `.sel-learn-hl`（`pointer-events:none`）、触发端 `user-select:none`（原生划选取不到文本 = 系统菜单根除）、`contextmenu` 正文拦截/输入框放行 + OS 级兜底取词、输入框 `user-select:text` 保留、整句扩展、复制反馈、控制台 0 错误 |
| 34 | `.workbuddy/test_v272c_drag_ui.js` | 16 | 触摸端自由拉伸选区（浏览器，触摸上下文）：长按后出现 `.sel-learn-handle` start/end 端点手柄、拖拽 end 向后扩词、拖拽 start 越界回退、拉成整句判 `sentence`、折行选区 `getClientRects`>1 对应多段高亮、收起时手柄/高亮一并清除、控制台 0 错误 |
| 35 | `.workbuddy/test_v272d_wordlist_scroll.js` | 20 | 词汇精练词表滚动修复（浏览器，触摸上下文 × 4 视口 390×844/844×390/768×1024/1280×800）：`.card-collapse-body` 参与 flex 纵向布局后 `#wordList` 恢复可滚动（`clientHeight < scrollHeight` 且可见高度 > 0）、真实触摸上拖 `scrollTop` 增大、控制台 0 错误。修复前在 >700px 宽视口 6 断言必失败（已反向验证） |

### 3.8 v2.8.0 增量套件（2）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 36 | `.workbuddy/test_v280_auth.js` | 49 | Token 凭证登录 + 日志版块（后端）：未登录受保护 API 返回 401（`UNAUTHORIZED`）、白名单（auth/login·auth/status·error/report）、错误 Token 拒绝且不签发 Cookie、正确 Token 签发 `httpOnly; SameSite=Lax` 会话 Cookie、带会话可访问、报错日志采集/读取/清空、使用日志增删与空内容拒绝、开发日志随版本（version 与 `package.json` 一致且 ≥2.8.0、保留 v2.8.0 历史条目）、登出后会话失效、管理员改 Token 后旧失效新可用、清除 Token 后关闭登录、未启用时全部放行、开启却清空 Token 自锁保护（400 `NO_AUTH_TOKEN`）、真实数据（db/config/answers）哈希不变 |
| 37 | `.workbuddy/test_v280_ui.js` | 22 | 登录与日志版块（浏览器）：未登录显示登录遮罩、错误 Token 提示且遮罩保留、正确 Token 进入并刷新后仍登录、点击版本号进日志版块、开发日志渲染（含 v2.8.0）、使用日志新增与类型标签渲染、报错日志注入与清空、设置页「登录与安全」状态与开关、390px 日志版块无横向溢出、控制台 0 错误且 401 仅来自故意的错误登录 |

### 3.9 v2.9.0 增量套件（1）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 38 | `.workbuddy/test_v290_external.js` | 25 | 外刊全自动入库（release-format v2 瘦索引，后端）：瘦索引目录 `format=v2` 且列表仅含元数据（不带全文）、`preview` 摘要来自索引、详情按需从分片 `articles_body/body-XX.jsonl.gz` 补全文/段落/句子、句子索引 `sentences_index.jsonl.gz` 参与搜索且命中带 `sourceKind=external` 与 publication、无命中返回空、真实 `data/db.json` 哈希不变；同一脚本另起沙箱验证**旧版整包 `articles.jsonl` 目录回退兼容**（`format=v1`、列表/详情/搜索均正常） |

### 3.10 v2.9.1 增量套件（1）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 39 | `.workbuddy/test_v291_markdown.js` | 27 | Markdown 语法升级（单测）：LaTeX 箭头（\rightarrow / \to / \longrightarrow / \Rightarrow / \leftrightarrow 等）转 Unicode、行内公式脱壳（$...$）、常见数学/逻辑符号（\neq / \approx / \le / \ge / \times / \pm / \cdots）、文本型快捷箭头（-> / => / <-> / <=>）在 esc() 后平滑转义、行内高亮 ==重点== 渲染为 <mark class="md-mark">、既有 Markdown 语法与 mdLite 完整渲染结合验证 |

### 3.11 v2.10.0 增量套件（2）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 40 | `.workbuddy/test_v2100_quiz_srs.js` | 46 | 测验记忆引擎（自维护 SRS，后端）：空态、4 档评分写入（good→interval 1、easy→首答 4 天、hard 不晋级、mastery 演化）、again 入册错题本（stage=0/wrongCount/mastery 归零）、连续 4 次 good 掌握移出（`resolved` 且从默认列表消失、resolved=1 可见）、掌握度分布、`dueAt` 拨到过去后到期收集（`srs_due`/`wrongbook` filter）、filter 非法 400、legacy 三档兼容（无 grade 时 engine=legacy 且回写 `db.words`、不触发 again 入册）、`wrongbook/resolve` 与 `remove`（不存在词 404）、游戏化 XP 递增/连胜/dailyGoal 校验、`quiz_srs.json` 损坏时 500 + `QUIZ_SRS_CORRUPT` 且不覆盖原文件、还原后恢复、真实 `data/` 三文件哈希不变 |
| 41 | `.workbuddy/test_v2100_quiz_srs_ui.js` | 21 | 测验记忆引擎 UI（浏览器）：错题复练子模式可见与互斥切换、SRS 概览渲染（追踪词/错题/5 段分布/错题本列表）、掌握度条 4 段、4 档评分按钮集合正确、复练作答真实提交（mode=srs 且每题携 grade 枚举）、结果页 4 档汇总、错题本 resolve 后条目减少、移动端 390px 无溢出 + 评分按钮触控 ≥44px、控制台 0 错误、真实 `data/` 三文件哈希不变 |

### 3.12 v2.11.0 增量套件（2）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 42 | `.workbuddy/test_v2110_quiz_generate.js` | 47 | 自适应组卷 + 交错题型 + 会话韧性（后端）：自适应组卷返回 `sessionId`/items 且落盘 `quiz_session.json`（schemaVersion=1）、到期/错题词强加权排前 2、低掌握度词排名高于高掌握度词、难度档题型约束（easy 仅 flash/choice；hard ≥3 种题型）、客观题 4 选项且 `answer` 在选项内（choice=释义、zh2en=拼写）、同 seed 组卷确定性（拼写顺序与题型序列一致）、会话读取/暂存/续做（idx/answered 持久化、sessionId 不匹配 409）、提交携带 sessionId 时服务端权威复核（错答强制 again 入错题本、提交后清空会话）、`session/clear`、参数校验（非法 source 400、count 钳制 3..50）、`quiz_session.json` 损坏保护（500 + `QUIZ_SESSION_CORRUPT` 且不覆盖、还原后恢复）、真实 `data/` 四文件哈希不变 |
| 43 | `.workbuddy/test_v2110_quiz_generate_ui.js` | 24 | 自适应组卷 UI（浏览器）：配置区存在（难度档 3 / 题型开关 5 / 智能组卷与固定题型双按钮）、难度档联动题型开关（hard→5 类、normal→3 类）、智能组卷开测与题型标签渲染、走完全程（提交携带 sessionId 且结果含 ≥2 种题型、结果页显示题型分布）、会话韧性（刷新后显示续做横幅 2/6、恢复后从第 3 题继续、放弃后横幅消失且服务端会话清空）、移动端 390px 无溢出 + 退出按钮触控 ≥44px、控制台 0 错误、真实 `data/` 四文件哈希不变 |

### 3.13 v2.12.0 增量套件（3）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 44 | `.workbuddy/test_v2120_ai_enhance.js` | 44 | 测验 AI 增强 5 处（后端）：①智能干扰项（3 个、不含正确释义、互不相同、标来源、缺 spelling 400）、②错题讲解（返回含规定小节、缺 spelling 400）、③一键助记（入库 db.notes、source=AI、缺 spelling 400）、④拼写容错判分（correct/typo/wrong/空答案）、⑤真实例句（命中 corpus 通道、含词、带来源、无命中空数组、缺 spelling 400）；组卷 `aiDistractors` 开关（默认 0、开启 ≥1、保留正确答案、仍 4 选项、同 seed answer 可复现）；LLM 不可用时优雅降级（拼写 fallback、讲解 ok:false、助记兜底入库、干扰项本地池、组卷 aiEnhanced=0）；真实 `data/` 三文件哈希不变 |
| 45 | `.workbuddy/test_v2120_stats.js` | 35 | 统计看板聚合（后端）：默认窗口 14、掌握度分布 0..4、到期计数、正确率趋势按北京自然日分桶（今日 2/3、昨日 1/2、单题日 100%）、非 word_quiz 排除、错题构成（在册/resolved/错次分档/阶段分布）、连续学习天数、分题型正确率（choice 50%/spell 100%/flash 67%、按题量降序）、窗口参数（7/30 生效、非法回退 14）、游戏化摘要透传、SRS 损坏 500 + `QUIZ_SRS_CORRUPT` 不覆盖、还原恢复、真实 `data/` 三文件哈希不变 |
| 46 | `.workbuddy/test_v2120_ai_stats_ui.js` | 28 | 测验 AI 增强 + 统计看板 UI（浏览器）：统计看板子模式切换与渲染（≥4 卡片、掌握度 5 段、趋势柱=窗口天数）、窗口切换（30 天→30 柱）、AI 增强干扰项开关绑定状态、结果页 AI 复盘（答错出现复盘区、讲解/例句/助记三按钮生效）、错题本 AI 操作（富条目 + 讲解/助记/例句按钮 + 内联讲解）、移动端 390px 看板无溢出 + 刷新按钮触控 ≥44px、控制台 0 错误、真实 `data/` 四文件哈希不变 |

### 3.14 v3.0.0 增量套件（1）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 47 | `.workbuddy/test_v300_multiuser.js` | 52 | 多用户 P0 基础设施（后端）：单用户模式零破坏（`multiUser` 缺省、未启用登录全放行）、一次性迁移（建 admin + 备份 + per-user 目录落盘 + 旧顶层文件移走 + 哈希非明文 + 重复迁移被拒 + 迁后强制登录）、用户名+密码登录（错误密码 401、签发 `wb_session`）、一次性邀请码注册（错误码 `BAD_INVITE`、短密码 `BAD_PASSWORD`、注册即登录、邀请码不可复用、重名 `USERNAME_TAKEN`）、双用户配置隔离（各自墨墨 Token 落 `users/<id>/config.json` 互不串味）、普通用户禁改全局配置（403 `FORBIDDEN`）与禁看用户/邀请码、双用户学习数据隔离（`learning_attempts.json` 分落且只见自己）、管理员用户列表（不含哈希）/禁删 admin/删用户、登出后旧 Cookie 失效、**重启后 Cookie 仍有效（`sessions.json` 持久化）**；全程在 tmp 沙箱，真实数据哈希不变 |

### 3.15 v3.1.0 增量套件（1）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 48 | `.workbuddy/test_v310_multiuser_ui.js` | 28 | 多用户账户体系前端（浏览器）：多用户未登录遮罩含「登录/注册」双标签（Token 输入隐藏）、错误邀请码提示、邀请码注册即进入并签发 httpOnly Cookie、普通用户登录后隐藏全部管理员专属设置区（`data-admin-only`）与「登录与安全」区且显示「我的账户」（用户名/角色）、前端 `isAdminUser()` 判定、登出后遮罩复现 + 作文草稿/番茄钟进度清理 + 设备偏好（主题）保留、管理员登录显示管理员设置区、390px 遮罩无横向溢出 + 登录按钮触控 ≥44px、控制台 0 错误（401 仅来自故意的错误注册/登录） |

### 3.16 v3.2.0 增量套件（2）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 49 | `.workbuddy/test_v320_multiuser_p3.js` | 56 | 多用户 P2 数据分区 + P3 集成改造（后端）：源码契约（`requireAdmin` 与 7 个共享内容写接口守卫、`llm_usage.json` 纳入 `USER_DATA_FILES` 与迁移清单、`mmLimiter`/`notepadCaches`/`autoTimers` 均为 per-user Map）；P2 共享内容写操作普通用户 403 `FORBIDDEN`（kb/import、exam/import、kb/record/update·delete、kb/version/restore、unit/answers/save、mineru/parse）且管理员放行；P3 LLM 用量统计（mock 也记）落 `users/<id>/llm_usage.json`、`/api/llm/usage` 普通用户看自己 / 管理员 `scope=all` 看全员 / 越权 403、顶层无 `llm_usage.json`；备份含 per-user `llm_usage.json`；自动同步 per-user 装配（bob 开启后重启仅 bob 装配、admin 未开无记录、各自 config 独立保存 Token、全局 config 不含用户级 Token）；频控/云词本 per-user 键断言 |
| 50 | `.workbuddy/test_v320_usage_ui.js` | 10 | AI 用量看板前端（浏览器）：普通用户「📊 AI 用量」区可见 + KPI（调用次数/总 Tokens）+ 14 天柱状趋势、无「全员用量」表；切换 30 天柱状变 30 条；管理员登录见「全员用量」表（含 admin 与 bob 行）；390px 用量卡片无横向溢出；控制台 0 错误 |

### 3.17 v3.2.1 增量套件（1）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 51 | `.workbuddy/test_v321_quiz_ux.js` | 30 | 测验体验四项升级（后端 + 浏览器）：②题量解锁（count=1 成功且仅 1 题、count=999 返回池内全部词无 50 上限、count=0/-5 钳到 1）；④词源计数 GET `/api/quiz/sources`（today/sticky/forget/vague/all/srs_due/wrongbook 去重计数、`srsFilters` all/wrongbook/srs_due 并集计数）；③置信/播报/计数前端（基础手动信心组已移除、自动播报开关存在且默认开启、题量框 min=1 无 max、词源 chip 显示「· N」、复练范围 chip 显示计数、提交信心为合法枚举且 easy→sure 自洽、`loadQuizSourceCounts` 静默不抛错）；真实 `data/` 四文件哈希不变 |

### 3.18 v3.3.0 增量套件（1）

| # | 脚本 | 断言数 | 覆盖 |
|---|---|---|---|
| 52 | `.workbuddy/test_v330_pwa.js` | 31 | PWA 可安装（后端 + 浏览器）：manifest MIME（`application/manifest+json`）与契约（name/short_name/display=standalone/scope/theme_color/图标 any 192·512 + maskable 192·512）、sw.js 含 install/activate/fetch 且 `/api` 直连、图标族（icon/maskable/apple-touch/favicon.ico/svg）均 200；浏览器侧 HTML manifest link + theme-color + apple-touch-icon + apple-mobile-web-app-capable、manifest 可解析、图标可加载非空、Service Worker 注册就绪并接管页面、**离线仍可打开应用外壳（导航 200）**、设置页「安装到桌面」区渲染、`?tab=quiz` 快捷方式直达、控制台 0 错误、真实 `data/` 三文件哈希不变 |

> 合计 **52** 套（第 3 节核心验收清单，含 1 套线上只读冒烟），断言总数 **1290+**；本次全量回归实测 **本地 60 套件（含新增 1 套）退出码 0**（另有 4 个 v1.x 历史遗留调试脚本不在验收范围）。共用收口工具 `.workbuddy/_test_util.js`（`stopServer`/`cleanupSandbox`），所有脚本以 `process.exitCode` 退出。

> **说明**：`english-workbench/.workbuddy/` 目录下共 58 个 `test_*.js`。其中 4 个（`test_hl.js`、`test_v117d.js`、`test_v117ef.js`、`test_v117*` 等）及 `test_v212.js`/`test_v212_ui.js` 为 v1.x 历史遗留调试脚本，不属于验收范围（`test_v212*` 依赖 v2.6.2 已删除的 AI 审读，为既有失败）；其余为 v2.2.8 基础 27 套 + 后续版本增量（v2.3.x–v2.5.0 功能套件、v2.6.3 答案回填、v2.7.0 分轨、v2.7.1 六级、v2.7.2 划词气泡/拖拽拉伸/词表滚动、v2.8.0 登录与日志版块、v2.9.x 外刊与 Markdown、v2.10.0 记忆引擎、v2.11.0 自适应组卷、v2.12.0 AI 增强与统计看板、v3.0.0 多用户 P0、v3.1.0 多用户 P1、v3.2.0 P2/P3、v3.2.1 测验体验四项升级、v3.3.0 PWA 可安装）。

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
node .workbuddy/test_v280_auth.js
node .workbuddy/test_v300_multiuser.js
node .workbuddy/test_v310_multiuser_ui.js
node .workbuddy/test_v320_multiuser_p3.js
node .workbuddy/test_v320_usage_ui.js
node .workbuddy/test_v2100_quiz_srs.js
node .workbuddy/test_v2100_quiz_srs_ui.js
node .workbuddy/test_v321_quiz_ux.js
node .workbuddy/test_v330_pwa.js
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
node .workbuddy/test_v280_ui.js
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
- ✅ 37 套件全部退出码 `0`（v2.8.0 基线口径：17 后端 + 20 浏览器 + 1 线上冒烟），无残留 `server.js` 子进程，真实 `data/` 三文件哈希不变。
- ✅ 线上只读冒烟通过（canonical 入口 = ECS 直连），含**静态资源三方哈希一致性**：`index.html`/`app.js`/`style.css` 的「线上服务 = tag `v2.2.8` = 本地工作树」SHA-256 按 LF 归一后**完全相等**。
- ✅ tag `v2.2.8` 已推送 Gitee（附注 tag，peeled `0705689`）。
- ✅ **Gitee Release `v2.2.8` 已创建**（标题「v2.2.8 学习诊断闭环稳定性收口」，target `0705689`）。
- ℹ️ 线上学习流水 `data/learning_attempts.json` 为空态；线上无 `data/answers.json`。
- ℹ️ 域名按用户决策**不启用**（国内备案不便，canonical 入口为 ECS 直连 IP）。
