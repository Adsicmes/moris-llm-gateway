# 供应商插件实现说明

日期：2026-11-13
状态：已实现独立插件包与固定响应测试；**未对真实账号执行认证、付费请求或额度查询**。

本文记录 `packages/providers/**` 的实现依据、凭据字段、行为边界和仍需目标实例验证的事实。产品需求见 `docs/PRD.md`。

## 1. 交付范围

| 目录 | 包名 | 默认导出 | 说明 |
| --- | --- | --- | --- |
| `packages/providers/realseek` | `@moris/provider-realseek` | `ProviderPlugin` | New API 兼容站点（realseek 及其它 New API 实例） |
| `packages/providers/deepseek` | `@moris/provider-deepseek` | `ProviderPlugin` | DeepSeek 官方 API |
| `packages/providers/vm2api` | `@moris/provider-vm2api` | `ProviderPlugin` | vm2api 自定义实例 |
| `packages/providers/openai-subscription` | `@moris/provider-openai-subscription` | `ProviderPlugin` | OpenAI ChatGPT 订阅（OAuth 凭据 + Responses） |

每个包：

- `private: false`，`type: "module"`。
- `main` 与 `exports["."]` 指向 `./dist/index.js`，`files: ["dist"]`，供独立打包；`src/index.ts` 由主工程 `npm run build:providers`（esbuild）生成该文件。
- `@moris/provider-sdk` 放在 `devDependencies`；插件运行时使用的 `ProviderError`、`apiUrl`、`protocolPath` 已复制为各包内 `src/runtime.ts`，bundle 后 `dist/index.js` 不 import 包外源码。
- 暂未生成 `dist/index.d.ts`；如需 `types`，由主构建另行产出，避免指向不存在的文件。
- `src/index.ts` 同时提供 `default` 和命名导出 `plugin`，满足核心 `import plugin from ...`。
- 仅类型依赖 `@moris/provider-sdk`（`devDependencies`）；运行时 helpers 在各包本地 `src/runtime.ts`，核心不会直接 import 某个供应商实现。

共同约束：

- 所有上游请求使用注入的 `ctx.fetch`，带 `ctx.signal`；插件内部不重试。
- `prepare` 只接受与 `model.protocol` 相同的协议，只替换 `body.model` 为 `upstreamModel`，并删除客户端顶层 `authorization`、`api_key`、`base_url`、`url` 等字段；URL 由插件按账号 `baseUrl` 构造，绝不透传客户端 URL。
- `discover` 在无法完成关键读取时抛错，让核心保留旧目录；不会用空数组清目录。
- 未知或不支持的余额、额度、价格返回空值或 `unknown`/`error`，不返回假零。
- `monitor` 的 `sampledAt` 使用 `ctx.now()`；时间均为 ISO 8601，窗口重置时间来自上游原值。

## 2. realseek / New API 兼容插件

### 2.1 真实接口依据

只读取证得到：

- `GET https://newapi.example.com/api/status`：New API 风格 `{success,data}`；观察到 `quota_per_unit: 500000`、`quota_display_type: "USD"`、`version: "<上游版本>"`、`system_name: "<站点名称>"`。状态页当前还显示 `usd_exchange_rate`，但插件不把站点汇率当作人民币实付。
- `GET https://newapi.example.com/api/pricing`：观察到 `data[]`、`group_ratio`、`vendors`、`supported_endpoint`、`pricing_version`。模型字段包含 `model_name`、`quota_type`、`model_ratio`、`model_price`、`completion_ratio`、`cache_ratio`、`create_cache_ratio`、`enable_groups`、`supported_endpoint_types`；部分模型包含 `billing_mode: "tiered_expr"` 与 `billing_expr`。公开结果包含全站分组，不能证明目标账号可用分组。

实现对照的 New API 源码：

