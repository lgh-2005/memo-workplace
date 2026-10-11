# v3.4.0 安全审计与敏感信息扫描记录

## v3.3.6 新增接口与语音能力

- `study_plan.json` 通过既有 `ctxFilePath()` 按用户隔离，并已纳入多用户迁移清单、自动备份和备份恢复清单。
- 听说训练使用 15 分钟、按用户绑定的一次性会话；答案由服务端根据会话权威目标评分，成功提交后立即失效。请求长度、训练模式、成绩元数据和耗时均做边界校验。
- `Permissions-Policy` 将 `microphone` 限定为 `(self)`。语音识别仅在浏览器安全上下文并存在 Web Speech API 时启用；HTTP/IP 或不支持的浏览器提供手动输入。口语评分仅比较文本，不声称评估口音或音素。

## 本版审计结果

v3.4.0 仅精简前端页面结构与导航，不修改鉴权、服务端写接口、语料权限或数据持久化；下列 v3.3.6 安全措施继续适用。

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
