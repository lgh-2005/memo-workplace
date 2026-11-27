# v4.0.0 安全审计与敏感信息扫描记录

> v4.4.0（2026-11-27）：首页词卡随已鉴权的 `/api/dashboard` 返回，沿用每用户隔离与 API `no-store`；只读取本地缓存与 ECDICT，不调用模型。WebP、独立 CSS 为同源静态资源，无 CSP 调整。

> v4.3.1（2026-11-26）：删除 `POST /api/speaking/session` 与 `POST /api/speaking/submit`（两条路由现返回 404），`Permissions-Policy` 由 `camera=(self), microphone=(self), geolocation=()` 收敛为 `camera=(self), geolocation=()`——麦克风权限不再声明，拍照识别所需 `camera` 保留。侧边栏折叠只涉及前端 `class` + `localStorage`，**零内联 `on*`**，CSP 仍 `script-src 'self'`、无 `unsafe-inline`。新增的一次性清理脚本只读写 `data/` 下的 JSON，写前备份、原子写，不引入网络面。

> v4.3.0：`/api/tutor/map` 增 `lesson` / `lesson_turn`，沿用同站鉴权和 64 KiB 请求体限制。回合按用户隔离、空闲 30 分钟过期，修订号和在途锁避免重复判分。模型引用语料须使用候选 ID；验证前不发送译文、参考答案或出处链接。

> v4.2.0 导图接口沿用登录、同站校验、64 KiB 请求体保护及 30 分钟用户隔离回合。大批量词由浏览器分批。模型仅可引用本组词编号和已有语料候选 ID；组题的原文、出处和空缺词由服务端提供，交卷前不返回未遮盖的原句或答案，也不会把未作复测的文章作为延伸链接。

本地预览「v4.2.0」词表悬浮球 + 词群联动（2026-11-24）：**没有新增接口，只扩展 `POST /api/tutor/drill` 的入参**，仍在同一登录闸门、同站 Origin/Referer 校验与 per-user 写串行队列内。输入收敛新增 `normalizeDrillWords`：`words` 数组逐个 trim + 限长 64 + 去重（大小写不敏感）+ 最多 5 个，非数组时回退旧的 `word` 单值，空数组/全空串直接 400——即**客户端不能靠塞一整个词表把一次请求放大**。模型输出侧新增 `normalizeDrillFocus`：`focus` 只保留逐字命中本组词表的值（最多 3 个），**组外词一律丢弃**，防止把易错统计记到无关词上。前端新增的悬浮球与浮层**零内联 `on*`**，全部走 `addEventListener` + 事件委托，CSP 仍 `script-src 'self'`、无 `unsafe-inline`；浮层用 `aria-hidden` / `aria-expanded` 标状态，关闭态 `pointer-events:none` 不可误触。

本地带练预览（2026-11-24）：**新增 1 条写接口**（`POST /api/tutor/drill`），与既有 `/api/*` 同处登录闸门内、同样走 Origin/Referer 同站校验与 per-user 写串行队列；**不放宽任何安全策略**（CSP 仍 `script-src 'self'`，新增答题卡零内联 `on*`，全部走 `#chatMessages` 事件委托）。输入侧做了白名单收敛：`word` ≤64 字符、`stage` 收敛到 0–2、`answer` ≤400 字符、回传的 `task` 经 `normalizeDrillTask` 逐字段校验（类型白名单、题干 ≤600、选项 ≤5 条各 ≤200、选择题少于 2 个选项直接 400），模型输出侧同样二次归一化，**不把上游半截结构透传给前端**。该接口不读文件、不写磁盘、不拼 SQL，仅在内存里读词表与助记笔记，无新增注入面；错误信息只回 `reason` 短码（`no_llm` / `bad_json` / `bad_task` / `llm_error`），不暴露上游响应体。

v4.0.0 定位收缩（2026-11-24）：**删除 8 条路由**（`/api/writing/*` 五条、`/api/unit/*` 三条），**新增 2 条只读接口**（`GET /api/kb/exams`、`GET /api/kb/exam/<id>`，与既有 `/api/kb/*` 同处登录闸门内），**不放宽任何安全策略**（CSP 仍 `script-src 'self'`，无 `unsafe-inline`；写请求仍走 Origin/Referer 同站校验与 per-user 串行队列）。

v3.8.2 静态资源条件请求 + 复制入口 HTTP 降级：**不新增接口、不新增鉴权面、不放宽任何安全策略**。