- `controller/pricing.go`：`/api/pricing` 会按登录用户可用分组过滤；未认证请求不是账号权限目录。
- `common/page_info.go`：令牌分页为 `{page,page_size,total,items}`，支持 `p`、`size`。
- `controller/token.go`：`GET /api/token/?p=&size=`、`GET /api/token/:id/key`、`POST /api/token/`；新增令牌字段 `name`、`unlimited_quota`、`expired_time`、`remain_quota`、`allow_ips`、`model_limits_enabled`、`model_limits`、`group`、`cross_group_retry`。
- `model/pricing.go`、`setting/ratio_setting/model_ratio.go`：倍率价格换算与分组倍率。
- `pkg/billingexpr/expr.md`：`tiered_expr` 系数是真实 `$/1M tokens`；`fixed(n)` 是每请求美元价；支持 `p/c/cr/cc/cc1h/cc12h/len`、`tier()`、`param()`、时间函数等。

### 2.2 凭据与选项

`secrets`：

| 键 | 必需 | 用途 |
| --- | --- | --- |
| `accessToken` | 是（目录） | 管理接口；没有它不能确认账号分组权限，插件返回空目录且 `complete=false` |
| `userId` | 建议 | New API `New-API-User` 兼容头；缺失时尝试从 `accessToken` JWT 的 `id`/`sub` 解析 |
| `apiKey` | 可选 | 推理兜底；只有 `options.apiKeyGroup` 与当前分组相同时才使用 |
| `token:<group>` | 自动/手动 | 每个分组的推理令牌；与模型 `credentialKey` 一一对应 |

`account.options`：

| 键 | 说明 |
| --- | --- |
| `apiKeyGroup` | 声明 `secrets.apiKey` 所属分组；模型 `credentialKey` 写 `apiKey` |
| `quotaPerUnit` | `/api/status` 缺失时的显式兜底；不会猜站点单位 |
| `allowUserTokens` | 默认 `false`；仅在设为 `true` 时允许使用名称不匹配管理模板的用户令牌 |
| `managedTokenPrefix` | 管理令牌名前缀；未设置时用 `tokenTemplate.namePrefix`，用于识别本网关管理的令牌 |
| `modelOverrides` | 按模型名（或 `group/model`）补全上下文、输出、工具、输入媒体、family、protocol、variants；来源写入 `sources.models` |
| `modelsDev` | `true` 时才读取 `https://models.dev/api.json`，并要求模型 id 精确且唯一匹配；不覆盖供应商限制 |
| `modelsDevUrl` / `modelsDevProvider` | 自定义 models.dev 地址或指定 provider id |

凭据优先级：`secrets["token:<group>"]`（显式）→ 名称匹配 `managedTokenPrefix`/`tokenTemplate` 的管理令牌 → `allowUserTokens=true` 时才使用该分组其它令牌 → `apiKeyGroup` 对应的 `secrets.apiKey`。`model.credentialKey` 写实际使用的 secrets 键（`token:<group>` 或 `apiKey`），`prepare` 按它取凭据。账号 `/api/user/self/groups`（或 `/api/user_group_map`）是分组权限唯一来源；令牌/secret 只提供凭据，不授予分组。

### 2.3 发现流程

1. 先检查 `secrets.accessToken`；没有则直接返回空目录与警告，不请求公开 `/api/pricing`。
2. 读取 `/api/status` 得到 `quota_per_unit`（或显式 `options.quotaPerUnit`）。
3. 用管理凭据读取 `/api/pricing`，保留 `group_ratio`、`vendors`、`pricing_version`。
4. 读取 `/api/user/self`，再读取 `/api/user/self/groups`；失败时尝试 `/api/user_group_map`。两者都失败则抛错，拒绝用公开目录冒充账号目录。
5. 分页读取 `/api/token/?p=N&size=100`，直到 `total` 覆盖或末页不足一页；分页不完整时 `complete=false`。
6. 账号可用分组是权限唯一边界：只保留 `enable_groups` 与该集合交集的模型；令牌分组/`token:<group>` secret 不参与授权，删组后不会借助缓存凭据复活旧路径。路径为 `分组/模型名`，因此 `realseek/group-c/gpt-...` 等分组身份不丢失。
7. 支持端点映射：优先 `openai` → `chat-completions`，其次 `openai-response` → `responses`，再次 `anthropic` → `messages`；其它端点（图片、视频等）跳过并记录警告。
8. 关键参数（上下文、最大输出、工具能力）缺失时保留 `null`/`false` 占位，`enabled=false` 并写 `disabledReason`；只有显式覆盖或 models.dev 精确匹配才补全。
9. 价格未知（缺 `group_ratio`、未知 `quota_type` 或表达式无法归一）不自动禁用模型：保留 `price.kind="unknown"`、表达式和来源，`estimate` 返回 `null`，并写入 warnings；调用可用性与估算可用性分开。

