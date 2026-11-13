# 客户端插件：OpenCode v2 与 OpenChamber

项目名：**Moris LLMGateway**；OpenCode provider ID：`moris`。

两个包彼此独立，可单独安装；都只读网关，不写用户全局配置，也不接触网关以外的 provider。

| 包 | 目录 | 作用 |
| --- | --- | --- |
| `@moris/opencode-plugin` | `packages/opencode-plugin` | 在 OpenCode v2 中注册唯一的 `moris` provider，同步 `/api/catalog` |
| `@moris/openchamber-plugin` | `packages/openchamber-plugin` | 在 OpenChamber Work Status 中显示余额、额度窗口与美元估算 |

核对依据（2026-11-13）：

- `@opencode/plugin` **2.2.7**（`npm view`，并以 `npm pack` 的 `.d.ts` 核对 `Provider.Info`、`Model.Info`、`ctx.provider.transform`、`editor.models.set`、`ctx.provider.reload`、`ctx.session.hook("retry")`、`Provider.Settings.transport`）。
- `@openchamber/sdk` **2.7.1**（清单解析、`statusSection.source`、`GuestStatusView`、`contributes.service`、GUEST_SERVICES 契约）。
- 参考扩展 `oroszgy/openchamber-litellm-usage` 固定提交 `db61f312e2655d953a2dee2dbc768c79e2b9cc17` 的清单、`service/` 与 `status/` 读法（只作结构参考，不沿用其 LiteLLM 统计口径）。

---

## 1. OpenCode v2 插件

### 1.1 安装与配置

在 `opencode.json(c)` 的 `plugins` 中加入对象形式，以便传入 options：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@moris/opencode-plugin",
      "options": {
        "baseUrl": "https://gateway.example.com",
        "apiKey": "设备密钥"
      }
    }
  ]
}
```

插件只读取 options（真实 V2 ctx：`ctx.options`）：

| option | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | 必填 | 网关地址；带不带 `/v1` 都可以。目录读取用根地址，模型请求用 `<root>/v1` |
| `apiKey` | 无 | 设备 Bearer key；也可用服务端环境变量 `MORIS_GATEWAY_KEY` |
| `refreshIntervalMs` | `300000` | 目录刷新间隔，低于 60 s 会被抬回 5 分钟默认值 |
| `catalogTtlMs` | `86400000` | 供应商 `syncedAt` 起算的可用期，最低 60 s |
| `fetchTimeoutMs` | `15000` | 单次 `/api/catalog` 超时 |
| `headerTimeoutMs` | `120000` | 传给 provider 的 `settings.headerTimeout` |
| `chunkTimeoutMs` | `90000` | 传给 provider 的 `settings.chunkTimeout` |
| `requestTimeoutMs` | `900000` | 传给 provider 的 `settings.timeout` |

也可以用 `MORIS_GATEWAY_URL` 作为 `baseUrl` 的环境变量后备。**key 不写入缓存**：`ctx.storage` 里只有 `catalog/moris/v1` 目录快照，不含 options、key、Authorization 或网关地址。

### 1.2 注册范围

- 只注册一个 provider：`moris`；不新增、修改或删除其他 provider。
- 首次出现时 `editor.add` 一个 `moris` provider；已存在同名 provider 时：
  - `editor.update("moris", p => p.settings = { ...p.settings, ...配置 })`：`baseURL`、`transport: "http"`、`headerTimeout`、`chunkTimeout`、`timeout` 始终对齐插件配置，其他自定义键保留；
  - `editor.models.set("moris", 本次完整目录)`：**`moris` 命名空间完全由网关管理**。本次目录没有的旧同步模型会消失，用户也不能在该 provider 下混入自有模型（需要额外模型请用其他 provider）。因此上游删除/改名的模型不会残留。
- 设备 key 放在**每个模型**的 `headers.Authorization`，不动 provider 的 headers/credentials。
- 不使用 `ctx.integration`、不写 `opencode.json(c)`、不写 `auth.json`、不写用户全局配置。

### 1.3 模型同步

`GET /api/catalog`（`Authorization: Bearer <设备 key>`）经防御性校验后映射为 OpenCode `Model.Info`：

| 网关字段 | OpenCode v2 字段 | 说明 |
| --- | --- | --- |
| `id` / `path` | `id`、`modelID` | 业务模型 ID，去掉 `moris/` 前缀；含 `#`、空白或控制字符的 ID 不发布 |
| `name` | `name` | |
| `family` | `family` | 缺失时回退 `namespace` |
| `protocol` | 模型级 `package` | 见下表，一个 provider 内不同模型可用不同协议包 |
| `capabilities.tools` | `capabilities.tools` | |
| `capabilities.input` | `capabilities.input` | 仅 `text`/`image` |
| `capabilities.reasoning` | 不表达 | 2.2.7 的 `Model.Info` 解码会在运行时剥离该键；插件不发送它，避免假支持。推理控制通过 `variants` 同步 |
| `limit.context` / `output` / `input` | `limit.context` / `output` / `input` | 缺失的 context 或 output 会让模型不可选 |
| `variants` | `variants: [{ id, body }]` | 变体参数原样进入请求 body |
| `syncedAt` | 可用性判定 | 供应商最后完整成功时间，不是本地缓存时间 |
| `price` / `billingType` | `cost` | 见 1.4 |

