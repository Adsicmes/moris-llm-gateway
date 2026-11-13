# 实施与复核记录

## 2026-11-13 · 阶段一：工程与契约

- 建立npm workspaces、TypeScript严格配置、共享模型契约和供应商SDK。
- 固定`moris`身份，区分目录成功同步时间、供应商扣费、参考价格和未知状态。
- `npm run typecheck`通过；`git diff --cached --check`通过。
- Git：`3c979e4`。

## 2026-11-13 · 阶段二：核心服务与账本

- 主模型实现SQLite/WAL、AES-GCM凭据、密码登录/CSRF、可撤销设备密钥、供应商目录生命周期、HTTP/SOCKS5传输、三协议路由与SSE解析、尝试账本、估算与对账、后台管理API。
- 复核重点：每次发出前记录attempt；只有未输出且临时失败可重试；上游错误正文不进入账本；缓存读取不续期；价格/汇率快照不被后续配置改写；设备密钥不能访问管理API。
- 核心定向检查：`mise exec -- npx tsx --test tests/core.test.ts tests/gateway.test.ts`，11项通过。
- 发现并修正：Fastify 5.12的日志控制器必须使用`LogController`实例，不能传普通对象；窗口测试的时间变量笔误已修正。
- 产品文档v0.3已逐项对照用户决策复核；实际外部实例/宿主验证仍保留为待实测。
- 当前核心复核不等于供应商、客户端与部署已交付；这些模块仍在并行实现。