### 2.4 价格

倍率计价（`quota_type=0`）：

```text
输入 USD/1M = model_ratio * 1,000,000 / quota_per_unit * group_ratio
输出 USD/1M = 输入 * completion_ratio
缓存读取   = 输入 * cache_ratio（缺省按 New API 运行时 1 倍）
缓存写入   = 输入 * create_cache_ratio（缺省按 New API 运行时 1.25 倍）
```

按次计价（`quota_type=1`）：

```text
perRequest = model_price * group_ratio
```

`referencePrice` 保留不含 `group_ratio` 的同规则价格，用于 API 等价参考；`price` 是账号分组实际适用的价格。没有分组倍率时 `price.kind="unknown"`、保留表达式/来源并写入 warnings，但**不因此禁用模型**；不按 1 倍猜测。

`tiered_expr`：

- 保留完整原表达式在 `Price.expression`。
- 有 `group_ratio` 时实际 `price` 为 `(${原表达式}) * ${group_ratio}`，`referencePrice` 为原表达式；缺 `group_ratio` 时 `price.kind="unknown"`，保留表达式供排查。
- `estimate` 使用自实现的有界解析器，不执行任意 JS/eval。
- 支持的变量：`p`、`c`、`cr`、`cc`、`cc1h`、`cc12h`、`len`、`image_count`；函数：`tier`、`fixed`、`param`、`max`、`min`、`abs`、`ceil`、`floor`。`fixed(n)` 按上游语义放大 `1e6`，最终统一除以 `1e6` 得到 USD。
- 遇到 `hour`/`weekday`/`header`/`u()`、图像/音频 token 或无法拆分的缓存 TTL 时，`estimate` 返回 `null`，保留表达式与来源，不简化成假单价。
- 未知函数、未知变量、非法表达式一律不执行。

### 2.5 自动创建令牌

- 默认关闭：只有 `account.autoCreateTokens === true` 才创建。
- 开启时必须提供完整 `tokenTemplate`：非空 `namePrefix`、非负 `quota`（USD）、整数 `expiresInDays`；不完整时抛错，不猜默认值。
- 令牌名：`${namePrefix}-${group}`，最多 50 字符。
- `quota` 按 USD 解释，创建时转换为 `remain_quota = round(quota * quota_per_unit)`；`unlimited=true` 时 `remain_quota=0`。
- `expiresInDays=0` 写入 `expired_time=-1`（永不过期）；否则为当前时间加天数。
- 先按 `name + group` 复用已有令牌；同名不同分组时跳过并警告，避免修改用户令牌。同名但已禁用的令牌不复用、也不创建同名替代，记录警告等待人工处理。
- 已显式配置 `secrets["token:<group>"]` 时优先使用它，不读取/覆盖该分组的管理令牌或用户令牌。
- 未显式配置时，只选名称匹配 `managedTokenPrefix`/`tokenTemplate` 的管理令牌；其它用户令牌仅在 `options.allowUserTokens=true` 时使用。
- 只 `POST /api/token/`，不调用 `PUT`/`DELETE`；创建后重新分页读取并通过 `GET /api/token/:id/key` 取回完整 key。
- 新 key 通过 `ctx.updateSecrets({ "token:<group>": key })` 增量持久化。

### 2.6 余额与限制

`monitor` 读取 `/api/user/self`，把 `quota / quota_per_unit` 作为 USD 账号额度；`used_quota` 只写入说明，不当成本网关扣费。余额包含网关外使用。读取失败返回 `state=error`，不返回 0。

仍需目标实例验证：

