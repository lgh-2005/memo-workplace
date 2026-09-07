# 部署到阿里云 ECS（保持可更新）

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

## 二、以后更新（每次 10 秒）

```bash
ssh <服务器>
cd /opt/workbench
git pull
sudo systemctl restart workbench
```

本地改完代码 push 上去，服务器 pull 一下重启即可。`data/` 目录（学习数据、助记、配置）在服务器上独立存在，任何更新都不影响。

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
