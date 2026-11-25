# 部署到阿里云 ECS（保持可更新）

> v4.1.0（2026-11-25）包含悬浮词表、熟悉度初筛和分组导图。`POST /api/tutor/map` 负责分组、出题、判分和复测。采用现有服务商配置，回合保存在内存。产品文件可按标准流程发布和回滚，无数据迁移。

> 本地预览「v4.2.0」（2026-11-24）：发布内容**纯前端 + 纯代码，不新增数据文件、不改 `data/` 布局、不需要迁移**。① 词表从常驻侧栏改为「右下角悬浮球 + 浮层」，**只是 `index.html` / `app.js` / `style.css` 的布局与交互调整**，词表接口与筛选参数一个没动；② `POST /api/tutor/drill` 的入参**向后兼容**——老的 `{word, stage}` 照旧工作，新前端改传 `{words:[...], stage}`（服务端去重并限长 5 个），回包多了 `words` / `group` / `focus` 三个字段，老前端忽略即可；③ 提示词 `tutor_drill` 的默认模板加了「联动模式」段与 `focus` 契约，**用户已自定义过的提示词不会被覆盖**（`config.diyPrompts` 优先级更高）。回滚只需回退这三个前端文件与 `server.js`，无数据影响。发布后可用 `curl -s -X POST http://127.0.0.1:5178/api/tutor/drill -H 'Content-Type: application/json' -d '{"words":["abandon","give up","quit"],"stage":0}'` 验证（未登录 401 属正常，登录后应返回 `ok:true` 且 `words` 长度为 3）。

> 本地带练预览（2026-11-24）：发布内容**纯代码，不新增数据文件、不改 `data/` 布局、不需要迁移**。新增一条 `POST /api/tutor/drill`（AI 带练的出题/判分回合）与提示词 `tutor_drill`（进 `DEFAULT_PROMPTS`，因此会自动出现在设置页可改），前端只加答题卡与一条控制条。`tutor_drill` 的默认模板随代码走，**用户若已自定义过提示词不会被覆盖**（`config.diyPrompts` 优先级高于默认模板）。带练不落 `learning_attempts` / `quiz_srs`，因此发布前后数据无差异；回滚只需回退产品文件。发布后可用 `curl -s -X POST http://127.0.0.1:5178/api/tutor/drill -H 'Content-Type: application/json' -d '{"word":"abandon","stage":0}'` 验证（未登录时返回 401 属正常，登录后再测应返回 `ok:true` 或 `ok:false` 加 `reason`）。

> v4.0.0（2026-11-24）：发布内容**不新增数据文件、不改 `data/` 布局**。真题仍在 `corpus/exams.jsonl`（schema 未变），参考解析仍在 `corpus/exam_analysis/`（文件未删，只是前端只渲染板块级字段）。本次删除 `/api/writing/*` 与 `/api/unit/*` 两组路由，但**不删除任何用户数据文件**（`essays.json` 保留、仅无入口）。发布后可用 `curl -s http://127.0.0.1:5178/api/kb/exams` 验证真题投影接口（应返回 `count:104`）。

零依赖 Node 应用，部署很简单。核心原则：**代码走 git，数据留在服务器 `data/` 目录**（已被 .gitignore 排除，更新代码不会动数据）。

## 一、首次部署（约 10 分钟）

### 1. 服务器装 Node（≥18，推荐 20/22 LTS）

```bash
# Alibaba Cloud Linux / CentOS
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo yum install -y nodejs
# Ubuntu/Debian 则用:
# curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs
node -v
```

### 2. 推代码到 git 仓库（GitHub / Gitee / 阿里云 Codeup 均可）

```bash
# 本地（english-workbench 目录，仓库已初始化好）
git remote add origin <你的仓库地址>
git push -u origin master
```

### 3. 服务器上克隆并启动

```bash
sudo mkdir -p /opt/workbench && sudo chown $USER /opt/workbench
git clone <你的仓库地址> /opt/workbench
cd /opt/workbench

# 首次前台试跑（云服务器多为 UTC 时区，本应用已内置北京时间，无需改系统时区）
HOST=0.0.0.0 PORT=5178 node server.js
```

