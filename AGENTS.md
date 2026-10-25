# AGENTS.md — memo bench 工作区（英语学习工作台）

> **本文件是「memo bench」这个新工作区的唯一工作手册。** 承接自 `D:\ai\opencode\momo`（opencode 工作区，含旧 AGENTS.md 与《版本号经历.md》），本工作区从 v3.7.0 / `4c2436f` 起独立开发。
>
> **工作区根 = 仓库根**：`D:\ai\dsh\cli\memo bench`（注意路径含空格，命令行务必加引号）。
> 当前版本口径：**v3.7.1**（2026-10-25）。Gitee `master` 为发布源，GitHub `origin` 为镜像/CI，ECS 用 `scripts/deploy.sh` / `rollback.sh` 发布与回滚。

---

## 0. 一句话

个人考研英语 / 六级英语学习系统：「墨墨背单词同步 + AI 教练互动 + 真题语料注入 + 助记推送墨墨」。
纯 Node 单文件后端（`server.js`，零第三方运行时依赖）+ 原生 JS 单页前端（`public/`），已上线阿里云 ECS。

---

## 1. 工作区布局（本仓库根 = 应用根）

| 路径 | 职责 | 是否入库 |
|------|------|---------|
| `server.js` | **全后端**，约 51 万字符单文件，`http` 原生 | ✅ |
| `public/` | `index.html` + `app.js` + `style.css` + PWA 图标/Manifest/SW | ✅ |
| `scripts/` | 测试入口、发布/回滚、门禁、各类 smoke（`.mjs`/`.sh`） | ✅ |
| `corpus_tools/` | 真题/语料 Python 解析器 | ✅ |
| `corpus/` | 运行时语料：`exams.jsonl`（真题）、`records.jsonl`、`external/`（外刊 release） | `exams/records` ✅；`external/` ❌ |
| `data/` | **用户数据 + 密钥**（db/config/answers/learning_attempts/quiz_srs/backups…） | ❌ |
| `runtime/` | 部署产物：`ecdict/`（离线词典）、`tts/`（Piper + 缓存） | ❌ |
| `.workbuddy/` | 本地 E2E 套件（67 个 `test_*.js` + 调试残渣） | ❌ |
| `node_modules/` | 仅 devDependency `playwright` | ❌ |

**已剥离的源工作区内容**：`english-corpus/`（独立语料管线）、`importer/`（导入工程，`kb.dir` 可再指向）、`zhen/`（真题原始 PDF）。三者未迁入，需要时单独往这里放。

---

## 2. 架构

- **后端** `server.js`（Node ≥22，零依赖）：
  - API 全走 `/api/*`。
  - 持久化：`data/db.json`、`chat_sessions.json`、`config.json`、`learning_attempts.json`（上限 20000，tmp+rename 原子写）、`quiz_srs.json`、`quiz_session.json`、`essays.json`、`llm_usage.json`（按北京自然日聚合，保留 120 天）。
  - **多用户**：用户级文件全部经 `ctxFilePath()` 落 `data/users/<id>/`；`data/users.json` 注册表 + `data/sessions.json` 会话；`enqueueUserWrite` 每用户写串行队列。
  - `data/backups/` 自动备份（启动 + 每 6h，保留 10 份）。
  - 墨墨频控、云词库缓存、自动同步定时器**均按用户隔离**（`mmLimiter` / `notepadCaches` / `autoTimers` 三张 Map）。
  - **出站 fetch 统一护栏**：必须走 `fetchT(url, opts, timeoutMs)`，禁止裸 `fetch`（无超时会毒死 per-user 写队列）。
- **前端** `public/`：原生单页多 Tab，多风格 × 昼夜，移动端金刚导航 + BottomSheet，PWA 可安装。
- **离线词典**：`node:sqlite` 只读 `runtime/ecdict/ecdict.db`（770,611 词条）+ `lemma.db`（184,486 变形映射）。`ECDICT_HOME` 可覆盖路径；词库缺失返回 503 优雅降级。
- **启动**：`node server.js`（`PORT=5178`，`HOST` 默认 `127.0.0.1`，云上设 `0.0.0.0`）。本工作区默认端口 **5178**。

---

## 3. 关键约定（红线，改动前必读）

- **正文渲染**：所有段落首行缩进 2em；所有文本统一走详情渲染函数，**不许裸 `esc()` 直出**；长难句弹层 `.st-sentence` 同样 2em，不得用 `text-indent:0` 绕过。
- **触控契约**：移动端交互控件最小触控高度 **≥44px**。
- **试卷结构还原**：完形/翻译挖空与划线句用 `〖N〗`（`〖/N〗` 表结束）；Part B 答题框独立成段；作文拆 Part A / Part B。
- **助记/词义/例句**：遵循现有 markdown 组件（`mdInline` / `mdLite`），勿另起炉灶。
- **Max Tokens 不设工程钳制**（用户决策）：不做截断、不省 token；预设不内置 `max_tokens`；仅防 0/负数。
- **思考参数单一来源**：`reasoning_effort` 只能来自用户「服务商档案 → 思考强度滑块」（`off/minimal/low/medium/high/xhigh/max`）。**严禁任何功能代码注入 `thinking` / `reasoning` / `enable_thinking`**；`off` 档需 `reasoning_effort:none` + `enable_thinking:false` 双参数。`_jsonMode`（`response_format`）属结构规范，不受此限。
- **AI 一律可降级**：LLM 不可用时必须优雅降级到确定性兜底，不得阻断主流程。
- **版本号**：改动需同步 `package.json` `version` + `public/index.html` 版本标识 + 《版本号经历.md》（`public/sw.js` 的缓存名一并升）。
- **零第三方运行时依赖**：后端不得引入 npm 运行时包（`playwright` 仅测试用）。