- **静态资源改条件请求**（`server.js` 新增 `staticFileMeta` / `serveStaticFile`）：`Cache-Control` 由 `no-store` 改为 `no-cache`（**允许存储但强制回源校验**，不是长缓存），新增 `ETag`、`Last-Modified`、`Vary: Accept-Encoding`、`Content-Length`，并支持 `If-None-Match` / `If-Modified-Since` 的 304 与 `HEAD`。
  - **为什么 `no-cache` 不放宽安全面**：响应仍每次回源校验，客户端无法在未验证的情况下复用旧响应；`no-store` 与 `no-cache` 的差别只在于「是否允许把已验证的响应存到本地」，安全性上等价，而 304 能省掉重复传输。
  - **未采用 `max-age` 长缓存**：本项目静态文件名不带内容指纹、版本号靠 `index.html` 内联文本承载，长缓存会让发版后用户停留在旧版（也会让安全修复无法及时送达），故明确排除。
  - **路径穿越防护未改动**：`isWithinDir` 校验仍在进入 `serveStaticFile` 之前执行，且 `serveStaticFile` 只接收已校验的绝对路径，不再自行拼接用户输入。
  - **`Vary: Accept-Encoding` 是正确性要求而非可选优化**：若反代同时存在 gzip/identity 两版响应而响应缺 `Vary`，客户端可能拿到压缩体却按 identity 解码（表现为乱码）。
- **`/api/*` 保持 `no-store` 不变**：`sendJSON` 未改动，前端改完立刻可见这一既有约定（经验总结坑 #3）继续成立；`scripts/static-cache-smoke.mjs` 内含断言锁死此行为，防止「顺手把 API 也改成可缓存」。
- **复制入口 `copyText`（`public/app.js`）**：先试异步 Clipboard API，失败退 `document.execCommand('copy')`。降级路径全程使用**本地临时 DOM 节点**且复制后立即移除，不写入 `localStorage`、不发网络请求；替换选区前保存并在结束后恢复用户原有 `Range`，不改变页面内容。**不涉及任何凭证、Cookie 或会话数据**。
- **错误提示变化**：复制失败提示由「复制失败」改为「复制失败，请长按选中文本手动复制」，避免用户误判为功能损坏而反复点击（不会产生额外请求或写入）。
- **助记图缓存**：`/images/*` 由无缓存头改为 `private, max-age=3600`（`private` 表示仅浏览器可缓存、不允许共享代理缓存），避免多用户环境下图片被中间层跨用户复用。

## v3.8.1 安全审计与敏感信息扫描记录（历史）

v3.8.1 词汇精练请求数收敛（三个修复 + 一处释义来源改造）：**不新增接口、不新增鉴权面、不放宽任何安全策略**，四项改动全部在既有接口内部。

- **前端请求体去重**（`public/app.js` `askAI`）：改为在写入本地历史之前取样 `history`。仅改变发给服务端的 `messages` 组成，**不改变接口契约**（仍为 `POST /api/chat`，仍只接受已登录会话）。附带效果是**减少**每次请求携带的内容（原先每回合多带一份完整用户消息），对上下文预算与潜在提示词注入面都是净减少。
- **输入法 Enter 保护**（`public/app.js` 输入框 keydown）：新增 `e.isComposing` 与 `e.keyCode === 229` 双重判定，并补 `e.preventDefault()` 避免确认候选时触发浏览器默认行为。纯客户端行为修正，无安全面变化。
- **请求在途锁**（`chatInFlight`）：同一页面同时只允许一个 `/api/chat` 在飞，成功与失败都在 `finally` 释放（**不会**因一次异常把会话永久锁死）。这是**收紧**而非放宽：此前同一会话可并发多次上游调用。
- **词表释义改走离线 ECDICT**（`server.js` `ensureGlosses`）：`/api/gloss` 的入参/出参契约不变（`{spellings:[…]}` → `{glosses:{…}}`，仍 `slice(0,60)` 上限）。新增 SQL 全部为 `db.prepare()` **参数化等值查询**，无字符串拼接、无客户端可控的表名/列名，且一律走既有唯一索引 `idx_word` 与 `idx_sw`。**刻意不使用 `COLLATE NOCASE`**——实测该写法会让 SQLite 退化为 77 万行全表扫描（`EXPLAIN QUERY PLAN` 可复现），既是性能问题也可被用作放大攻击面；改为「小写精确 → 去符号 sw 索引 → 规则还原 → lemma 变形表」的索引友好链路。
- **音标归一化的安全性**：`ecdictNormalizePhonetic` 只做**定长字符映射 + 正则替换 + `slice` 截断**，不执行动态代码、不拼接 SQL、不写文件系统；输出上限 60 字符（已包裹斜杠则 64），词库脏数据不会直接透传进 DOM（前端仍经 `esc()` / `mdInline` 渲染）。
- **降级纪律**：`ECDICT_HOME` 未安装或词库损坏时 `ecdictGlossFor` 返回 `null`，`ensureGlosses` 整段回退到 v3.8.0 的 LLM 路径，**不抛错、不阻断学习流程**；回归套件对两条路径都有断言。
- **敏感信息**：本次改动不新增任何密钥、Token、外部端点或配置文件；`data/`、`runtime/` 的既有排除口径不变。`security-audit.mjs --check` 通过。