浏览器访问 `http://<服务器公网IP>:5178`，进入「设置」页**重新填写墨墨 Token 和 AI Key**（密钥只在各自机器的 `data/config.json` 里，不会随 git 同步）。

### 4. systemd 守护（开机自启、崩溃自动拉起）

```bash
sudo tee /etc/systemd/system/workbench.service <<'EOF'
[Unit]
Description=English Workbench
After=network.target

[Service]
Type=simple
User=<你的服务器用户名>
WorkingDirectory=/opt/workbench
Environment=HOST=0.0.0.0
Environment=PORT=5178
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now workbench
sudo systemctl status workbench   # 确认 active (running)
```

### 5. 阿里云安全组放行

ECS 控制台 → 安全组 → 添加入方向规则：TCP 5178（源建议先填你自己的 IP）。

> **强烈建议**：不要裸奔 5178 端口公网暴露（token 和 AI key 在服务端配置里，接口也无登录鉴权）。推荐二选一：
> - 用 nginx 反向代理 80/443 并加 Basic Auth 或只放行自己 IP；
> - 安全组源地址只填你常用网络的出口 IP。

## 二、以后更新（v3.8.2 发布门禁、备份恢复与回滚）

v3.8.2 静态资源条件请求 + 复制按钮 HTTP 降级：**纯代码改动，无新增依赖、无新增配置项、无数据迁移**。改动集中在 `server.js`（静态分支改 `serveStaticFile`，输出 ETag/Last-Modified/Vary，支持 304 与 HEAD；助记图加 `private, max-age=3600`）与 `public/app.js`（新增统一复制入口 `copyText`，替换 5 处调用点）。

- **为什么值得发版**：旧版对 `public/` 下每个文件都打 `Cache-Control: no-store`，配合 nginx 只对 `text/html` 做 gzip，实测首屏 `index`(41KB gzip) + `app.js`(429KB 未压缩) + `style.css`(192KB 未压缩) ≈ **663KB**，关掉页面再开照样再传 663KB —— 等于零缓存。本版改完后重复访问命中 304，传输降到几十字节。
- **`no-cache` 而非 `max-age` 是刻意选择**：本项目版本号靠 `index.html` 内联文本承载、静态文件名不带内容指纹，长缓存会让「发版后用户还看旧版」变成难排查的偶发问题；`no-cache` 允许存储但强制回源校验，命中即 304，收益占满而风险为零。
- **复制按钮**：线上以 `http://IP` 访问时 `navigator.clipboard` 根本不存在（实测 `isSecureContext=false`），旧版四处复制要么抛 TypeError、要么落进空 catch 变成「点了没反应」。本版统一走 `copyText`，失败自动退 `document.execCommand('copy')`（HTTP 下仍可用）。
- **无需重启的项**：无；**需要重启的项**：本版 `server.js` 与 `public/` 改动（`workbench.service` 重启后生效）。
- **发布后自查**：`curl -s http://127.0.0.1:5178/ | grep -o 'v3\.8\.2'` 应命中；`node scripts/online-health.mjs --expected-version 3.8.2` 应 5/5 通过；`curl -sI http://127.0.0.1:5178/app.js` 应看到 `Cache-Control: no-cache` 与 `ETag`，且带 `If-None-Match` 重放应返回 **304**；`node scripts/static-cache-smoke.mjs` 应 30/30 通过。
- **反向代理侧（重要，不属于代码发布）**：若前置 nginx 未配置 `gzip_types text/css application/javascript ...`，`app.js` / `style.css` 仍然不压缩；若 nginx 对静态资源另加 `proxy_no_cache` 或强制改写 `Cache-Control`，会盖掉服务端新增的 304 能力。发布后请用 `curl -H 'Accept-Encoding: gzip' -sI` 确认 `Content-Encoding: gzip` 实际生效。

v3.8.1 词汇精练请求数收敛：**纯代码改动，无新增依赖、无新增配置项、无数据迁移**。三个修复全在 `public/app.js`（请求体去重、输入法 Enter 保护、请求在途锁），一处后端改造在 `server.js`（`ensureGlosses` 改走离线 ECDICT），发布时正常同步产品文件即可。

