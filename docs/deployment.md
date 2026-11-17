# MorisLLMGateway 部署与运维

版本：v0.1

日期：2026-11-13

适用：单台 Linux x64 服务器，Docker Compose + 现有 Caddy

需求依据：[PRD.md](PRD.md)、[实施计划](IMPLEMENTATION.md)

> 本文中的 `moris.example.com`、`/opt/moris` 均为占位符。没有用户真实域名、DNS 解析与 Caddy 操作权限时，只做本地验证，不进行公网部署。

## 1. 验证状态（先读）

在编写本文件时：

- 本机 Docker daemon 不可用，**未执行**镜像构建和容器启动；Compose 配置已在临时环境解析检查。
- `apps/gateway/src/main.ts` 已实现；真实域名和服务器部署尚未验证。
- 已实际验证：`scripts/backup.ts` 的在线备份、WAL 数据完整性、7 日/4 周轮转、只删除自身产物；`scripts/restore.ts` 的完整性校验、恢复前快照、WAL/SHM 清理与恢复后数据一致性（本机 Node 24.22，临时目录）。
- 已实际验证：备份产物为 DELETE 日志模式，只读校验不会留下 `-wal/-shm` 旁文件。
- 本地可控上游已验证：客户端取消关闭上游、HTTP CONNECT 和 SOCKS5 代理、SSE 部分输出不重放。未验证：用户真实代理链路、供应商账号、Caddy 实际转发和镜像构建。

因此本文是部署操作说明，不是“已部署”证明。任何一项上线操作都要以实际命令输出为准。

## 2. 拓扑与文件

```text
浏览器 / OpenCode / OpenChamber
            │ HTTPS
       现有 Caddy（宿主）
            │ 127.0.0.1:8787
   ┌────────▼─────────┐
   │ moris 容器        │  非 root，Node 24
   │ Fastify :8787     │
   │ /app/data         │── moris-data 卷（SQLite）
   │ /app/backups      │── moris-backups 卷（备份）
   └───────────────────┘
```

- 网关只绑定宿主 `127.0.0.1:8787`，不直接暴露公网。
- Compose 不启动 Caddy；继续使用服务器上已有的 Caddy。
- 单实例、单 SQLite；不引入 PostgreSQL 或 Redis。
- 容器内以 `node` 用户运行，`/app` 只读即可，只有 data 与 backups 两个卷可写。

本任务涉及的文件：

| 文件 | 用途 |
| --- | --- |
| `deploy/Dockerfile` | Node 24 多阶段构建，固定主版本 |
| `deploy/Dockerfile.dockerignore` | 构建上下文裁剪与 `.env` 排除 |
| `deploy/compose.yml` | 单服务、回环端口、卷、日志轮转、host-gateway |
| `deploy/Caddyfile.example` | 现有 Caddy 的反代片段 |
| `.env.example` | 环境变量模板，不含真实密钥 |
| `scripts/backup.ts` | 在线一致性备份与轮转 |
| `scripts/restore.ts` | 显式确认的安全恢复 |
| `tests/backup.test.ts` | 备份内容与轮转边界测试 |

## 3. 上线前置条件

全部满足才继续：

- [ ] 已有真实域名，DNS 已指向服务器。
- [ ] 现有 Caddy 正常服务，且可修改站点配置并重载。
- [ ] 服务器已安装 Docker Engine 与 Compose v2。
- [ ] 仓库已放到服务器，例如 `/opt/moris`，且已执行 `git submodule update --init --recursive`（两个客户端插件是独立仓库）。
- [ ] 已确认服务器出网方式；需要代理的供应商已准备 HTTP / SOCKS5 / Clash 地址。
- [ ] 已决定主密钥与管理员密码的保存位置（密码管理器或离线介质）。

缺少域名时不要用占位域名上线，也不要把 8787 直接暴露到公网。

## 4. 首次部署

### 4.1 准备环境变量

在仓库根目录：