v3.8.0 真题参考解析：新增的三个接口（`GET /api/exam/analysis/<examId>`、`/api/exam/analysis/unit/<id>`、`/api/exam/analysis/status`）均为**只读**，且与既有 `/api/*` 处于同一登录闸门内，不新增鉴权面。解析数据来自仓库内静态文件（`corpus/exam_analysis/`），**不接受任何客户端写入**；读取时按 `unitId` 白名单（目录索引内已存在的文件名）取用，不拼接任意路径，无路径穿越风险；`status` 接口只返回相对目录名与计数，**不暴露绝对文件系统路径**。响应体上限由单文件大小自然约束（单单元约 5~20KB），索引缓存按目录 mtime 失效、单文件 LRU 上限 120。

v3.8.0 同时修复一处**安全策略与产品实现冲突**导致的功能性缺陷：`script-src 'self'` 下浏览器拦截全部内联 `on*` 事件处理器，真题页原有 17 处内联处理器使「全真演练」交互实际失效。修复方式为**改结构而非放宽策略**——改为 `data-*` 标记 + `document` 级事件委托，CSP 仍为 `script-src 'self'`，**未引入 `unsafe-inline`**，并加回归断言锁死内联处理器数量为 0。

> v3.7.1 增量（仅运行时可用性，不改鉴权面）：服务端 Piper 解释器路径由硬编码 `venv/bin/python` 改为候选列表探测（`venv/bin/python` → `venv/bin/python3` → `venv/Scripts/python.exe`），在 Windows 与 ECS 上共用同一逻辑。`runtime/piper` 属部署产物目录（不进 git、不参与 `data/` 备份、发布/回滚 rsync 显式排除），语音接口沿用既有登录闸门与 500 字符文本上限，不新增出站请求（有道真人音为既有链路）。

v3.7.0 划词助手接入离线英汉词典（ECDICT，MIT）：词库是**只读共享资源**，落在部署产物目录 `runtime/ecdict/`（不进 git、不参与 `data/` 备份与恢复演练，发布/回滚 rsync 显式排除），`server.js` 以 `node:sqlite` 只读连接查询，不新增任何出站请求、不写用户数据、不扩大鉴权面。新增 `GET /api/dict/ecdict`、`/api/dict/ecdict/suggest`、`/api/dict/ecdict/status` 三接口均在同一登录闸门内；查询词长度截断 64 字符，前缀联想 limit 上限 20。词库缺失时返回 503 并优雅降级（前端隐藏释义行，不影响划词其他功能）。与韦氏 `/api/dict/lookup`（需 Key、有出站请求）相互独立，本地词库不替代也不绕过该链路。

v3.6.0 新增外刊刊物数据轨与按考试圈定语料范围：均为**只读检索过滤**（`PUBLICATION_TRACKS` 注册表 + `GET /api/kb/status` 暴露刊物清单 + 考试计划 `corpusTracks` 字段），不新增鉴权面、不写入外部数据；考试计划仍坚持「损坏拒绝覆盖」`STUDY_PLAN_CORRUPT` 契约。中国日报轨数据走既有只读外刊发布源（`managed:external`）。

v3.5.3 将服务端语音运行时（Piper venv + 模型 + 合成缓存）从 `data/` 移到 `runtime/`：它是部署产物，不进 git、不参与 `data/` 备份与恢复演练（避免 venv 符号链接破坏备份校验），发布/回滚脚本显式排除 `runtime/`。不改变鉴权、凭据存储或数据写入权限。延续 v3.5.2 的今日词表快照清理（同步以本次墨墨快照为唯一真源，仅作用于当前用户自己的 `db.json`）与 v3.5.1 的严格「今日」忘记/模糊筛选（只读筛选口径）。