- 目标账号实际可用分组、令牌分组与 `enable_groups` 是否一致。
- `/api/token/:id/key` 在目标 New API 版本是否存在；不存在时只能使用已提供的完整 key。
- 分组改名/删除、令牌上限、自动创建权限和 `expiresInDays` 语义。
- `pricing_version` 是否随价格更新，历史账本需自行保存版本快照。
- 目标站点的 `quota_per_unit` 是否始终为 500000；插件不硬编码该值。
- models.dev 对目标模型是否精确唯一匹配；否则必须用 `modelOverrides`。

## 3. DeepSeek 官方插件

### 3.1 真实接口依据

- `GET https://api-docs.deepseek.com/api/list-models`：`GET /models` 返回 `id`、`name`、`context_window`、`max_output_tokens`、`input_modalities`、`output_modalities`、`effort.supported_levels/default_level`、`api_capabilities`。
- 当前文档模型：`deepseek-flash`（DeepSeek-V4.1-Flash-1017，1M 上下文、384K 输出、文本+图片输入）与 `deepseek-v4-pro`（DeepSeek-V4-Pro-0813，1M 上下文、384K 输出、文本输入）。
- `GET https://api-docs.deepseek.com/api/get-user-balance`：`GET /user/balance` 返回 `is_available` 和 `balance_infos[]`（`currency`、`total_balance`、`granted_balance`、`topped_up_balance`，金额为字符串）。
- 价格页：每 1M token，缓存命中/未命中/输出分别计价；高峰价为标准价，低谷价为高峰价一半；高峰为 UTC 周一至周五 01:00-04:00 与 06:00-10:00，排除中国法定节假日。

当前写入插件的价格（USD / 1M tokens）：

| 模型 | 高峰缓存命中 | 高峰缓存未命中 | 高峰输出 | 低谷 |
| --- | ---: | ---: | ---: | --- |
| `deepseek-flash` | 0.006 | 0.30 | 1.20 | 全部减半：0.003 / 0.15 / 0.60 |
| `deepseek-v4-pro` | 0.044 | 1.32 | 3.96 | 全部减半：0.022 / 0.66 / 1.98 |

### 3.2 行为

- 凭据：`secrets.apiKey`。
- 目录：`GET {baseUrl}/models`，地址默认 `https://api.deepseek.com`；限制、媒体能力、推理档位来自响应。
- `price.kind = "complex"`，完整规则保存在 `Price.expression`，来源与版本写入。
- `estimate` 返回 `null`：`estimate(price, usage, body)` 契约没有当前时间与节假日表，插件拒绝猜测。需要账本计算时使用命名导出：

```ts
deepSeekCost(now, modelId, usage, { isChinesePublicHoliday })
```

该函数严格区分高峰/低谷，并按 `usage.input` 包含缓存 token 的契约处理缓存读写。

- `prepare` 支持 `chat-completions`、`responses`、`messages`；messages 使用 `{baseUrl}/anthropic/v1/messages`，chat 使用 `{baseUrl}/chat/completions`，responses 使用 `{baseUrl}/responses`。
- 变体：`low`/`high`/`max` 写入 `reasoning_effort`，另提供 `non-thinking: { thinking: { type: "disabled" } }`（依据官方 thinking 文档）。
- 余额：返回每个 `balance_infos` 的 `total_balance`，currency 保留 `CNY`/`USD`；`is_available=false` 仍显示余额并给出说明，不伪造零。

仍需验证：目标账号的 `/models` 实际响应、余额币种、低谷/节假日边界，以及 `deepseek-v4-pro` 是否对所有账号开放。

## 4. vm2api 插件

### 4.1 真实源码依据（固定提交）

固定提交：`d0bfe3068f29a8e3f85a0dffdf3c8d36c39f8b00`。