```bash
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，填写真实值。两个密钥不要用示例、不要复用其他系统、不要发到聊天或提交到 git。

生成主密钥（32 字节随机数的 base64）：

```bash
openssl rand -base64 32
```

校验解码后确为 32 字节：

```bash
openssl rand -base64 32 | tr -d '\n' | base64 -d | wc -c   # 应输出 32
```

生成管理员初始密码（至少 12 字符；建议 24 字节以上随机）：

```bash
openssl rand -base64 24
```

Windows PowerShell 可用：

```powershell
$b = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($b)
[Convert]::ToBase64String($b)
```

主密钥要求：

- 必须是 32 字节随机值的 base64；不要手写短口令。
- 只通过 `.env` 注入，不入库、不进镜像、不写日志。
- 必须单独备份。丢失后，数据库中已加密的上游凭据无法恢复。

管理员密码要求：

- 首次启动时至少 12 个字符，禁止使用默认密码。
- 该变量只在首次初始化管理员时生效；首启后修改 `.env` 不会自动改已有密码。
- 若忘记密码，首期没有重置流程，只能按数据库恢复流程处理，操作前先备份。

### 4.2 构建镜像

```bash
cd /opt/moris
docker compose -f deploy/compose.yml build
```

说明：

- 构建阶段执行 `npm ci`，需要 `package-lock.json` 与所有 workspace 的 `package.json` 一致；新增 workspace 后先在本地更新 lock 再构建。
- 基础镜像固定 `node:24-bookworm-slim`，不写不存在的 digest。
- 构建会执行 root `npm run build`。主模型会把后台网页（Vite）与客户端插件的构建并入该命令；若后台产物缺失，先检查这一步，不要手工往镜像里塞旧文件。
- 构建上下文若混入 `.env`，Dockerfile 会主动失败，避免把密钥写进镜像层。

本机没有 Docker 时，不要声称镜像已验证；只能在有 Docker 的机器上补做。

### 4.3 启动

```bash
docker compose -f deploy/compose.yml up -d
docker compose -f deploy/compose.yml ps
docker compose -f deploy/compose.yml logs -f gateway
```

预期：

- `gateway` 状态为 running / healthy。
- 日志出现监听 8787、数据库就绪、管理员初始化（仅首次）等信息。
- 首次启动缺少主密钥或密码不足 12 字符时应直接失败，日志给出明确原因；不要用关闭校验的方式绕过。

检查端口只绑定回环：

```bash
ss -lntp | grep 8787
# 期望 127.0.0.1:8787，而不是 0.0.0.0:8787
```

### 4.4 配置现有 Caddy

参考 `deploy/Caddyfile.example`，把占位域名换成真实域名，合并到现有 Caddy 配置：

```caddyfile
moris.example.com {
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
		transport http {
			read_timeout 16m
			write_timeout 16m
			dial_timeout 10s
		}
	}
}
```

要点：

- `flush_interval -1`：SSE 事件立即下传，不攒包。
- `read_timeout` / `write_timeout` 小于 15 分钟会截断长生成；这里留到 16 分钟，让应用先按 15 分钟期限返回。
- 不要对 SSE 路径启用压缩或缓存；Caddy 默认不缓存，但不要额外加缓存插件或 `encode`。
- 如果 Caddy 运行在 bridge 容器而不是宿主网络，把上游改为 `host.docker.internal:8787`，并给 Caddy 服务加 `extra_hosts: ["host.docker.internal:host-gateway"]`。

校验并重载（命令以现有 Caddy 安装方式为准）：

```bash
caddy validate --config /path/to/Caddyfile
caddy reload --config /path/to/Caddyfile
```

### 4.5 首次登录

打开 `https://<真实域名>/`，使用 `.env` 中的管理员用户名与密码登录。

- 后台会话使用 HttpOnly Cookie；`MORIS_SECURE_COOKIE=true` 时只能经 HTTPS 登录。
- 仅本机 HTTP 调试时可临时设为 `false`，调试完恢复 `true`。
- 登录后先创建三台设备各自的网关密钥，再配置供应商；设备密钥只用于调用、目录与额度查询，不能进入后台。

## 5. 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MORIS_HOST` | 是 | 容器内监听地址，固定 `0.0.0.0`；公网暴露由端口映射限制。 |
| `MORIS_PORT` | 是 | 固定 `8787`，与 compose 和 Caddy 一致。 |
| `MORIS_DATA_DIR` | 是 | 固定 `/app/data`，对应 `moris-data` 卷。 |
| `MORIS_MASTER_KEY` | 是 | 32 字节随机数的 base64；加密上游凭据。缺失或格式错误应拒绝启动。 |
| `MORIS_ADMIN_USERNAME` | 是 | 首次初始化管理员用户名。 |
| `MORIS_ADMIN_PASSWORD` | 是 | 首次初始化密码，至少 12 字符；禁止默认值。 |
| `MORIS_SECURE_COOKIE` | 是 | 生产为 `true`；仅本机 HTTP 调试临时为 `false`。 |
| `MORIS_ADMIN_DIST` | 是 | 网页构建产物目录，镜像内为 `/app/apps/admin/dist`。 |

