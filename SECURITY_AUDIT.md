# v3.3.5 安全审计报告

审计日期：2026-10-11
审计范围：`server.js`、`public/`、发布脚本、CI 工作流、Git 跟踪及工作树中未忽略的文档与配置。

## 结果

- 敏感信息扫描：通过。未发现私钥、云访问密钥、GitHub Token、Bearer Token 或高置信度明文密钥赋值。扫描只输出路径、行号和类型，不输出匹配值。
- 发布门禁：通过。版本、Service Worker 缓存名、HTML 版本标识、必需运维脚本和 Git 空白检查均通过。
- 线上健康检查：只读检查认证状态、应用外壳、Manifest、Service Worker 和安全响应头；不调用任何持久化写接口。
- 备份恢复：在隔离临时目录进行 data 逐文件 SHA-256 备份/恢复校验；源目录不会被覆盖，`data/backups/` 与临时文件被排除以避免备份自包含。
- 移动端：Playwright 覆盖 Pixel 7、Pixel 7 横屏和 iPhone 13；Android 真机入口使用 ADB + Chrome DevTools。当前开发机无物理真机，真机项标记为待执行。

## 已有防护

- 登录/注册接口进程内频控与 `Retry-After`；
- Cookie 会话写请求的 Origin/Referer 同站校验；
- CSP、`X-Content-Type-Options`、`X-Frame-Options`、Referrer-Policy、Permissions-Policy 和 COOP；
- 静态资源路径使用目录边界校验；
- 发布脚本保护 `data/`、运行时真题、外刊 current/releases 与香港投递脚本。

## 持续事项

- 连接 Android 真机后执行 `npm run test:mobile:device` 并保存输出；
- 多实例部署时将进程内频控迁移到共享网关或 Redis；
- 定期执行 `bash scripts/backup-restore-drill.sh --source /opt/workbench/data --json` 并归档结果。