v3.5.0 升级发音朗读：单词改走服务端代理有道真人发音（按内容哈希缓存），句子新增服务端 Piper 神经语音常驻工作进程。两者皆为只读合成音频，不写用户数据；同源 `/api/tts` 已在登录闸门内。CSP 补齐 `media-src` 以允许真人音源。上游仅有一次出站请求（有道），带统一超时护栏。

v3.4.3 仅调整模型服务商配置弹窗的显示、键盘导航和关闭交互；不改变凭据存储、鉴权、上游请求或数据权限。

## v3.3.6 新增接口与语音能力

- `study_plan.json` 通过既有 `ctxFilePath()` 按用户隔离，并已纳入多用户迁移清单、自动备份和备份恢复清单。
- 听说训练使用 15 分钟、按用户绑定的一次性会话；答案由服务端根据会话权威目标评分，成功提交后立即失效。请求长度、训练模式、成绩元数据和耗时均做边界校验。
- `Permissions-Policy` 将 `microphone` 限定为 `(self)`。语音识别仅在浏览器安全上下文并存在 Web Speech API 时启用；HTTP/IP 或不支持的浏览器提供手动输入。口语评分仅比较文本，不声称评估口音或音素。

## 本版审计结果

v3.4.2 修复写请求取消与响应生命周期处理，不改变鉴权、语料权限或用户数据分区；下列 v3.3.6 安全措施继续适用。外刊只读正文缓存优化属于 v3.4.1。

- `scripts/security-audit.mjs --check` 扫描 Git 跟踪及工作树中未忽略的源码和配置，检测私钥、云访问密钥、GitHub Token、Bearer Token 及高置信度明文密钥赋值；匹配时只报告文件、行号和类型，不回显敏感值。
- `scripts/release-gate.mjs` 检查版本标识、必需发布脚本、Git 空白错误，并可用 `--refs` 核对 Gitee/GitHub `master` 提交一致、用 `--online` 调用只读线上健康检查。
- `scripts/online-health.mjs` 只读取认证状态、应用外壳、Manifest、Service Worker 和安全响应头，不调用任何持久化写接口。
- `scripts/backup-restore-drill.mjs` 在隔离临时目录校验 data 备份与恢复逐文件哈希，排除运行时 `data/backups/` 和临时文件，不覆盖源目录。
- 移动端回归分为 Playwright 设备模拟和 Android ADB + Chrome DevTools 真机入口；没有物理设备时报告为 skipped，不伪造真机结果。

## 本版已处理

- 登录与注册接口增加按客户端地址的进程内频控，超过窗口后返回 `429` 和 `Retry-After`。
- 使用 Cookie 会话的 API 写请求校验 `Origin` / `Referer`，跨站浏览器写请求返回 `403 CSRF_ORIGIN`。
- 统一响应增加 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy` 和 `Cross-Origin-Opener-Policy`。
- 反向代理使用 HTTPS 时，通过 `HTTPS=1`、`TRUST_PROXY=1` 或 `X-Forwarded-Proto: https` 为会话 Cookie 加 `Secure`。
- `npm test` 在隔离沙箱中验证以上行为，避免测试触碰真实 `data/`。
- 静态文件服务使用 `path.relative` 目录边界校验，路径穿越请求不再依赖字符串前缀判断。
- 响应增加基础 CSP：脚本仅允许同源，图片允许同源/data/blob，禁止被 iframe 嵌入。

## 部署边界

- 进程内频控适合单实例基础防护；公网部署仍应在 Nginx、Cloudflare 或云负载均衡层配置按 IP、路径和并发数限流。
- 生产入口必须使用 HTTPS；Node 应绑定 `127.0.0.1`，由 Nginx/Cloudflare 负责 TLS、访问日志和请求体上限。
- `TRUSTED_ORIGINS` 可配置额外可信 Origin，多个值以逗号分隔；默认只接受当前 `Host` / `X-Forwarded-Host`。
- 发布使用 `scripts/deploy.sh`，回滚使用 `scripts/rollback.sh`，不要直接在服务器执行 `git pull` 覆盖运行时数据。
- 发布脚本还会保留 ECS 上由外刊投递链路维护的 `scripts/pull_external.sh`，该脚本不属于产品代码发布范围。

## 后续审计项

- 多实例部署时将登录频控迁移到共享网关或 Redis。
- 持续检查上传文件类型、管理员接口权限和错误日志脱敏。
- 定期演练 `data/` 备份恢复，并在真实 HTTPS 入口验证 Cookie、Origin 和反代头行为。