补充：

- `NODE_ENV=production` 已写在镜像中。
- 容器时区未强制设置；备份文件名按 Asia/Shanghai 计算，不依赖容器 TZ。应用统计时区由程序固定为 Asia/Shanghai。
- 不要新增全局 `HTTP_PROXY` / `HTTPS_PROXY` 来“统一代理”，原因见下一节。

## 6. 出站代理

代理按供应商配置，不走全局环境变量：

- 管理后台的供应商配置里填写 `proxyUrl`。
- 支持 HTTP 代理（如 `http://host.docker.internal:7890`）与 SOCKS5（如 `socks5://host.docker.internal:7891`）。
- Clash 使用其 HTTP 或 SOCKS5 监听端口；不要填 Clash 的控制端口或混合端口的不支持协议。
- 授权、令牌刷新、模型发现、余额查询和推理都必须走同一代理；只代理推理会导致授权或同步失败。
- 不在镜像、compose 或 `.env` 中写死用户代理地址；代理变更只改对应供应商，不影响其他供应商。

Linux 上访问宿主 Clash：compose 已加

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

Docker Desktop（macOS / Windows）通常自带该主机名。可从容器验证宿主代理端口是否可达：

```bash
docker compose -f deploy/compose.yml exec gateway node -e "const net=require('node:net');const s=net.connect(7890,'host.docker.internal',()=>{console.log('proxy reachable');s.end()});s.on('error',e=>{console.error(e.message);process.exit(1)})"
```

把 `7890` 换成实际端口；该检查只证明 TCP 可达，不证明上游账号可用。

## 7. 日志

两类日志不要混淆：

### 7.1 容器 stdout/stderr

- 应用日志写 stdout，由 Docker 的 `local` 驱动收集。
- compose 配置为单文件最大 10 MB、保留 5 个，约 50 MB 上限；超出后自动轮转。
- 查看：`docker compose -f deploy/compose.yml logs -f gateway`。
- 容器删除或重建后，旧 stdout 日志不再保留；它不是审计账本。

### 7.2 应用内脱敏日志

- 应用自身保留 14 天脱敏运行日志（由主模型实现），与 Docker 的 10 MB × 5 轮转相互独立。
- 不要用 Docker 日志条数推断 14 天保留是否生效。
- 不得在日志中输出上游密钥、OAuth 刷新令牌、设备密钥或请求正文。

## 8. 备份

### 8.1 原则

- 只用 SQLite 在线备份 API（`node:sqlite` 的 `backup()`）；**严禁** `cp moris.sqlite`，直接复制会漏 WAL。
- 日备份保留 7 份，周备份保留 4 份。
- 建议每日 03:00（Asia/Shanghai）执行一次；每周第一次执行时额外生成一份周备份，ISO 周按 Asia/Shanghai 日历确定。
- 文件名：
  - `moris-daily-YYYY-MM-DD.sqlite`
  - `moris-weekly-YYYY-Www.sqlite`
- 只有严格匹配上述模式的文件会被轮转删除；其他文件（包括 `moris-pre-restore-*.sqlite`）不会被自动清理。
- 备份文件权限 0600，目录 0700。
- 备份写入 `/app/backups` 卷；该卷仍在同一台服务器上，必须定期复制到另一台机器或对象存储，否则服务器损坏时备份同时丢失。
- 主密钥单独备份，不要和数据库备份放在同一个压缩包或同一块介质上。

### 8.2 推荐：主进程内定时

`scripts/backup.ts` 导出：

```ts
runBackup(dbPath: string, backupDir: string, now?: Date): Promise<BackupResult>
```

主进程可直接引用（源文件与编译产物层级一致）：

```ts
// apps/gateway/src/main.ts 或 dist/apps/gateway/src/main.js
import { runBackup } from '../../../scripts/backup.js';
```

从 `apps/gateway/src/main.ts` 出发：`src` → `gateway` → `apps` → 仓库根，再进 `scripts/backup.js`，即 `../../../scripts/backup.js`；编译后在 `dist/apps/gateway/src/main.js` 出发也是同样的 `../../../`。不要写成 `../../../../`。

主进程已接入每日备份：启动后及每 60 秒检查北京时间日期，当日未成功备份则执行，成功后记录 `lastBackupDay`；失败记录脱敏错误并允许后续重试。它不固定在 03:00。下面的宿主 cron 是独立调度示例，不需要与内置调度同时启用。

