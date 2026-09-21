# AGENTS.md — 学习工作台（momo）工作背景

> 本文件是 opencode 在本工作区的「工作手册」，替代/继承此前 work-buddy 的 `.workbuddy/memory/` 记忆。
> 工作区根：`D:\ai\opencode\momo`。

## 0. 一句话
个人考研英语 / 六级英语学习系统，核心是「墨墨背单词同步 + AI 教练互动 + 真题语料注入 + 助记推送墨墨」。主应用 `english-workbench/`（**v2.7.1**，纯 Node 单文件后端 + 原生 JS 前端），已上线阿里云 ECS，代码以 **Gitee 主干仓库** 与云服务器保持同步，双仓（Gitee 为主，GitHub 镜像/备用）维护。**真题库已按考试大类分轨**：考研英语一（`kaoyan1`，历史卷缺省归属，28 套）与六级英语（`cet6`，2015–2026 全部 76 套整卷已入库，含听力/选词填空/长篇匹配/仔细阅读/汉译英/写作，客观题答案 100% 回填）。

## 1. 目录与各子系统职责（避免重复劳动）

| 路径 | 职责 | 备注 |
|------|------|------|
| `english-workbench/` | **主应用**（本工作区主角） | git 仓库（master）；`server.js`+`public/`；`data/` 数据；`corpus/` 运行时语料/真题；`corpus_tools/` Python 解析器 |
| `english-corpus/` | **独立语料库构建管线**（texsrc TeX 源 + scripts + `corpus_viewer.html`） | 产出 `data/corpus.jsonl`；与 workbench/corpus_tools **功能重叠**，注意分工 |
| `importer/` | **导入工程**（scripts/web/kb/archive/imports/quarantine） | workbench 的 `/api/kb/import` 可 `kb.dir` 指向 `../importer/kb` 联动 |
| `zhen/` | 历年真题原始 PDF（1999–2024） | 纯素材，导入/语料来源 |

## 2. 主应用架构
- **后端** `server.js`（零依赖 Node≥22，`http` 原生）：API 全走 `/api/*`；数据持久化 `data/db.json` + `data/chat_sessions.json` + `data/config.json` + `data/learning_attempts.json`（学习流水，`schemaVersion:1`，上限 20000，tmp+rename 原子写）；`data/backups/` 自动备份（启动+每 6h，保留 10 份）。
- **前端** `public/index.html`+`app.js`+`style.css`：原生单页多 Tab；**4 种风格**（默认清新/复古街机/潮流波普/方块像素）× 昼夜；移动端金刚导航+BottomSheet；专注禅模式/探照灯/白噪音。
- **学习诊断闭环**（v2.2）：单词测验、单元题型（客观/翻译/写作）、词汇真题迁移、长难句三遍训练、学习诊断周报（排除 pending + bySection 分题型 + dueReviews/pendingRetries）。
- **外链**：墨墨 Open API（频控合规）、OpenAI-compatible LLM、韦氏双词典、MinerU OCR、图片生成、网页搜索（均服务端代理）。
- 启动：`node server.js`（PORT=5178；HOST 默认 127.0.0.1，云上设 `HOST=0.0.0.0`）。
- 环境：本机 Windows，node v24 / npm 11 / python 命令为 `python`(3.11) / git 2.55。