- `src/lib/protocol/models.mjs`：`GET /v1/models` 按 API key 的 `group_type`（`openai`/`anthropic`/`all`）返回可调度模型；条目包含 `id`、`display_name`、`family`、`owned_by`、`enabled`、`capabilities`、`source`。
- `src/server.mjs`：`/v1/meta` 列出 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/me/quota`、`/v1/me/usage`、`/v1/models`。
- `src/lib/protocol/key-self.mjs`：`GET /v1/me/quota` 只适用于托管 Key（`sk-vm-…`），返回 `{object:"api_key_quota",checked_at,key,usd,windows,requests,rpm,concurrency,blocked_by}`；`usd`/`windows.*` 都是 USD 消费限额，不是请求次数。
- `src/lib/admin/api-keys.mjs`：`windows` 为 `5h`/`1d`/`7d`，每项含 `limit`、`used`、`remaining`、`window_start`、`reset_at`；`limit=0` 表示无上限，`limitView` 会把 `limit` 置为 `null`。
- `src/lib/admin/pricing.mjs`：vm2api 请求成本来自本地 `price-catalog`/models.dev 同步；`/v1/models` 本身不返回价格。

### 4.2 行为

- 凭据：`secrets.apiKey`（托管 Key 或主密钥；主密钥没有 `/v1/me/quota` 的 Key 额度）。
- 目录：`GET {baseUrl}/v1/models`，保留 `id`/`display_name`/`family`/`owned_by`/`capabilities`，协议选择：
  - `family=codex`、`openai` 或 `codex-*`/`gpt-*`/`o*` → `responses`
  - `claude*`/`owned_by=anthropic` → `messages`
  - 其它 → `chat-completions`
- 价格：`/v1/models` 不提供价格，默认 `price.kind="unknown"`，但**不因此禁用模型**；保留调用并写 warning，`estimate` 返回 `null`。用 `options.priceOverrides[model]` 或 `options.modelOverrides[model].price` 显式补全。
- 参数：上下文、输出、工具能力缺失时 `null`/`false` + `enabled=false`；可用 `options.modelOverrides`，或在 `options.modelsDev=true` 时按精确唯一 models.dev 匹配补全。
- `prepare`：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`，Bearer 凭据，messages 额外发送 `x-api-key` 与 `anthropic-version`。
- `monitor`：
  - `usd.limit` 有上限时，只有 `remaining` 存在，或 `used` 存在可算 `limit-used`，才返回 USD 剩余余额；两者都缺失时返回 `state="unknown"` 并说明，不按 `used=0` 返回全余额。无上限时不返回余额。
  - `5h`/`1d`/`7d` 中有 `limit > 0` 且 `reset_at` 有效、`used` 存在时才输出窗口；`used` 缺失不按 0 计算，跳过该窗口并置 `state="unknown"`。`usedRatio=used/limit`。
  - 窗口 `pool` 由 `options.quotaPool` 配置，默认 `"default"`（本账号绑定该 Key，Key 自报窗口可视为账号通用窗口）；如果实际部署不是“一账号一 Key”，应显式设置为独立池。
  - 请求数上限不是时间窗口；`request.used` 缺失时只说明“已用未知”，不填 0。
  - 读取失败返回 `error`，不返回零额度。
- `estimate`：只对显式 token/request 价格计算；unknown 返回 `null`。

仍需目标实例验证：版本是否含 `/v1/me/quota`、Key 分组与 `allowed_models` 实际过滤、`group_type`、USD 限额语义、面板价格目录与本插件 `priceOverrides` 的对应关系。

## 5. OpenAI 订阅插件

### 5.1 真实源码依据

OpenAI Codex 公开源码（`openai/codex` main，2026-11-13 读取）：