### 8.3 备选：宿主 cron 调用容器内脚本

服务运行中也可执行，`backup()` 会取一致快照：

```bash
docker compose -f deploy/compose.yml exec -T gateway \
  node dist/scripts/backup.js \
  --db /app/data/moris.sqlite \
  --backups /app/backups
```

crontab 示例：

```cron
0 3 * * * cd /opt/moris && docker compose -f deploy/compose.yml exec -T gateway node dist/scripts/backup.js --db /app/data/moris.sqlite --backups /app/backups >> /var/log/moris-backup.log 2>&1
```

注意：

- 不要同时启用主进程 timer 和宿主 cron，否则同一天会重复覆盖日备份；周备份因“本周已存在则跳过”不会重复。
- 容器未运行时 cron 会失败，日志中应能看到；恢复后补跑一次即可。
- 备份完成不等于已异地保存；另设备份文件本身。

### 8.4 检查备份

```bash
docker compose -f deploy/compose.yml exec gateway ls -l /app/backups
```

预期只看到 `moris-daily-*`、`moris-weekly-*`，以及人工保留的 `moris-pre-restore-*`；不应有长期残留的 `.tmp` 或 `-wal/-shm`。

## 9. 恢复

恢复必须停服务。脚本无法可靠判断是否仍有进程在写，`--confirm` 是操作者的显式确认，不是自动检测。

### 9.1 标准步骤

```bash
cd /opt/moris

# 1. 停止网关，确保没有写入者
docker compose -f deploy/compose.yml stop gateway

# 2. 选择备份并恢复；脚本会先校验 integrity_check
docker compose -f deploy/compose.yml run --rm --no-deps gateway \
  node dist/scripts/restore.js \
  --backup /app/backups/moris-daily-2026-11-13.sqlite \
  --db /app/data/moris.sqlite \
  --backups /app/backups \
  --confirm

# 3. 启动并检查
docker compose -f deploy/compose.yml up -d gateway
docker compose -f deploy/compose.yml logs -f gateway
```

脚本行为：

1. 没有 `--confirm` 直接拒绝，不改任何文件。
2. 对备份执行 `PRAGMA integrity_check`；不通过则中止。
3. 目标库存在时，先用 `backup()` 生成 `moris-pre-restore-<UTC时间>.sqlite`，失败则中止。
4. 通过同目录临时文件写入、`fsync`、`rename` 替换目标库；不先删除活库。
5. 清理目标库旁的 `-wal` / `-shm`，避免旧 WAL 覆盖新数据。
6. 备份文件权限 0600；不读取业务表，不打印密钥。

恢复后必须确认：

- 管理员能登录。
- 供应商凭据可解密（主密钥与备份时一致）。
- 模型目录、余额、账目、账单数量与预期一致。

主密钥不一致时，数据库能打开但上游凭据无法解密；此时不要反复重试覆盖，先找回原主密钥。

### 9.2 人工兜底（脚本不可用时）

仅在脚本无法运行时使用，且必须保持服务停止：

1. 保留现场：不要删除当前 `/app/data/moris.sqlite`，也不要删除最近一次 `moris-pre-restore-*`。
2. 在能访问卷的宿主上使用 `sqlite3`（slim 镜像内未安装；需宿主自行安装）：

   ```bash
   sqlite3 /path/to/moris-daily-YYYY-MM-DD.sqlite ".backup '/path/to/moris.sqlite'"
   rm -f /path/to/moris.sqlite-wal /path/to/moris.sqlite-shm
   chmod 600 /path/to/moris.sqlite
   ```

3. 用 `sqlite3 /path/to/moris.sqlite "PRAGMA integrity_check;"` 确认返回 `ok`。
4. 再启动服务并核对数据。

该兜底步骤未在本机实际执行（本机未安装 sqlite3），不要把它当作已验证路径；优先使用 `restore.ts`。

## 10. 升级

```bash
cd /opt/moris

# 1. 先备份
docker compose -f deploy/compose.yml exec -T gateway \
  node dist/scripts/backup.js --db /app/data/moris.sqlite --backups /app/backups

# 2. 保留当前镜像，便于回滚
docker image tag moris-gateway:local moris-gateway:before-$(date +%Y%m%d-%H%M)

# 3. 拉取代码后重建并启动
docker compose -f deploy/compose.yml build
docker compose -f deploy/compose.yml up -d
docker compose -f deploy/compose.yml logs -f gateway
```