---

## 4. 开发与验证流程

1. `node --check server.js` 与 `node --check public/app.js` **必须 0 错误**（`npm run test:syntax` 一并查 `sw.js`）。
2. **改动必须 grep/assert 验证真实落盘**——本环境有「工具假成功」前科，不要只信编辑工具返回值。
3. 涉及真实数据改动：先备份到 `data/backups/`，注意 JSON 原子结构。
4. **验收硬门槛**（全部退出码 0）：
   - `npm test`（隔离沙箱，含 ECDICT 词库回归）
   - `npm run test:syntax`
   - `npm run test:release`（31 项）
   - `npm run test:ops`（release-gate 26 项）
   - `npm run test:mobile`（48 项，Playwright 模拟）
   - 或一把梭 `npm run test:all`
5. **E2E 套件**：`.workbuddy/test_*.js` 可直接 `node` 跑；进程收口统一用 `_test_util.js` 的 `stopServer` / `cleanupSandbox`，脚本以 `process.exitCode` 退出。
   - 已知既有失败（文档记载，非回归）：`test_v212.js`、`test_v212_ui.js`（依赖已删除的 AI 审读）、`test_v220_ui`、`test_hl.js`、`test_v117*` 等 v1.x 遗留调试脚本。

---

## 5. Git、部署与数据红线

### 5.1 远程源

| remote | 地址 | 用途 |
|--------|------|------|
| `gitee` | `https://gitee.com/lgh-2005/memo-workplace.git` | **主力主干，日常只推这里** |
| `origin` | `https://github.com/lgh-2005/memo-workplace.git` | GitHub 镜像 / Actions CI，网络不佳不强求 |
| `src-copy` | `D:/ai/opencode/momo/english-workbench` | **本地源仓库**（只读回源用，勿推） |

- Windows 凭据管理器已存 `git:https://gitee.com`（用户 `lgh-2005`）。
- **本仓库已设 `core.autocrlf=false`**：工作树与源工作树逐字节一致。新克隆若出现全文件 `M`，先查这条。

### 5.2 ECS

- 阿里云 ECS `121.43.177.191`，路径 `/opt/workbench`，systemd `workbench.service`（5178，绑 127.0.0.1，前置 Nginx + Cloudflare HTTPS）。
- 服务器 `origin` 指向 Gitee；Gitee 令牌已持久化 `/root/.git-credentials`（600）。
- 线上**多用户已启用**（`config.multiUser=true`，admin 密码沿用原 Token，原数据已迁入 `data/users/admin/`）。

### 5.3 ⚠️ 数据红线

- 服务器上 `corpus/exams.jsonl` 与 `corpus/records.jsonl` 是**进程可写**文件且长期处于 modified 状态。
- **禁止** `git checkout .` / `git reset --hard` / 直接 `git pull`（会冲掉或冲突线上题库）。
- 标准流程：**先 `tar` 备份 `data/`** → `git fetch origin master` → `git checkout origin/master -- <产品文件>` → `git merge origin/master --ff-only` → 重启服务 → curl 只读验证。

### 5.4 发布流程

本地门禁全绿 → `git push gitee master` → ECS 备份 data + 拉取 + `sudo systemctl restart workbench` → `online-health` 只读验证。

**外刊语料不进 Git**：香港 VPS 夜间增量构建 release → ECS cron `scripts/pull_external.sh` rsync + sha256 核对 + 原子替换，服务端按 mtime 热重载。产品代码发布与外刊数据更新**相互独立**。

---

## 6. 当前状态（v3.7.1，2026-10-25）

**本版主题：划词助手接入离线英汉词典 ECDICT（MIT）**——把「划词全靠 LLM」改为「本地词典秒出 + AI 精读按需增强」。

- **词库**：`runtime/ecdict/ecdict.db`（114MB）+ `lemma.db`（6.8MB）。**不进 git、不参与 `data/` 备份**，发布/回滚 rsync 显式排除 `runtime/`。
- **接口**：`GET /api/dict/ecdict`（精确 → 忽略大小写 → 规则还原 → `lemma.db` exchange → 去符号模糊；交叉引用词条自动跳原形）、`/api/dict/ecdict/suggest`（word 索引范围扫描按 `frq` 升序，limit ≤20）、`/api/dict/ecdict/status`。查询词截断 64 字符，进程内 LRU 4000。
- **前端**：划选单词/1~5 词短词组 → 气泡秒出音标 + 词形 + 考试标签 + 首条释义 → 点击展开完整词条卡（词性分组/英文释义折叠/原形提示/朗读/收进墨墨/AI 精读入口）。句子不查本地库。AI 精读四模式与 `/api/selection/learn` 完整保留。
- **实测**：`node:sqlite` 单查 ~0.2ms、HTTP 平均 9ms；真题语料 14,896 词形本地命中率 **87.1%**。