## 3. 关键约定
- **正文渲染**：所有段落首行缩进（2em）；所有文本渲染统一走详情渲染函数（含写作/文档/笔记类），**不许裸 `esc()` 直出**。长难句弹层原句 `.st-sentence` 也须遵循 2em 缩进，不得用 `text-indent:0` 绕过。
- **触控契约**：移动端交互控件（按钮/关闭/错因/待复测项等）最小触控高度统一 **≥44px**。
- **试卷结构还原**：完形/翻译挖空与划线句用 `〖N〗`（`〖/N〗` 表划线结束）；Part B 答题框独立成段；作文拆 Part A 小作文 / Part B 大作文。
- **助记/词义/例句渲染**：遵循现有 markdown 组件（mdInline/mdLite），勿另起炉灶。
- **Max Tokens 不设工程钳制（2026-09-19 用户决策）**：工程侧完全不担心 token 预算——服务商档案 Max Tokens 取消 128000 封顶（仅防 0/负数下限），预设不内置 max_tokens；额度随思考自由膨胀属预期行为，不在功能代码里做截断或省 token 处理。
- **思考参数单一来源红线（2026-09-19 用户决策）**：`reasoning_effort` 只能由用户在「设置 → 服务商档案 → 思考强度滑块」调节（7 档 `off/minimal/low/medium/high/xhigh/max`，2026-09 官方档案核实：OpenAI gpt-5.x 全 7 档、DeepSeek V4 支持 none/low/high/max 并自动映射 minimal/medium/xhigh）；服务端 `llmChat` 只按档案透传，**严禁任何功能板块代码注入 thinking/reasoning/enable_thinking 参数**（v2.4.2 的 `_noThinking` 已删除）；off 档需显式关闭（`reasoning_effort:none` + `enable_thinking:false` 双参数，兼容默认思考模型）。`_jsonMode`（response_format）属输出结构规范而非思考控制，不受此红线约束。
- **版本号**：改动需同步更新 `package.json` `version` + `index.html` 版本标识 + 工作手册《版本号经历.md》。

## 4. 开发与验证流程（重要）
1. 改代码 → `node --check public/app.js` 与 `node --check server.js` **必须 0 错误**。
2. 用 grep 验证改动真实落盘（本环境有「工具假成功」前科：不要只看编辑工具返回，务必 grep/assert）。
3. 涉及真实数据改动：先备份 `data/backups/`，改数据文件注意 json 原子结构。
4. 可复用 E2E：`english-workbench/.workbuddy/test_*.js`（node 直跑，`.workbuddy/` 被 gitignore 不入库，版本来源为本地工作树对应 commit）；仓库内 `english-workbench/TESTING.md` 固定记录测试来源、27 套脚本清单与断言数。v2.2.8 后统一用 `.workbuddy/_test_util.js` 的 `stopServer`/`cleanupSandbox` 收口进程与沙箱，脚本以 `process.exitCode` 退出。**14 后端 + 12 浏览器 + 1 线上只读冒烟 = 27 套件全部退出码 0** 为验收硬门槛。

## 5. 部署、Git 拓扑与数据红线（2026-09 最新实测确认）
- **仓库与远程源拓扑**：
  - 本地主仓库位于 `english-workbench/`，Git remote 包含：
    - `gitee`: `https://gitee.com/lgh-2005/memo-workplace.git` (**主力主干！日产仅推送到此**)
    - `origin`: `https://github.com/lgh-2005/memo-workplace.git` (GitHub 镜像/备用，网络不佳时不强求推送)
  - 本地凭据：Windows 凭据管理器已存有 `git:https://gitee.com`（用户 `lgh-2005`）。
- **云服务器（阿里云 ECS 121.43.177.191）实态**：
  - 路径：`/opt/workbench`，系统服务：systemd `workbench.service`（端口 5178，绑定 127.0.0.1，前置 Nginx 反代 + Cloudflare HTTPS）。
  - 服务器 Git remote：`origin` 即指向 `https://gitee.com/lgh-2005/memo-workplace.git`。
  - **云端同步现状与验证**：
    - ECS 上的产品文件已与 Gitee tag `v2.2.8`（`0705689`）逐文件一致；Gitee `master` HEAD 为 `dc43076`（仅多两个 docs 提交 `TESTING.md`/TODO6 证据；分版链最新 `850b093` v2.2.8.g）。
    - ✅ **ECS 凭据已打通**：已在 ECS 服务器部署 Gitee 访问令牌（持久化至 `/root/.git-credentials`，权限 600），`git fetch origin` 已实测连通成功无报错。
    - ✅ **Gitee Skill 工具链已就绪**：本地具备 `gitee` skill（脚本位于 `~/.config/opencode/skills/gitee/scripts/gitee_cli.py`），可免手动配置管理仓库信息、Issue、PR 与 Releases。
  - **⚠️ 数据与脏文件红线（高价值避坑）**：
    - 服务器上 `corpus/exams.jsonl`（30套完整真题）和 `corpus/records.jsonl` 为进程可写文件，且目前服务器处于 modified 状态；
    - 若直接在服务器强行 `git pull` 会报冲突被拒。标准更新流程必须：**先 `tar` 备份 `data/`，再用 `git fetch origin master && git checkout origin/master -- <产品文件> && git merge origin/master --ff-only`，不可使用 `git checkout .` 或 `git reset --hard` 冲掉线上题库**。