升级检查：

- `docker compose ps` 为 healthy。
- 登录后台，确认目录同步、余额查询、额度估算正常。
- 发送一次短请求与一次流式请求，确认 SSE 不被缓冲。
- 若出现数据库结构或数据异常，停止服务并按第 9 节恢复升级前备份。

当前数据库初始化是幂等建表，没有独立迁移版本号；这不等于可以免备份升级。跨版本升级前必须备份。

## 11. 回滚

### 11.1 只回滚程序

```bash
cd /opt/moris
docker compose -f deploy/compose.yml stop gateway
docker image tag moris-gateway:before-YYYYMMDD-HHMM moris-gateway:local
docker compose -f deploy/compose.yml up -d --no-build
```

### 11.2 程序与数据一起回滚

1. 按第 10 节停服务。
2. 按第 9 节恢复升级前备份（会再生成一份 pre-restore 快照）。
3. 切回旧镜像后启动。
4. 保持主密钥不变；否则旧库中的上游凭据无法解密。

## 12. 常见问题

**容器启动即退出**

- 检查 `MORIS_MASTER_KEY` 是否为 32 字节 base64、`MORIS_ADMIN_PASSWORD` 是否至少 12 字符。
- 看 `docker compose logs gateway` 的首个错误，不要用放宽校验的方式绕过。

**登录后立刻 401 / Cookie 不生效**

- 生产必须经 HTTPS 且 `MORIS_SECURE_COOKIE=true`。
- 本机 HTTP 调试临时设 `false`，完成后改回。

**后台空白或 404**

- 确认镜像内 `/app/apps/admin/dist/index.html` 存在，且 `MORIS_ADMIN_DIST` 指向它。
- 确认 root `npm run build` 已包含 admin 构建；这是主模型构建脚本的职责。

**流式请求被截断或一次性返回**

- Caddy 必须有 `flush_interval -1`，并确认没有压缩/缓存层。
- `read_timeout`、`write_timeout` 不小于 16 分钟。
- 应用侧总期限为 15 分钟；超过后应有明确超时错误。

**供应商授权/同步失败但推理正常**

- 代理只覆盖了推理。把同一 `proxyUrl` 用于授权、刷新、发现、查询全链路。
- Linux 上确认 `host.docker.internal` 可解析，代理端口从容器可达。

**备份目录出现 `-wal/-shm`**

- 正常情况下备份文件是 DELETE 日志模式，不应产生旁文件。
- 若出现非空 `-wal`，不要只拷贝主文件；重新执行备份。

**恢复被拒绝**

- 未加 `--confirm`，或备份旁存在非空 WAL，或 `integrity_check` 未通过。按提示处理，不要强行覆盖。

**卷权限错误（改用 bind mount 时）**

- 容器以 uid 1000 的 `node` 运行；宿主目录需允许该 uid 写入。优先使用 compose 自带的命名卷，避免手工改权限。

## 13. 安全与运维清单

- [ ] `.env` 权限 600，未提交 git，未进入镜像。
- [ ] 主密钥为 32 字节随机值，已单独离线备份。
- [ ] 管理员密码非默认、至少 12 字符，已存入密码管理器。
- [ ] 8787 只监听 `127.0.0.1`，公网只开放 80/443。
- [ ] Caddy 使用真实域名与有效证书，SSE 不缓冲。
- [ ] 三台设备各自使用独立密钥，可单独撤销。
- [ ] 备份每日执行，7 日 + 4 周；至少一份已复制到另一台机器。
- [ ] 恢复流程在非生产环境演练过；未演练前不声称可恢复。
- [ ] Docker 日志轮转与应用 14 天日志分别确认。
- [ ] 升级前已备份并保留旧镜像 tag。

## 14. 未决与未验证

- 真实域名、DNS、Caddy 站点配置未提供，公网部署未执行。
- Docker 镜像未构建；`docker compose config` 未运行。
- `apps/gateway/src/main.ts` 已落地，本地临时服务启动、静态托管、首次登录和账单读写已验证；生产 SIGTERM 与卷权限仍待容器环境验证。
- 主进程备份 timer 已接入，临时服务日志已观察到 `backup_completed`；跨日调度与生产恢复演练仍待实测。
- 应用 14 天日志保留由主模型实现，本文只描述其与 Docker 日志的区别。
- 真实供应商代理链路、OpenAI 订阅授权、realseek / vm2api / DeepSeek 账号行为未验证。