### 6.1 已交付功能地图（按首次交付版本）

| 版本 | 功能 |
|------|------|
| v2.2 | 学习诊断闭环：单词测验、单元题型、真题迁移、长难句三遍法、诊断周报 |
| v2.3–v2.5 | 划词助手（全站化/多模式精读/独立模型）、词汇精练、词文成章、写作升格 |
| v2.6 | 全真考场交互、真题答案全量回填、手写稿拍照识别（AI 审读已废弃删除） |
| v2.7 | 真题库按 `kaoyan1`/`cet6` 分轨（考研 28 套 + 六级 76 套整卷）、移动端划词气泡 |
| v2.8 | Token 凭证登录、日志版块（开发/使用/报错日志） |
| v2.9 | 外刊全自动入库（release v2：瘦索引 + 分片 gzip）、Markdown 语法升级 |
| v2.10 | 测验记忆引擎：自维护 SRS（简化 SM-2）+ 错题本 + 4 档评分 + 掌握度 0–4 |
| v2.11 | 自适应组卷（确定性可复现）+ 交错 5 类题型 + 会话韧性续做 + 服务端权威复核 |
| v2.12 | 测验 AI 增强 5 处（全部可降级）+ 统计看板 |
| v3.0–v3.2 | 多用户 P0–P3：账户体系、数据分区、共享 Key + AI 用量看板、per-user 自动同步 |
| v3.2.1 | 测验体验四项：智能信心判断、题量下限 1 无上限、自动播报、chip 显示候选数 |
| v3.3.0 | PWA 可安装（Manifest + 鲸鱼图标族 + SW 外壳缓存） |
| v3.3.1 | 出站 fetch 统一超时护栏 `fetchT`（12 处） |
| v3.4–v3.6 | 前端重复入口精简、TTS 发音（有道真人 + Piper）、今日任务中心、外刊刊物数据轨 + 按考试圈定语料范围 |
| v3.7.0 | 离线 ECDICT 划词词典 |
| v3.7.1 | Piper 解释器路径跨平台探测（Windows 可用）+ 本机补装 `runtime/piper` |

### 6.2 已知缺口

- 外刊渠道硬缺口：**FT / WaPo / Times / NYT 双语 / 科学美国人** 未改善。
- `runtime/piper` **本工作区已安装**（python 3.11 venv + piper-tts 1.8.0 + en_US/en_GB 两套 medium 模型）。实测句子冷启动 2.8s、热启动 62ms。属部署产物，不进 git、不参与 `data/` 备份；重装走 `tools/tts/setup_piper.sh`（ECS/Linux），Windows 本机见下条。
  - Windows 上 venv 解释器在 `venv/Scripts/python.exe`（非 `venv/bin/python`）；v3.7.1 起服务端用候选列表探测，无需手动配 `PIPER_HOME`。
  - 语音模型下载：`huggingface.co` 在本机 DNS 不可达，用 hf-mirror 直连（`https://hf-mirror.com/rhasspy/piper-voices/resolve/main/...`）；`python -m piper.download_voices` 的内置源不可用。

---

## 7. 与源工作区的关系（重要）

- 源工作区 `D:\ai\opencode\momo`（应用在其 `english-workbench/` 子目录）**由另一个 agent 同时使用**。
- **不要修改、不要运行、不要在其 `data/` 里写东西。** 只读参考时用 `git -C src-copy` 或直接读文件。
- 分支源点 `4c2436f`（v3.7.0）；本工作区此后独立演进至 v3.7.1。此后各自演进，**不要把本工作区的改动反向写回源工作区**，除非用户明确要求。
- 本工作区已迁入：受控代码 98 文件、`runtime/` 116MB、`corpus/` 840MB、`data/` 78MB、`node_modules/` 18MB、`.workbuddy/` 30MB（67 套 E2E）。
- `data/config.json` 内含墨墨 Token、4 个 LLM 服务商 Key、Tavily / MinerU / 韦氏词典 Key —— **这是密钥副本，不要外发、不要提交**。

---

## 8. 本地环境

- Windows，node `v24.18.0`、npm `11.16.0`、git `2.55.0`、python 命令为 `python`（3.11）。
- 端口：默认 **5178**（本工作区实例）；5283–5285 被其他工具占用，勿占。
- 路径含空格，所有命令行调用需引号包裹。

---

## 9. 文档索引

- 本文件 `AGENTS.md` —— 唯一工作手册（本工作区重建的精简版，原 77KB 版已超上下文预算被截断）。
- 《版本号经历.md》—— 完整版本沿革（281KB，按需 grep 特定版本）。
- `DEPLOY.md` / `TESTING.md` / `SECURITY.md` / `SECURITY_AUDIT.md` / `CI_PLATFORM.md` —— 部署、测试基线、安全基线。
