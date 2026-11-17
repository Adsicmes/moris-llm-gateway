# MorisLLMGateway · 统一模型网关

面向个人多设备的独立服务器端模型网关，统一接入 New API 站点、自定义供应商、OpenAI 订阅和 DeepSeek 官方 API，通过插件维护模型目录、余额、额度和计价信息，并向 OpenCode v2 / OpenChamber v2 同步。提供网页后台、人民币实付账单记录及 OpenChamber 服务信息展示插件。

## 当前状态

- 项目名称为 `MorisLLMGateway`，OpenCode provider ID 为 `moris`；本地目录继续使用 `model-gateway`。
- 已提交阶段：
  - `3c979e4`：npm workspaces、TypeScript 严格配置、共享契约与供应商 SDK。
  - `bc6595a`：认证网关路由、SQLite 存储、三协议转发、attempt 账本、计价基础与后台管理 API。
  - `1a90531`：一致性备份与恢复、Docker Compose、Caddy 示例与部署文档。
  - `71b4ed8`：四供应商插件、设备 OAuth、Responses 聚合与账本修正。
  - `06281f2`：OpenCode 目录／重试插件与 OpenChamber 原生 Work Status 插件。
- 后台与启动整合已完成主模型复核：四插件加载、可信外部包、每日备份、14 天日志和统一构建均已接线；阶段提交记录见 [PROGRESS.md](docs/PROGRESS.md)。
- `mise exec -- npm run check` 通过：74 项测试、根类型检查、服务端／供应商／后台／客户端构建。后台以本地临时数据完成 Tabbit 联调，账单退款和窄屏导航修正已复验。
- 代码存在或本地测试通过，不等于生产可用。真实供应商、真实客户端宿主和真实部署仍按下文列出的边界保留为未验证。
- 已确认需求与行为规则见 [产品需求文档](docs/PRD.md)。

## 本地开发

前置条件：Node.js 24，仓库使用 `mise` 管理工具链。以下命令在仓库根目录执行。

### 1. 安装依赖

首次检出后先初始化子模块（两个客户端插件是独立仓库），再安装依赖：

```bash
git submodule update --init --recursive
mise exec -- npm install
```

必须使用 lockfile 安装。新增 workspace 后先更新 `package-lock.json`，否则 Docker 构建会失败。

### 2. 准备本地环境变量

```bash
cp .env.example .env
```

PowerShell 使用：

```powershell
Copy-Item .env.example .env
```

`.env.example` 面向容器，路径是 `/app/...`。本地开发必须把路径改成仓库内目录，并使用 HTTP 调试配置：

```dotenv
MORIS_HOST=127.0.0.1
MORIS_PORT=8787
MORIS_DATA_DIR=./data
MORIS_BACKUP_DIR=./backups
MORIS_ADMIN_DIST=./apps/admin/dist
MORIS_SECURE_COOKIE=false
MORIS_MASTER_KEY=<自行生成，禁止留空或使用示例值>
MORIS_ADMIN_USERNAME=admin
MORIS_ADMIN_PASSWORD=<自行设置，至少 12 个字符>
```

生成主密钥（32 字节随机数的 base64）：

```bash
mise exec -- node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

管理员密码自行设置，至少 12 个字符。不要使用 `admin/admin`、`password` 或文档中的占位值。主密钥与密码只写入本地 `.env`，该文件已被 `.gitignore` 忽略。

说明：

- 安全 Cookie 为 `true` 时只能通过 HTTPS 登录；本地 `http://127.0.0.1:8787` 调试要设为 `false`，调试结束改回。
- 首次启动会初始化管理员。之后修改 `.env` 中的密码不会改已有账号。
- 可选：`MORIS_PLUGIN_PACKAGES` 填写已安装的 npm 包名，用逗号分隔，加载可信外部供应商插件。管理 API 不提供上传或执行任意代码的入口。

### 3. 构建

```bash
mise exec -- npm run build
```

该命令构建服务端、供应商插件、网页后台和客户端插件；依赖由前面的安装步骤准备。

### 4. 启动

```bash
mise exec -- npm start
```

`start` 会读取仓库根目录的 `.env`。开发时也可用：

```bash
mise exec -- npm run dev
```

启动后访问 `http://127.0.0.1:8787/`。首次登录使用 `.env` 中的管理员用户名和密码。

本地数据位置：

- SQLite：`./data/moris.sqlite`
- 运行日志：`./data/logs`，按 UTC 日切分并保留 14 天
- 本地备份：`./backups`
- 后台静态文件：`./apps/admin/dist`

`Ctrl+C` 会触发 SIGINT，主进程关闭 Fastify、等待进行中的备份并关闭 SQLite。

## 常用命令

```bash
mise exec -- npm run typecheck
mise exec -- npm test
mise exec -- npm run admin:dev
mise exec -- npm run backup -- --backups ./backups
```

备份与恢复的完整说明见部署文档。不要用复制 `.sqlite` 文件的方式备份，直接复制会漏掉 WAL。

## 生产部署

生产使用 Docker Compose 配合服务器上现有的 Caddy，网关只监听 `127.0.0.1:8787`。

完整步骤、Caddy 片段、代理、日志、备份与恢复见 [部署与运维](docs/deployment.md)。

上线前必须准备真实域名、DNS 和 Caddy 操作权限；没有真实域名时只做本地验证，不进行公网部署。

## 文档入口

- [产品需求文档 v0.3](docs/PRD.md)：已确认业务规则、验收标准与调研依据。
- [分阶段实施计划](docs/IMPLEMENTATION.md)：代码交付与真实验收的区分、阶段判据与待实测项。
- [接口契约](docs/API.md)：后台、设备与协议入口。
- [供应商插件说明](docs/providers.md)：各供应商插件的事实来源、凭据字段与能力边界。
- [客户端说明](docs/clients.md)：OpenCode v2 与 OpenChamber v2 的安装、同步与展示边界。
- [后台界面说明](docs/UI.md)：网页后台的页面范围与交互。
- [部署与运维](docs/deployment.md)：Docker Compose、Caddy、备份恢复与升级回滚。

## 已知限制

- 本机 Docker daemon 不可用，镜像构建、Compose 启动和 Caddy 反代未实际验证。
- 缺少真实供应商凭据与实例资料：realseek、vm2api、OpenAI 订阅、DeepSeek 官方及第二个 New API 实例均未做真实账号验证。
- OpenCode 与 OpenChamber 的真实宿主未测试：动态目录刷新、变体字段、客户端自动重试关闭和 Work Status 展示都还没有目标版本证据。
- 网页后台已完成本地联调；真实上游有数据页面、真实 OAuth 和三设备联用仍待验收。
- 现有本地测试只覆盖可控的本地环境，不代表真实上游、真实网络代理或生产部署通过。