协议 → 运行时包（官方 V2 包名）：

| `protocol` | 模型 `package` |
| --- | --- |
| `chat-completions` | `@opencode/ai/providers/openai-compatible` |
| `responses` | `@opencode/ai/providers/openai-compatible/responses` |
| `messages` | `@opencode/ai/providers/anthropic-compatible` |
| 其他/未知 | 不路由，模型发布为不可选 |

provider 级 `package` 只作为默认值；每个模型都带自己的 `package` 覆盖。provider `settings.baseURL` 指向 `<root>/v1`，因此三类包分别请求 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`。

### 1.4 价格映射

OpenCode 运行时 `Model.Cost` 的四个数（input/output/cache.read/cache.write）都是必填 `Finite`，没有 `null`/未知值；`Model.Info.default` 用 `cost: []` 表示“没有价格”。因此：

- `billingType === "subscription"`：`cost` 为一个全 0 tier。这只表示订阅请求不产生客户端 API 计价，不代表没有人民币实付。
- `billingType === "metered"`、`price.kind === "token"`、`currency === "USD"`，且 `input`、`output`、`cacheRead`、`cacheWrite` **四项齐全**：映射为真实 tier。
- 其余情况——`complex`、`request`（按次）、`unknown`、CNY 计价，或 token 价缺少任一金额：**模型仍可调用**，`cost: []`，名称追加“（价格见网关）”。不使用 0、Infinity 或“缺失 cache 回退输入价”之类的编造值。

`cost: []` 的语义边界（已核对 2.2.7 契约）：

- schema 允许空数组，`Model.Info` 解码通过；但客户端没有“价格未知”的展示位。会话累计在 `@opencode/client`（`shared-events` 中 `assistant.cost ?? 0` 求和）按 0 处理；`@opencode/ai` 的 usage 契约明确 `cost = 0` 表示“免费或订阅已覆盖”，缺失时才由调用方定价；`Model.Info.default` 自己就用 `cost: []`。因此 `cost: []` 不会被客户端显示为“复杂计价”，只会表现为没有价格/0；名称提示与本文档是唯一不会伪造数字的说明。完整计价与真实结算始终以网关后台为准。
- 若后续 SDK 提供显式的“未表达价格”字段，应改为该字段并去掉名称后缀。

### 1.5 缓存、TTL 与刷新

- 缓存写入 `ctx.storage` 键 `catalog/moris/v1`，内容只有 `{ v, savedAt, catalog }`。
- 可用性按**每条模型的供应商 `syncedAt` + `catalogTtlMs`（默认 24 h）**逐条判断。`savedAt` 只用于诊断，绝不延长供应商有效期；测试覆盖“缓存刚写入但 syncedAt 25 h 前”仍不可选。
- 每 5 分钟刷新一次；刷新失败保留最后一次成功目录。仍新鲜的模型继续可用，超过供应商 TTL 的条目在下一次 transform 重放时变为不可选。刷新失败也会 `ctx.provider.reload()` 重算 TTL，所以不会因为“没有新数据”而把过期条目一直留在可选状态。
- transform 在首次网络读取**之前**注册。没有本地缓存且配置了 key 时，setup 等待首次目录读取并总是调用 `ctx.provider.reload()`，确保初始目录真正重放（读取失败也重放空目录）；有缓存时注册即重放缓存，刷新在后台进行。
- 后台刷新与定时器不会产生未处理的 rejection：刷新/重放错误被记录；卸载时先置 disposed、`clearInterval`、中止进行中的请求，之后不再写 state/cache，再 `dispose()` retry hook 与 provider transform。timer 调用 `unref()`，不阻止 OpenCode 进程退出。
- 没有 key 时不启动刷新；provider 仍会注册，但请求无法授权，日志给出明确提示。

### 1.6 重试与 WebSocket

- 只注册一个 `ctx.session.hook("retry", ...)`，options 固定 `{ providerID: "moris" }`，回调再次校验 `event.model.providerID === "moris"` 后设置 `decision = { retry: false }`。
- retry hook 的真实契约没有 `kind` 字段；作用域是 provider/model，因此同一条 hook 覆盖 primary、title、compaction、generate 四类请求。网关自身负责上游 `maxAttempts`，OpenCode 不再重放（重放会重复计费/重复流式输出）。
- WebSocket 通过 provider `settings.transport: "http"` 关闭（官方 V2 契约中 `"http"` 明确禁用 WebSocket）；不注册任何 `experimental.ws.*` hook。provider 插件若注册 HTTP hook 本就会留在 HTTP，但本插件不依赖该副作用。

---

## 2. OpenChamber Work Status 插件

### 2.1 形态

`packages/openchamber-plugin/package.json` 的 `openchamber` 清单：

- `apiVersion: 1`，`engines.openchamber: ">=2.7.1"`；
- `contributes.panel`：**仅清单要求的身份**（`moris-gateway` / `Moris Gateway` / Remixicon `line-chart`），**没有 `entry`**。SDK 把无 `entry` 的 panel 当作 Settings/审批卡上的身份，不创建 rail 图标、页面或对话框；`hasGuestPage(manifest.contributes)` 实测为 `false`，`resolveStatusSectionEntry(...)` 为 `null`。因此不会出现用户未选择的独立面板。
- `contributes.statusSection.source`：`{ path: "/status", interval: 60000 }`，由宿主直接绘制原生行，不加载页面；
- `contributes.service`：`{ entry: "build/service/main.js", runtime: "host" }`，安装时该文件必须已构建。

选择 source 而非 iframe 的原因：Work Status 属于宿主紧凑原生区域，`GuestStatusView` 的 line/bar/note 行直接使用宿主主题、字号与间距，视觉与 SDK 一致；同时页面里没有 key 可泄露。代价是宿主必须支持 `statusSection.source`（2.7.1 已支持），更老版本不会显示该 section。

### 2.2 构建与安装

```bash
npm install
npm run build --workspace=@moris/openchamber-plugin   # tsc -> build/service/*.js
```

包内已提交构建后的 `build/service/*.js`，因此也可以直接把文件夹（或 zip：`package.json` + `build/`）交给 OpenChamber 的 Settings → Extensions。安装后需要批准扩展并允许其本地 service；service 首次被读取时由宿主启动，空闲 10 分钟后由宿主停止。

Service 契约（GUEST_SERVICES）：

- 只监听 `127.0.0.1`，端口/令牌来自 `OPENCHAMBER_SERVICE_PORT` / `OPENCHAMBER_SERVICE_TOKEN`；
- 每个路由（含 `/health`）都要求 `Authorization: Bearer <host token>`，使用定时安全比较；
- `GET /health` → 200；`GET /status` → `GuestStatusView`；`POST /status` → 405（本 section 没有 controls）；其他 404；
- 不读请求 body、不设 CORS、返回 `cache-control: no-store`。

### 2.3 配置与 key 保管

Service 进程不继承 OpenCode/宿主的环境密钥。它按以下顺序找网关地址与设备 key：

1. `{OPENCHAMBER_SERVICE_DATA_DIR}/config.json`：`{ "baseUrl": "https://gateway.example.com", "apiKey": "设备密钥" }`（显式覆盖，文件缺失则继续下一步；存在但损坏会显示明确错误，不会静默当成“未配置”）。建议把该文件权限收紧到仅当前用户可读。
2. OpenCode 配置（与 OpenCode 自身相同的层级，后读覆盖先读）：
   - 全局 `~/.config/opencode/opencode.json(c)`（或 `$XDG_CONFIG_HOME` / `$OPENCODE_CONFIG_DIR`）；
   - 当前项目 `opencode.json(c)`、`.opencode/opencode.json(c)`（目录由 section 的 `directory` 查询参数传入）；
   - `$OPENCODE_CONFIG`，否则 OpenChamber 托管的 `~/.config/openchamber/opencode.managed.json(c)`。
   - 识别两种写法：`providers.moris`（`settings`/`options` 的 `baseURL` + `apiKey`），以及 `plugins` 中本插件的 `options.baseUrl`/`apiKey`（即 1.1 的同一份配置，无需重复填写）。
   - 支持 `{env:NAME}` 与 `{file:path}` 引用。
3. `auth.json` 的 `moris.key`（内联 key 缺失时）。

key 只存在于 service 进程内存与读取时；`/status` 的响应只含渲染行，不含 key、网关 URL、Authorization 或原始响应体。错误信息会截断并脱敏 `Bearer ...`。没有任何 frame 能读取它（本包不加载页面）。若 service 配置中无 key，section 显示可操作的配置提示，而不是零余额。

注意：service 环境由宿主裁剪，`OPENCODE_CONFIG_DIR` 等自定义变量通常不会传入；需要自定义路径时请用 `config.json`。

### 2.4 展示内容

严格限定为四类：

- **余额**：账户名（多账户时作前缀）、原始币种与可选单位，如 `$12.50`、`12.50 CNY`；tooltip 说明这是供应商账户口径，可能包含网关外使用。
- **额度窗口**：`line + bar`，百分比取 `usedRatio`，值文本包含重置时间（Asia/Shanghai，`MM/DD HH:mm`）；>=80% 警告色、>=95% 错误色。
- **美元等价估算**：`总额 $x · 剩余 $y`，标签带“估算”，tooltip 注明“基于本网关记录，不是官方额度”；不可用时显示“不可用”并给出原因，不伪造数字。
- **数据更新时间与状态**：`正常 / 未知 / 过期 / 获取失败` 四态，展示最新 `sampledAt`（没有则本地读取时间），tooltip 给出本地读取时间；多账号时每个账号第一行带自己的状态 badge，避免一个账号失败被另一个账号的正常状态掩盖。

明确不展示：实付金额、账单、请求明细、本网关消费、套餐标价、`spentUsd`（即使响应里有也不渲染）、管理入口。`planPrice`、`bills`、`requests` 完全不读。

状态判定：

- `monitor.state` 原样映射；`unsupported` 归为“未知”；
- 尚无样本的账号（`state: "unknown"`、`sampledAt: ""`）**保留**，显示“未知”，不会因空时间戳被过滤掉；空 `sampledAt` 的窗口同样保留；
- `state === "ok"` 但 `sampledAt` 超过 6 分钟（`DEFAULT_SETTINGS.balanceStaleMs`）→ 过期；
- 网关读取失败但已有上次成功数据 → 保留数据并标“过期”，附错误 note；从未成功 → 显示“获取失败”和配置/网络提示，不显示 0；
- 最多 16 行（SDK 上限），超出时截断并提示；末尾固定一条口径说明。

### 2.5 刷新与去重

- section 可见且展开时，宿主按 `interval: 60000` 读取 `GET /status`；隐藏/折叠即停止。
- service 内部对成功读取做 **按 directory 隔离的 60 s TTL + single-flight**：同一目录上的多个客户端/多台设备共享一次网关读取，并发的 `/status` 复用一个上游请求；不同目录各自读取自己的配置与额度，绝不串用。缓存表是 bounded LRU（最多 32 个目录），满载时淘汰最久未用项。
- 上游失败不缓存失败结果；下一次读取会重试，同时继续提供上次成功数据并标 stale。
- 网关侧 `/api/quota` 由服务器状态提供，客户端不在本插件里触发供应商刷新。

---

## 3. 已知限制与未验证项

**已验证**

- 两个包的 TypeScript 在真实 `@opencode/plugin@2.2.7` / `@openchamber/sdk@2.7.1` 类型下通过（含 `Model.Info`、`Provider.Info`、`GuestStatusView` 的赋值检查）。
- 运行时契约已核对：`Model.Info` 的 Effect schema 解码会剥离 `capabilities.reasoning`（实测），因此插件不发送该字段；`cost: []` 可被 `Model.Info` 解码（`Model.Info.default` 本身就用空数组）；OpenChamber 清单用 `@openchamber/sdk/schemas` 的 `parseManifest` 解析通过，且 `hasGuestPage` 为 `false`、`statusSection` 只有 source 无 entry；`/status` 的 `GuestStatusView` 用 `guestStatusViewSchema` 运行时校验通过。
- 两个包 `npm pack --dry-run` 只含 `build/`、`package.json`、`README.md`；`exports` 与 OpenChamber `service.entry` 都指向实际构建产物，不依赖仓库外相对源码。
- `tests/clients.test.ts`：缓存 TTL、只 `moris` 重试、协议包映射、价格无法表达时仍可调用且 `cost: []`、key/URL/Authorization 不入缓存、guest 视图不含敏感字段、60 s 缓存与 single-flight、service bearer 与 HTTP 行为、清单与构建入口存在；并新增运行时回归：首启无缓存必 `reload`、上游移除的模型消失、已有 provider settings 全量对齐、刷新/重载异常不产生未处理 rejection、按 directory 隔离的配置/额度/缓存、`sampledAt: ""` 的 unknown 账号保留。
- OpenChamber service 已在本机以真实 HTTP 绑定 `127.0.0.1` 跑通（测试内），但**未在真实 OpenChamber 宿主中安装运行**；OpenCode 插件也**未在真实 OpenCode 服务中加载**。

**未验证 / 限制**

- 真实宿主未验证：未执行 `openchamber-guest-check`、未在 OpenCode 2.2.7 进程中加载插件、未验证目录热更新在选择器中的实际刷新时机。
- `@opencode/plugin@2.2.7` 的 `Model.Info` 运行时会剥离 `capabilities.reasoning`（`/docs/models` 已文档化 models.dev v2 形态，但该版本 schema 没有对应字段）。插件**不发送**该键，避免假支持；可移植的推理控制以同步的 `variants` 为准。
- 复杂、按次、未知、CNY 价格以及缺少任一金额的 token 价无法在 OpenCode 的 `Model.Cost` 中表达。模型保持可调用，`cost: []` 并追加“（价格见网关）”；客户端没有“未知价格”展示位，只能表现为无价格/0，不能据此认定免费。SDK 若新增未表达字段应迁移。
- `moris` provider 的模型清单完全由网关管理：上游删除的模型会从客户端目录消失；不要把自有模型加进 `moris`，请另建 provider。
- 订阅 `cost = 0` 只影响客户端统计，不代表没有人民币实付。
- 无 iframe 页面：不支持 `statusSection.source` 的旧宿主不会显示该 section（engines 已要求 `>=2.7.1`）。
- 配置文件发现依赖 OpenCode 的默认目录与环境变量；自定义 `OPENCODE_CONFIG_DIR` 未传入 service 时需使用 `config.json`。
- 60 s 缓存按“一个 OpenChamber 实例 + 一个 directory”生效；同一目录共享，不同目录隔离。若三台设备各自运行独立 OpenChamber，每个实例各读一次网关。
- 设备 key 的请求头按 `docs/API.md` 使用 `Authorization: Bearer`；真实网关的 401/403 行为需联调确认。
- 根 `npm run typecheck` 目前会被并行开发的 `tests/core.test.ts` 中与本包无关的错误阻断；本包文件的类型检查通过（`packages/opencode-plugin` 需在根 `npm install` 后运行 `npm run typecheck --workspace=@moris/opencode-plugin`）。

---

## 4. 依赖与构建建议（给主模型）

- 根 `npm install` 会自动纳入 `packages/*` workspace：
  - `@moris/opencode-plugin` 运行依赖 `@opencode/plugin@2.2.7`；`npm run build --workspace=@moris/opencode-plugin` 用 `tsc` 输出到 `build/`，`exports["."]` 指向 `build/index.js` / `build/index.d.ts`；OpenCode 从包根加载该产物，不读取 TypeScript 源码。
  - `@moris/openchamber-plugin` **零运行时依赖**（只用 Node 内置模块），devDependencies 为 `typescript`、`@types/node`；`npm run build --workspace=@moris/openchamber-plugin` 输出 `build/service/main.js`，与清单的 `contributes.service.entry` 一致。
- 两个包都使用 `build/` 而不是 `dist/`：根 `.gitignore` 忽略所有 `dist/`，`build/` 能随包提交。两个包都声明了 `prepack: npm run build`；`npm pack --dry-run` 只包含 `build/`、`package.json` 与 `README.md`，没有仓库外相对源码或 workspace 私有包。
- 根 `npm run build` 会按集成约定分别调用上面两个 workspace 的 `build`；根 `tsconfig.build.json` 不包含客户端包，避免把 OpenCode SDK 类型带进网关构建。`typecheck` 也各自独立执行。