- **词库依赖**：ECDICT 释义是「能用就用、没有就退回 LLM」的增强路径。服务器上 `runtime/ecdict/ecdict.db` 若已存在（本版线上已装，114MB + `lemma.db` 6.8MB），进入词汇精练时释义将零 LLM 调用；若词库缺失，行为与 v3.8.0 完全一致，**不会报错、不需要额外部署步骤**。
- **`runtime/` 排除口径不变**：词库属部署产物，仍不进 git、不参与 `data/` 备份，`deploy.sh` / `rollback.sh` 继续 `--exclude runtime/`。
- **无需重启的项**：词库替换；**需要重启的项**：本版 `server.js` 与 `public/` 改动（`workbench.service` 重启后生效）。
- **发布后自查**：`curl -s http://127.0.0.1:5178/ | grep -o 'v3\.8\.1'` 应命中；`node scripts/online-health.mjs --expected-version 3.8.1` 应 5/5 通过。

v3.8.0 真题参考解析：解析数据是**仓库内只读内容**（`corpus/exam_analysis/*.json`，701 个单元，随 git 一起分发），与 `corpus/exams.jsonl` 同等对待——**不进 `data/`、不参与数据备份、无需 rsync 排除**。发布时随产品文件一起同步即可；服务端按目录 mtime 热索引，新增/替换解析文件后**无需重启**。若某套真题暂无解析，接口返回 `ready:false`，前端显示「暂无解析」，不影响做题。可用 `node scripts/exam-analysis-build.mjs --dry-run` 核对覆盖情况、`--only=<unitId>` 补跑单个单元。
v3.7.0 划词助手接入离线英汉词典（ECDICT，MIT），词库落在部署产物目录 `runtime/ecdict/ecdict.db`（+ 可选 `lemma.db` 变形表）。它**不进 git、不参与 `data/` 备份**，发布/回滚 rsync 已显式排除 `runtime/`，因此升级代码不会覆盖或删除词库；首次部署需在服务器手工放置词库：

```bash
# 一次性：建目录并上传词库（本机 -> ECS）
ssh aliyun "mkdir -p /opt/workbench/runtime/ecdict"
scp runtime/ecdict/ecdict.db root@121.43.177.191:/opt/workbench/runtime/ecdict/
# 可选：变形表（缺失时自动退化为「规则还原 + exchange 字段查库」）
scp runtime/ecdict/lemma.db root@121.43.177.191:/opt/workbench/runtime/ecdict/
# 变形表也可在服务器就地重建（零依赖，约 0.5s）
node scripts/ecdict-build-lemma.mjs
```

可用环境变量 `ECDICT_HOME` 覆盖词库目录；词库缺失时接口返回 503，前端自动隐藏气泡释义行，划词其他功能不受影响。`GET /api/dict/ecdict/status` 可核验是否就绪。

v3.6.0 新增「外刊刊物数据轨」（每个外刊刊物一条独立轨，中国日报轨 `14_chinadaily` 主打六级翻译/写作）与「按考试圈定学习语料范围」（考试计划 `corpusTracks`，作用于真题迁移/真实例句/听说语料/全库检索的外刊通道），语料库页新增刊物轨筛选条。纯读侧与配置侧改动，不改变 `data/` 备份与发布流程。

v3.5.3 将服务端语音运行时（Piper venv + 模型 + 合成缓存）从 `data/` 移到 `runtime/`——它是部署产物，不进 git、不参与 `data/` 备份（避免 venv 符号链接破坏备份恢复校验），发布/回滚脚本已显式排除 `runtime/`。延续 v3.5.2 的今日词表快照清理（以本次墨墨快照为唯一真源、清理非今日 `w.today`）、v3.5.1 的严格「今日」忘记/模糊筛选与 v3.5.0 的发音朗读升级（修复 CSP 缺少 `media-src`、单词走服务端有道真人发音、句子走本地 Piper 神经语音）。Piper 运行时经 `tools/tts/setup_piper.sh` 一键部署到 `runtime/piper/`。部署流程仍会完整备份并排除 `data/`，保留运行时真题、外刊投递目录和香港投递脚本。v3.4.3 的弹窗适配、v3.4.2 的写队列保护与 v3.4.1 的外刊分片随机读取能力继续随代码运行。