- `codex-rs/login/src/auth/manager.rs`：`CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`，刷新地址 `https://auth.openai.com/oauth/token`，ChatGPT refresh 使用 JSON（不是 form），字段 `grant_type=refresh_token`、`client_id`、`refresh_token`、可选 `refresh_reason`。
- `codex-rs/login/src/server.rs`：授权地址 `{issuer}/oauth/authorize`，issuer 默认 `https://auth.openai.com`；浏览器回调 `http://127.0.0.1:1455/auth/callback`；scope 为 `openid profile email offline_access api.connectors.read api.connectors.invoke`；PKCE S256。
- `codex-rs/login/src/device_code_auth.rs`：`POST {issuer}/api/accounts/deviceauth/usercode`（JSON `client_id`）→ `device_auth_id`/`user_code`/`interval`；用户访问 `{issuer}/codex/device`；轮询 `POST {issuer}/api/accounts/deviceauth/token`（JSON `device_auth_id`/`user_code`），`403`/`404` 为 pending；成功后以表单 `POST {issuer}/oauth/token`（`authorization_code`、`client_id`、`code`、`redirect_uri={issuer}/deviceauth/callback`、`code_verifier`）。
- `codex-rs/login/src/token_data.rs`：从 JWT 的 `https://api.openai.com/auth` 读取 `chatgpt_account_id`、`chatgpt_plan_type`、`chatgpt_user_id`。
- `codex-rs/model-provider/src/bearer_auth_provider.rs`、`codex-rs/http-client/src/openai_headers.rs`：请求头 `Authorization: Bearer <access_token>` 与 `chatgpt-account-id`。
- `codex-rs/model-provider-info/src/lib.rs`：ChatGPT Codex base URL `https://chatgpt.com/backend-api/codex`。
- `codex-rs/codex-api/src/endpoint/models.rs`：模型目录 `GET {base}/models?client_version=...`，响应 `{models:[...]}`。
- `codex-rs/codex-api/src/endpoint/responses.rs`：推理 `POST {base}/responses`；`codex-rs/core/src/client.rs` 构造的 `ResponsesApiRequest` 固定 `store: false`、`stream: true`，且不发送 `max_output_tokens`。
- `codex-rs/backend-client/src/client/rate_limit_resets.rs`、`.../rate_limit_status_payload.rs`、`.../rate_limit_window_snapshot.rs`：额度 `GET https://chatgpt.com/backend-api/wham/usage`；窗口字段 `used_percent`、`limit_window_seconds`、`reset_after_seconds`、`reset_at`（秒）；另有 `credits`、`plan_type`、`additional_rate_limits`。

### 5.2 凭据与 OAuth 边界

`secrets`：

| 键 | 说明 |
| --- | --- |
| `accessToken` | ChatGPT OAuth access token；JWT 的 `exp` 用于判断是否需要刷新 |
| `refreshToken` | 刷新令牌；缺失且 access token 过期时插件明确抛错 |
| `accountId` | `chatgpt-account-id`；缺失时从 id_token/access token 的 `chatgpt_account_id` 解析 |
| `idToken` | 可选，用于解析账号与套餐 |
| `expiresAt` | 可选 ISO 时间 |
| `planType` | 可选，套餐标识 |

`account.options`：`clientId`（默认官方常量）、`issuer`（默认 `https://auth.openai.com`，device flow 用）、`tokenUrl`（默认官方刷新端点）、`clientVersion`（默认 `0.1.0`，建议按目标 Codex 客户端版本配置）、`modelsDev`（默认开启，可用 `false` 关闭）、`modelsDevProvider`、`modelsDevUrl`、`planPrice`。

**已实现 Linux 远程可用的 device authorization flow**，导出给主模型的管理员 API 调用：

```ts
startDeviceAuthorization(ctx: ProviderContext): Promise<DeviceAuthorizationStart>
pollDeviceAuthorization(
  ctx: ProviderContext,
  input: { deviceAuthId: string; userCode: string; intervalSeconds?: number },
): Promise<DeviceAuthorizationPoll>
// 也兼容 (ctx, deviceAuthId, userCode, intervalSeconds?) 位置参数

// OpenAI 插件的 ProviderPlugin 还暴露：
plugin.authorization = { start: startDeviceAuthorization, poll: pollDeviceAuthorization }
```

返回结构：

```ts
interface DeviceAuthorizationStart {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string; // https://auth.openai.com/codex/device
  intervalSeconds: number;
  expiresAt: string;       // 15 分钟
  clientId: string;
}
type DeviceAuthorizationPoll =
  | { state: 'pending'; intervalSeconds: number; message: string }
  | { state: 'complete'; accountId: string; planType?: string; email?: string; expiresAt: string };
```

真实流程（严格对照 Codex 源码，不伪造返回）：

