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
- Git：`bc6595a`。

## 2026-11-13 · 阶段三：传输验证与备份部署

- DeepSeek副手实现一致性在线备份、恢复、7日/4周轮转、Docker Compose与Caddy交付配置；主模型读代码复核备份包含WAL、恢复前快照及只清理自身产物。
- 备份定向测试5项通过；副手在临时数据库实际验证恢复往返、缺少确认参数拒绝、损坏备份不覆盖原库。
- DeepSeek副手增加本机真实HTTP/TCP测试；主模型复核并运行网关与传输测试11项通过，覆盖取消、直连abort、HTTP CONNECT、SOCKS5、显式回退与完整SSE用量。
- `npm run build:server`通过。主模型调整Compose健康检查为`/health`，同时检查数据库可读。
- 尚未构建Docker镜像：本机daemon不可用；未连接用户真实服务器。
- Git：`1a90531`。

## 2026-11-13 · 阶段四：供应商、授权与核心整合

- 四个独立供应商包：realseek、DeepSeek 官方、vm2api、OpenAI 订阅；SDK 增加可选设备授权能力与仅 SSE 上游响应标记。
- 主模型复核并修正：New API 分组以账号权限为准，旧令牌不复活已删分组；显式凭据优先；未知价格保持可调用且不虚构估算；vm2api 缺少用量时不显示假零；独立额度池不混入通用窗口。
- OpenAI 管理员设备授权实现会话绑定、轮询间隔、到期检查和加密保存；Responses 非流式请求可聚合仅 SSE 的上游完成事件，保留工具与用量。
- 后台实际录入发现账单查询 JSON 路径错误，修正 `$.paidAt` 并新增排序与退款回归。
- 检查：供应商 16 项、OAuth 6 项定向测试通过；统一 `mise exec -- npm run check` 的 74 项测试、根类型检查与全部构建通过。真实供应商授权、扣费和目录尚未验证。
- Git：`71b4ed8`。

## 2026-11-13 · 阶段五：OpenCode 与 Work Status 客户端

- OpenCode 仅维护 `moris`，按模型选用三协议运行时，禁用本网关自动重试与 WebSocket；目录首启重放、刷新异常、完整目录删除、地址与超时更新已修正。
- 用户确认不可表达价格保留调用：`cost: []` 与“价格见网关”；接受宿主汇总可能显示 0，以网关账本为准，缺失缓存价格不补造。
- OpenChamber 使用原生 `statusSection.source` 和 host service，无独立页面；按 directory 隔离最多 32 个缓存，60 秒 single-flight，保留无样本 unknown 账户。
- 主模型复核客户端，28 项测试通过；真实 SDK schema、manifest、fake context、loopback service 检查通过，构建产物保留在各包 `build/` 供本地安装。
- 目标 OpenCode/OpenChamber 宿主尚未安装运行，不能将 SDK 契约检查作为宿主验收。
- Git：`06281f2`。

## 2026-11-13 · 阶段六：后台、启动与交付收尾

- React 后台、四插件启动、可信外部包、每日备份、14 天日志及根 workspace/build/lockfile 完成整合。详细入口见 README。
- 主模型使用最新编译服务及临时数据库，通过 Tabbit 验证登录、创建停用供应商、保存 -20 CNY 退款和净额；运行日志确认首次备份成功。
- 最终查看 1440／390／320 截图；修复手机关闭导航仍可 Tab 聚焦屏幕外链接的问题，并改用 rem 根字号。定向键盘复验通过，桌面导航仍可用。
- `better-interface` 最终报告见 `docs/UI.md` 第 10 节：已检查范围内 HIGH 已修复；屏幕阅读器、200% 缩放、真实有数据上游页面等未验证事项明确保留。
- 统一 `mise exec -- npm run check`：74/74 测试、根类型检查与全部构建通过。最后 CSS 改动后仅重跑 `mise exec -- npm run admin:build` 和受影响导航浏览器流程，均通过。
- README、IMPLEMENTATION、UI、deployment 已同步；没有真实账号／宿主／Docker 验收声明。
- 临时服务 PID 43836 已停止，Tabbit `Moris后台验收` 已 finish；测试数据留在批准的临时目录，不进入仓库。
- 阶段六提交主题：`feat(admin): stage 6 console, runtime and verified delivery`（本记录随该提交入库，可用 Git 日志定位）。

## 下一阶段：真实接入

- realseek、DeepSeek、vm2api、第二 New API 实例及 OpenAI 授权的真实账号资料待提供。
- 真实 OpenCode／OpenChamber 插件安装与三设备联用待验证；当前 SDK 检查不替代宿主验收。
- Docker daemon 不可用；镜像、Compose、Caddy、生产代理与恢复演练待执行。
- 项目待办已登记；详细验收证据要求见 `IMPLEMENTATION.md` V-01～V-13。
