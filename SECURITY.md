# v3.3.3 安全专项审计记录

## 本版已处理

- 登录与注册接口增加按客户端地址的进程内频控，超过窗口后返回 `429` 和 `Retry-After`。
- 使用 Cookie 会话的 API 写请求校验 `Origin` / `Referer`，跨站浏览器写请求返回 `403 CSRF_ORIGIN`。
- 统一响应增加 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy` 和 `Cross-Origin-Opener-Policy`。
- 反向代理使用 HTTPS 时，通过 `HTTPS=1`、`TRUST_PROXY=1` 或 `X-Forwarded-Proto: https` 为会话 Cookie 加 `Secure`。
- `npm test` 在隔离沙箱中验证以上行为，避免测试触碰真实 `data/`。

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