- **发布更新流程**：
  - 本地验证通过 (`node --check public/app.js` && `node --check server.js`) → `git push gitee master` → 云端备份 data + 拉取 + `sudo systemctl restart workbench` → curl 只读验证。

## 6. 当前状态与已知问题（起点）
- 版本：**v2.7.1**（2026-09-21：**六级真题题库入库**——把 `D:\download\cet6\text` 的 **76 套**六级真题整卷（2015–2026）搬进网站，全部落在 v2.7.0 打开的 `track=cet6` 轨道上。① **新板块**：六级新增 `listening`（听力理解，25 题按 7 段录音切块，无本地音频）/ `banked_cloze`（选词填空 26–35，原文 `〖N〗` 内联挖空 + A–O 词池）/ `long_match`（长篇匹配 36–45，段落正文 + 陈述选段，字母可到 A–R），与 `reading`/`translation`（**汉译英**，整段译文框）/`writing`（题号 57）组成六板块。② **解析链**：新增 `corpus_tools/cet6_docx.py`（docx → items）+ `cet6_answers.py`（答案 PDF 分区锚点抽取，选词 A–O / 匹配 A–R）+ `gen_cet6_jsonl.py`（逐卷生成并合并 `corpus/exams.jsonl`，幂等按 id 覆盖，考研 28 卷零改动）。③ **服务端**：`EXAM_TRACKS.cet6.sections` / `UNIT_SECTIONS` / `EXAM_SECTION_NAME` 增三板块；`buildUnits()` gkey 增 `listening~pid`；长篇匹配无选项但认定为可判分客观题；六级单元标题含「月/套」防重名。④ **前端**：`EXAM_PROCESSORS.listening/banked_cloze/long_match` 三个新渲染器（附 `cet6RadioCard` 工具）；汉译英专属译文框；答题卡侧栏按 track 动态生成；单元题库分类筛选条随轨道渲染（`TRACK_UNIT_FILTERS`）。⑤ **标准答案**：六级客观题 **3315 题 100% 回填**（听力 1225 / 选词 690 / 匹配 700 / 阅读 700），`data/answers.json` 单元 243→786、答案 1210→4525。真实数据实测：`tracks={kaoyan1:28,cet6:76}`、六级单元 773 个。前序：v2.7.0（真题库考试大类分流 考研英语一/六级英语双轨）；v2.6.3（真题库与单元题库答案全量回填 29 套 1210 题 + 165 单元标准答案）；v2.6.2（手写稿拍照识别 + AI 审读废弃 + 双端适配强化）；v2.6.1.a（全真考场交互）；v2.5.0（写作升格）；v2.2.8（`0705689`）。测试基线：`node --check` 0 错误；新增 `.workbuddy/test_v271_cet6.js`（33 断言，后端六级入库）与 `.workbuddy/test_v271_cet6_ui.js`（22 断言，浏览器六级渲染）退出码 0；17 后端 + 14 浏览器套件全绿（验收清单 32 套 / 658 断言）。
- **⚠️ 弱指令遵循模型事实（2026-09-18 实测确认）**：默认服务商 `cat`（deepseek-v4.1-flash 经 api.catcat.top 中转）对结构化 JSON 输出服从性差——提示词铁律/few-shot/response_format 均无法稳定约束，story 生成已用「二段式 + 确定性兜底」架构收口（v2.4.0.e/f）。若日后切换到指令服从性好的模型（如实测有效的 GPT/Claude 系），二段式会自动跳过（首段直接返回完整 JSON 时不再触发抽取）。词义四选一自测依赖 `db.glosses` 缓存，词池词若无缓存则不出该词的题（属正常降级）。
- **⚠️ 思考失控事实（2026-09-19 实测确认）**：`cat` 服务商的 deepseek-v4.1-flash **默认开启思考且不可通过不传参数关闭**——长输入（大词池/长文生成）下思考会自适应膨胀至 1.5万~2.7万字耗尽 max_tokens（v2.3.5.a 的保护报错会如实提示）。词文成章 analyze/generate 已通过 `_noThinking` 双保险（reasoning_effort=none + enable_thinking=false）压制；若用户日后换思考模型，如遇同类报错，检查该服务商档案思考等级或模型默认行为。
- **⚠️ 默认服务商「大日」配额耗尽（2026-09-18 发现，非代码问题）**：真实 LLM 调用（划词精读/对话等）被上游拒为 HTTP 402 `insufficient_user_quota`（「当前账户暂无生效套餐」），错误已如实透传前端。需用户到中转站充值/续费，或在设置页把默认服务商切到有余额的档案。划词助手独立模型（`config.selection`）留空即沿用默认服务商，切换后即可恢复。
- **线上真题库事实（v2.7.1 起）**：`corpus/exams.jsonl` 含 28 套考研英语一 + 76 套六级整卷（104 卷），六级客观题 3315 题答案齐备；`data/answers.json` 786 单元 / 4525 条（六级新增 543 单元）。
- **线上学习流水事实**：`data/learning_attempts.json` 为空态（85B，attempts=[]）；线上 `data/answers.json` 已由 `corpus_tools/fill_unit_answers.py` 于服务器生成（165 单元 / 1210 条，v2.6.3 起）；`db.json` 约 3,669,685B。
- **发布状态**：post-audit TODO 1（`TESTING.md`）/2（测试补强）/3（文档统一）/4（Release）/6（静态资源三方哈希）均已完成；TODO 5（恢复 canonical 域名）因用户决策**不启用域名**废止。**域名：不启用**（国内备案不便，canonical 入口=ECS 直连 `http://121.43.177.191`，`memo.luguhu.online` NXDOMAIN 不构成阻断）。后续可选 v2.2.9 翻译数据质量补丁（题号校验/字符数口径/周报文案）。历史缺口备查：翻译/写作专属训练、错词周报、助记编辑导出、数据回流固化、2024 真题（仅 PDF 无 TeX 源）是否入库。
- 服务器访问：**SSH 走 `~/.ssh/config` 的 `aliyun` 别名**（root + 密钥 `aliyun_ecs`，可 `ssh aliyun "..."`）。网站 Basic Auth 用户名 `贾忖`（密码在用户本地 `password.txt`，**不得写入仓库**）。
- **域名（已打通 2026-09-08）**：`https://memo.luguhu.online` 走 Cloudflare 代理回源 ECS，源站 443 已装 **Cloudflare Origin CA**（15 年期，`/etc/nginx/ssl/memo.{key,pem}`）+ nginx `workbench-ssl` 站点 + ufw/安全组放行 443；登录走 nginx Basic Auth（`贾忖`）。CF SSL 模式未切严格（用户暂缓），勿擅动。API Token（`opencode`）缺 Zone Settings 权限，改 SSL 模式需面板手动。服务器上另有「空教室」站（端口 8710），勿动。
- **香港服务器（外刊抓取，已接入 2026-09-08）**：`107.151.245.79`，用户 root（密码在桌面 `xianggang.txt`，不在仓库；本机 OpenSSH 不支持命令行密码，需用 Node `ssh2` 临时 runner `/tmp/opencode/hk-ssh/`）。Ubuntu 8 核 15G，磁盘余 65G。
  - **corpus_scraper**：`/root/corpus_scraper/`（venv+Playwright+BPC 3.1.6.4+xvfb）。
    - **科学定时任务（2026-09-09 升级版）**：
      ① **每日 02:00 UTC (北京 10:00)**：跑 `scrape_guardian_daily.py`（卫报日更，题材白名单精选）；
      ② **每日 03:30 UTC (北京 11:30)**：跑 `scrape_nyt_daily.py`（纽约时报中英双语对照增量日更）；
      ③ **每周五 06:00 UTC (北京 14:00)**：跑 `update_economist_weekly.py`（经济学人 EPUB 周更整期解包，自动找最新期）；
      ④ **周三/六 14:00 UTC (北京 22:00)**：跑 `scrape_new_sources.py`（FT/Times UK/Telegraph/Science+Nature 深度评述与学术增量）；
    - 日志 `scrape.log`/`schedule.log`；`state/processed.json` 去重；产物 `output/{md,json}/01_economist、02_guardian、06_nytimes、07-11_*`。
  - **考研相关性过滤（可复用）**：`config.SOURCES[src].topic_include/topic_exclude/min_words` + `scraper.passes_filters()`——exclude 优先、白名单命中才收、词数门槛 300。guardian 已配（science/tech/climate/economy… 白名单，football/recipe… 垃圾词）。卫报日期靠 URL `/YYYY/mon/DD/` 兜底（RSS published 常空）。
  - **词库（2026-09-09 升级+补义完成）**：`vocab/kaoyan_5500.json` 已并入墨墨真实背诵词表（db.json words spelling），并集 **7,007 词**（原开源表 5,075 + 墨墨独有 1,932）。词库非官方（教育部不公布完整词表），主源为 GitHub 开源 `lingdu21863/english-vocabulary` + 64 高频补充词。
    - 升级脚本 `upgrade_vocab_from_maimemo.py`（释义三级回退：现有表→kaoyan_raw.txt→占位）；
    - **释义补全脚本 `fill_vocab_from_webster.py`**：用韦氏双词典 API（learners→collegiate 双查，0.35s 限速，断点续跑 `vocab/webster_done.json`，防 429 自动停）批量补义，**不用 LLM 防幻觉**；1,932 词全部补完（命中 1,911 + 回退 16 英式/变形词 `webster_backfill.py`），仅 5 个生僻新词未收录（alloparenting/alphabetism/gnasher/gurn/tipflation）；
    - 升级后全库重跑 `reprocess_vocab.py`，词汇命中约翻倍（NYT 篇均 129→263）。
  - **首采存量与最新进展（2026-09-09 补齐回填）**：
    - 01_economist 77 篇（2026.09.05 期 EPUB 解包）+ **02_guardian 回填至 650 篇（成功补齐 2026 年 1~3 月断层）**；
    - **NYT 双语通道攻克并落盘**：通过板块页遍历 + `/dual/` 动态注入 + `col-lg-6` 双栏提取，香港节点已成功抓取 **847 篇 2026 最新 NYT 中英双语对照长文**（含考研词高亮与长难句打标），落地 `output/{json,markdown}/06_nytimes/`；
    - **FT 数据清洗**：排查并剔除了 92 篇仅含付费订阅广告的 teaser 脏数据，保留 8 篇高质全文；
    - **全源最新存量**：香港 VPS 产物已达 **1,711 篇**（JSON 与 MD 严格对齐），ima_ready 包含 1,712 份高保真文件，磁盘余量充足（65G）。
    - **WaPo（华盛顿邮报）策略定调**：机房 IP 遭遇 TLS 阻断/断连，不走实时网页爬虫，确定采用**开源电子报整期解包法**（复用 Economist 经验）或高质量存档接口回溯今年文章。
  - **本地回流尚未做**（服务器产物 → 本地 ima_ready 的 pull 流程待固化）。
  - **已实测封锁（从增量剔除，代码保留）**：NYT 主站（DataDome 拦机房 IP，走 cn 双语通道成功绕过）、WaPo（网页爬虫受限，走电子报解包）。
  - **用户决策（2026-09-08）**：语料**优先覆盖 2026 年 1-9 月**（2018-2025 不回填）；外刊项目未完，**暂不入库 workbench**；过滤先行防污染。
  - **本地源=唯一真相**：`C:\Users\兰某\WorkBuddy\2026-09-08-09-38-26\corpus_scraper\`（改代码先改本地再 base64 部署到服务器，两端哈希一致）。
  - 服务器另有 sillytavern、open-webui(8080) 等，勿动。

## 7. 其他
- `si.txt` / `snap.txt` 为根目录杂项，非核心。
- 工作手册：`版本号经历.md`（版本沿革）、`导入解析-经验总结.md`（导入/解析排坑）、`英语学习工作台-评估报告.md`（v1.0.3 历史）、`英语学习工作台-现状评估-v1.2.4.md`（历史起点）；当前状态见 `PROGRESS.md` 与 `AGENTS.md` 本文件 §6。