本地改完代码 push 上去，服务器执行 `scripts/deploy.sh`。脚本会先备份 `data/`，保存当前代码快照，拉取 Gitee 指定版本，保留运行时语料，重启并等待健康检查：

```bash
cd /opt/workbench
sudo WORKBENCH_ROOT=/opt/workbench WORKBENCH_REF=master bash scripts/deploy.sh
```

失败时按发布时间点回滚：

```bash
sudo WORKBENCH_ROOT=/opt/workbench bash scripts/rollback.sh 20261010-193000
```

发布脚本不会覆盖 `data/`、运行时 `corpus/records.jsonl`、`corpus/exams.jsonl` 和外刊运行目录；每次发布会在 `data/backups/` 保存数据备份，在 `.releases/` 保存代码快照。

本地提交前执行以下门禁，确保文档、敏感信息、发布脚本和版本标识一致：

```bash
npm run test:syntax
npm run test:release
npm run test:ops
npm run test:mobile
```

`npm run test:mobile` 在没有手机时运行 Pixel 7 / iPhone 13 的 Playwright 模拟回归；有 Android 真机时执行 `npm run test:mobile:device`，该命令通过 ADB + Chrome DevTools 检查真实设备的页面溢出、导航、触控尺寸和控制台错误。

发布前可在 ECS 做无停机演练：

```bash
cd /opt/workbench
bash scripts/deploy.sh --dry-run
bash scripts/rollback.sh <已有快照时间点> --dry-run
```

`--dry-run` 只执行远端版本读取、快照读取和 `rsync --dry-run`，不会写入数据、替换产品文件或重启服务。正式发布后应记录实际备份文件、快照目录、健康检查结果，并至少用最近快照完成一次回滚后再重新发布当前版本。

发布脚本会在备份和替换产品文件前执行 `release-gate.mjs --refs --remote`，核对 Gitee/GitHub `master` 和目标 SHA 的 GitHub Actions 成功状态；备份包生成后立即用隔离式 `backup-restore-drill.mjs --archive` 做逐文件恢复校验，重启后执行 `online-health.mjs`。备份恢复演练可单独运行，不会覆盖源数据：

```bash
bash scripts/backup-restore-drill.sh --source /opt/workbench/data --json
```

## 三、HTTPS 配置（v1.2.0 强烈建议）

> API Key、墨墨 Token、AI 对话内容均经网络传输，**必须上 HTTPS**。

### 方案 A：Caddy 自动签证书（推荐，最简单）

```bash
# 1. 安装 Caddy（Ubuntu/Debian）
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# 2. 配置反向代理（将 your-domain.com 替换为你的域名）
sudo tee /etc/caddy/Caddyfile <<'EOF'
your-domain.com {
    reverse_proxy 127.0.0.1:5178
}
EOF

# 3. 重启 Caddy（自动申请 Let's Encrypt 证书）
sudo systemctl restart caddy
```

访问 `https://your-domain.com` 即可，Caddy 自动续签证书。

### 方案 B：nginx + Let's Encrypt（已有 nginx 的情况）

```bash
# 安装 certbot
sudo apt install certbot python3-certbot-nginx

# nginx 配置添加反向代理
server {
    listen 80;
    server_name your-domain.com;
    location / {
        proxy_pass http://127.0.0.1:5178;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 60m;
    }
}

# 申请证书（自动修改 nginx 配置）
sudo certbot --nginx -d your-domain.com
```

### 无域名临时方案

安全组只放行你自己的 IP，并保持 Basic Auth：

```bash
# 在 nginx location 块中加：
auth_basic "Workbench";
auth_basic_user_file /etc/nginx/.htpasswd;
```

## 四、自动备份（v1.2.0）

v1.2.0 起服务端**自动每 6 小时**备份核心数据到 `data/backups/`（保留最近 10 份），也可通过网页「设置」页手动创建/恢复备份。

手动备份仍然推荐定期做：

## 五、手动备份

只需备份服务器上的一个目录：

```bash
tar czf workbench-data-$(date +%F).tar.gz -C /opt/workbench data
```

定时任务示例（每天凌晨 3 点，北京时间）：

```bash
crontab -e
# 0 3 * * * tar czf /root/backup/workbench-data-$(date +\%F).tar.gz -C /opt/workbench data
```