1. `POST https://auth.openai.com/api/accounts/deviceauth/usercode`，JSON `{client_id}`；响应含 `device_auth_id`、`user_code`（兼容 `usercode`）、`interval`（字符串）。
2. 让用户打开 `https://auth.openai.com/codex/device` 并输入一次性代码；代码 15 分钟内有效。
3. 管理员 API 按 `intervalSeconds` 调用 `POST https://auth.openai.com/api/accounts/deviceauth/token`，JSON `{device_auth_id,user_code}`。Codex 约定 `403`/`404` 为 pending；成功返回 `authorization_code`、`code_challenge`、`code_verifier`。
4. 插件用表单 `POST https://auth.openai.com/oauth/token`：`grant_type=authorization_code`、`client_id`、`code`、`redirect_uri=https://auth.openai.com/deviceauth/callback`、`code_verifier`。
5. 换得 `access_token`/`refresh_token`/`id_token` 后，从 JWT 的 `https://api.openai.com/auth` 读取 `chatgpt_account_id`，并通过 `ctx.updateSecrets` 保存 `accessToken`、`refreshToken`、`accountId`、`idToken`、`expiresAt`、`planType`。

约束：

- `startDeviceAuthorization` 只返回上游事实；`pollDeviceAuthorization` 单次轮询，不在函数内 sleep；超时/调度由管理员 API 控制。
- `deviceAuthId` 和 `userCode` 是短期登录状态，建议由管理员 API 保存在自己的会话状态，不写入长期 `secrets`。
- 该流程不需要 localhost 回调，适合 Linux 远程服务器。
- 浏览器 PKCE 登录仍未实现；如果目标 issuer 只支持 localhost 回调，需要另行实现登录辅助 CLI（回调地址与 scope 见上文 Codex 证据）。
- 仍有 refresh token 刷新：把轮换后的 token 通过 `ctx.updateSecrets` 持久化。
- 没有 refresh token/access token 且未完成 device flow 时抛 `oauth_login_required`，不声称认证成功。

### 5.3 模型、价格与监控

- 模型目录：`GET {baseUrl}/models?client_version=...`，过滤 `supported_in_api=false` 和 `visibility != "list"`；协议固定 `responses`。
- 上下文/输出：优先 `context_window`/`max_output_tokens`；缺失时用 models.dev 精确 `openai` provider 的 `limit`。工具能力来自 `supports_parallel_tool_calls`/`tool_mode`/models.dev `tool_call`；仍未知则 `enabled=false`。
- `prepare`：固定 `store=false`、`stream=true`（Codex Responses 请求契约），删除 `max_output_tokens`/`max_tokens`/`max_completion_tokens`，返回 `responseFormat="sse"`。非流式客户端由核心聚合 `response.completed.response`；流式客户端继续直通。插件不隐瞒这一限制。
- 变体：`supported_reasoning_levels[].effort` → `variants[effort] = { reasoning: { effort } }`。
- `price`：订阅请求的客户端成本为 0（`input/output/cacheRead/cacheWrite = 0`），不是“免费 API”；`referencePrice` 来自 models.dev 的 `cost`，含上下文阶梯时保留为 `kind="complex"` 的 `models.dev:<JSON>`，`estimate` 按 `usage.input`（已含缓存）选择阶梯；models.dev 不可用或没有该模型时 `referencePrice.kind="unknown"`，不会把 0 当作 API 等价。
- 余额：`credits.balance` 有值时返回 `currency="credits"`，不把 credits 当 USD；`credits.unlimited` 只写入说明。
- 窗口：`primary_window`/`secondary_window` 与 `additional_rate_limits` 的 `used_percent` 归一化到 0-1；`startsAt = reset_at - limit_window_seconds`。主/次通用账户窗口 `pool="default"`；`additional_rate_limits` 使用独立 `openai:additional:<name>` 池，不冒充通用窗口，也不把 unknown pool 当作无消费。
- 套餐标价：仅当 `options.planPrice` 显式配置时返回；不把用户口述的 100 USD Pro 写成所有账号的固定价格。

仍需目标账号验证：OAuth 授权服务产出的 token 结构、workspace/account id、`/models` 的 `client_version` 门槛、`wham/usage` 实际字段（尤其 `reset_at` 是秒还是其它形式）、可用模型与套餐窗口、401 后的重新授权流程。插件内部不重试，401 由核心策略处理。

## 6. 测试与验证记录

测试文件：`tests/providers.test.ts`。

运行：

```powershell
mise exec -- npx tsx --test tests/providers.test.ts
```

结果（2026-11-13）：16 个测试全部通过，约 0.8s。

覆盖：

- realseek：账号分组权限过滤、删组后缓存 token/secret 不复活旧路径、公开 pricing 不足以生成目录、分页异常传播、复杂表达式保留与有限求值、缺失参数 `null`+`enabled=false`、`token:<group>` 凭据、apiKey 回退写实际 `credentialKey`、未知价格不禁用/估算 null、显式 token 不被覆盖、用户 token 默认不启用、自动创建模板校验、创建请求字段、复用已有令牌、不调用 `PUT`/`DELETE`。
- DeepSeek：官方 `/models` 字段、复杂峰谷价格、`deepSeekCost` 峰谷/节假日、余额、请求准备与客户端 Authorization/URL 不透传。
- vm2api：Key 作用域目录、协议选择、未知价格不禁用、`/v1/me/quota` 余额与 `pool=default` 窗口、缺失 used/remaining 不按 0 发布、messages 准备。
- OpenAI：过期 access token 刷新、刷新响应轮换、`chatgpt-account-id`/`originator` 头、`/models`、`/responses` 准备（`store=false`/`stream=true`/`responseFormat=sse`/移除 max 参数）、`/wham/usage` 窗口与 `pool=default`、缺少凭据时明确失败、有效 token 不触发刷新；device flow 的 usercode 请求、403 pending、成功换 token 的表单字段与 `updateSecrets` 持久化；models.dev 阶梯按 `usage.input` 取档、缓存价缺失返回 null。
- 所有插件：monitor 失败返回通用脱敏文本，不回显上游 body/秘密。

测试约束：

- 全部使用 `node:test` + `node:assert/strict` + 固定响应假 `fetch`。
- `makeContext` 对任何非 HTTP URL、`models.dev` 主机直接抛错；各测试的未匹配 URL 也立即抛错。
- 每个测试设置 `timeout: 5000`。
- 不请求真实付费 API，不读取真实凭据。

未执行：真实账号认证、真实付费请求、真实余额/额度查询、目标实例版本兼容性、OpenCode/OpenChamber 联调。全仓 `npm run typecheck`/`npm test` 在本次实现时仍被其他目录的并发改动阻塞（`tests/clients.test.ts` 的 `transforms` 类型/运行错误）；`packages/providers/**` 与 `tests/providers.test.ts` 定向 `tsc` 无报错，`tests/providers.test.ts` 16 个测试全部通过。

## 7. 已知限制

- New API 的令牌分组、价格和权限随站点版本/配置变化；插件只按读取到的事实生成目录。
- realseek 的 `pricing_version` 仅作为来源版本保存；历史价格快照与账本版本化由核心实现。
- 复杂计价表达式只支持有限子集；时间、header、任务用量、图像/音频 token 无法从当前 `Usage` 契约获得时返回 `null`，不会估算。
- DeepSeek 高峰/低谷依赖当前时间与节假日；`estimate` 不猜，核心需调用 `deepSeekCost`。
- vm2api 的 `/v1/models` 不携带价格；不显式补全价格时模型仍可调用，`estimate` 返回 `null` 并写 warning，不会按 0 计价或禁用模型。
- OpenAI 订阅已实现 device authorization flow；浏览器 PKCE/localhost 回调仍未实现。`deviceAuthId`/`userCode` 的 15 分钟生命周期与轮询调度由管理员 API 保存和处理，不写长期 secrets。
- device flow 在目标 issuer 返回 404 时需要改用浏览器 PKCE 登录辅助程序；插件不会伪造授权或 token。
- OpenAI 订阅的 `client_version` 默认 `0.1.0`，目标服务端可能按 Codex 客户端版本过滤模型，需要按实际版本配置。
- 各包 `exports` 已指向 `dist/index.js`，`dist` 由 `npm run build:providers`（esbuild）生成；尚未生成 `.d.ts`。
- 所有“可用模型/余额/窗口”结论都需要在目标实例上复核；本文不构成实测验收。
