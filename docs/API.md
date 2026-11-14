# 开发接口契约

供并行实现使用；所有时间为ISO UTC，金额带币种，未知金额为null而非0。管理API `/api/admin/*` 需要HttpOnly会话cookie；修改操作需 `X-CSRF-Token`，登录返回csrfToken。设备Bearer密钥仅可 `/v1/*`、`/api/catalog`、`/api/quota`。

## 会话
- `POST /api/auth/login` `{username,password}` → `{username,csrfToken}` 并设置cookie。
- `GET /api/auth/session` → `{username,csrfToken}`，未登录401。
- `POST /api/auth/logout` → `{ok:true}`，需要CSRF。

## 管理
- `GET /api/admin/overview` → `{accounts,models,requests,attempts,paidCny,estimatedUsd,settledUsd,equivalentUsd,unknownAttempts}`，请求费用按北京时间当日统计，实付为全量净额，费用字段不相加。
- `GET /api/admin/providers` → `{items: ProviderAccount[]}`（绝不返回secrets，proxyUrl中的认证信息不回传）。
- `GET /api/admin/provider-history` → `{items: ProviderHistory[]}`，返回已彻底删除供应商的归档身份 `{id,name,namespace,plugin,billingType,createdAt,deletedAt}`；不含连接配置、代理认证或凭据。
- `GET /api/admin/plugins` → `{items:[{id,name}]}`。
- `POST /api/admin/providers` → `{item}`。输入 `{namespace,name,plugin,baseUrl,billingType,enabled?,proxyUrl?,proxyId?,autoCreateTokens?,tokenTemplate?,options?,secrets?,acknowledgeNamespaceReuse?}`。启用自动令牌时，`tokenTemplate.namePrefix` 必须以 `moris` 开头，否则拒绝自动创建；不会新建其他前缀的上游令牌。namespace 曾使用过时必须显式 `acknowledgeNamespaceReuse:true`，否则返回 `409 namespace_reuse`，提示旧客户端同名模型路径可能转向新 accountId。
- `PATCH /api/admin/providers/:id` → `{item}`。字段同上但namespace/plugin不可变；secrets按键更新，空字符串删除该键。省略secrets/proxyUrl保留原值。
- `DELETE /api/admin/providers/:id` → `{ok:true}`。仅软停用：保留配置、凭据、历史与在途请求，语义不变；不会删除或撤销任何上游资源。彻底删除使用下文的独立接口。
- `POST /api/admin/providers/:id/sync` → `{ok,state,error?}`。触发完整目录和额度刷新，失败保留旧快照。
- `POST /api/admin/providers/:id/oauth/start` → `{verificationUrl,userCode,expiresAt,intervalSeconds}`。插件支持设备授权时可用；设备授权ID仅保存在服务器内存，绑定当前管理员会话。
- `POST /api/admin/providers/:id/oauth/poll` → `{state:"pending",intervalSeconds,message}` 或 `{state:"complete",accountId,planType?,email?,expiresAt}`。按返回间隔轮询，过期或修改供应商后需重开；凭据加密保存且不返回浏览器。两接口均需CSRF。
- `GET /api/admin/models` → `{items: CatalogModel[]}` 包含停用条目。
- `GET /api/admin/models/:id/parameters` → `{automatic,effective,overrides,revision}`；`:id` 是经 URL 编码的完整业务模型 ID（含分组路径）。`automatic` 为插件自动快照，`effective` 为叠加覆盖并检查账号／TTL 后的结果。
- `PATCH /api/admin/models/:id/parameters` `{overrides,revision}` → 同上。覆盖字段仅允许 `context,input,output`（正安全整数）、`tools,reasoning,imageInput`（布尔）、`name`（1–200 字符）、`family`（1–100 字符）。输入／输出不能超过已知上下文。整份替换 overrides；省略字段恢复其自动值，`{}` 恢复全部自动值。首次 revision 为 null，之后使用读取值；并发修改返回 409。保存立即作用于目录与路由，不更新 syncedAt，不覆盖价格／协议／凭据／上游权限。
- `GET /api/admin/quota` → `{items: QuotaSummary[]}`。
- `GET /api/admin/requests?limit=50&offset=0` → `{items:[{id,modelId,deviceId,startedAt,finishedAt,status,attempts,estimatedCost,settledCost,equivalentUsd}],total}`。原币费用字段为Money数组。
- `GET /api/admin/requests/:id` → `{request,attempts}`，不包含正文或秘密。
- `GET /api/admin/bills` → `{items:[{id,accountId,paidAt,amountCny,period?,method?,note?,createdAt,updatedAt}],totalCny}`。`accountId` 可能是活动供应商，也可能是已彻底删除的归档身份；归档身份只用于历史账单关联，不能恢复供应商或用于推理/授权/同步。
- `POST /api/admin/bills` `{accountId,paidAt,amountCny,period?,method?,note?}` → `{item}`。金额可负（退款）；归档身份仍可补录付款或退款。
- `PATCH /api/admin/bills/:id` → `{item}`；`DELETE /api/admin/bills/:id` → `{ok:true}`。编辑历史账单不会重算历史金额，也不会把未知或未结算值改成 0。
- `GET /api/admin/devices` → `{items:[{id,name,createdAt,revokedAt,lastUsedAt}]}`。
- `POST /api/admin/devices` `{name}` → `{item,key}`，key仅此次返回。
- `DELETE /api/admin/devices/:id` → `{ok:true}` 撤销。
- `GET /api/admin/settings` → `Settings`；`PATCH /api/admin/settings` 部分Settings → `Settings`。

### 供应商彻底删除

彻底删除与软停用是两个独立流程。预览、开始、重试、取消均要求管理员会话与 `X-CSRF-Token`；响应和日志不返回明文令牌、管理 accessToken、代理密码或上游响应正文。

- `POST /api/admin/providers/:id/deletion-preview` → `DeletionPreview`（HTTP 200，无必需请求体）。返回 `{revision,expiresAt,account,cleanupSupported,actions,unsettledAttempts,warnings}`；`actions` 元素含 `{id,name,externalId,group?,disposition,reason?,defaultSelected,references,state}`。`disposition` 为 `ready`（默认勾选、可执行）、`adopt`（旧令牌/无归属，必须逐项确认纳入）、`blocked`（无法核验，不可执行）或 `shared`（其他本地供应商仍引用，跳过）。
  - 预览会读取账号身份与完整资源清单，但不创建、不修改、不删除上游资源；插件不支持清理时 `cleanupSupported=false`，只允许删除本地配置。
  - `revision` 有效期 5 分钟；账号、代理或受管资源引用快照发生变化，或供应商已有删除任务时，预览失效或拒绝（`409 deletion_conflict` / `deletion_busy`），必须重新预览。
  - `unsettledAttempts>0` 表示有未结算记录；删除凭据后不再自动对账，未知金额保持未知，不会补 0。
  - `warnings` 会说明历史账本保留、备份仍可能含历史加密凭据、无法自动检测外部客户端共用。既有数据库备份不随删除自动清除，也不构成全介质安全擦除；恢复备份只能恢复本地配置，不能恢复已撤销的上游令牌或授权。
- `POST /api/admin/providers/:id/deletions`，body `{revision,selectedActionIds,adoptActionIds,confirmNamespace,acknowledgeUnsettled,acknowledgeUncleaned}` → HTTP 202 `{item: ProviderDeletion}`，任务初始为 `draining`。
  - `selectedActionIds` 与 `adoptActionIds` 必须来自同一 `revision`；`adoptActionIds` 必须是已选中且 `disposition=adopt` 的项，未知、`blocked`、`shared` 或未确认归属的项返回 `400 deletion_selection`。
  - `confirmNamespace` 必须与供应商 namespace 完全一致；必须确认未结算与未清理风险，否则返回 `400 deletion_confirmation`。
  - 已有删除任务返回 `409 deletion_busy`；预览过期或快照变化返回 `409 deletion_conflict`。
  - 开始后立即停用该供应商并拒绝新推理、同步与授权；等待已开始的任务自然结束/流自然排空，不主动中断收费请求。未选中的清理项记为 `skipped`，不会撤销其上游资源。
- `GET /api/admin/provider-deletions` → `{items: ProviderDeletion[]}`；`GET /api/admin/provider-deletions/:id` → `{item}`，不存在返回 404。`ProviderDeletion` 为 `{id,accountId,name,namespace,status,actions,createdAt,updatedAt,cancelRequested?,message?}`。任务持久保存，响应不包含内部资源凭据或指纹。
- `POST /api/admin/provider-deletions/:id/retry`，body `{}` → `{item}`。仅 `failed`/`paused` 且当前未运行时可重试，否则 `409 deletion_busy`；重试前重新核验资源身份，不盲目重发已未知的上游删除。
- `POST /api/admin/provider-deletions/:id/cancel`，body `{}` → `{item}`。仅设置取消意图；已发出的上游删除不会回滚，已删除的上游令牌不会恢复。取消后供应商保持停用，不自动重新启用。
- 任务状态：`draining`（排空）、`cleaning`（清理）、`failed`（部分失败，保留停用配置与必要凭据/代理）、`paused`（等待手动继续）、`completed`（本地配置与凭据已删除，历史保留）、`cancelled`。动作状态：`pending/running/deleted/absent/skipped/failed/unknown`。
- 网关重启时，`draining`/`cleaning` 任务转为 `paused`，执行中的动作转为 `unknown`；不会自动重发上游删除。失败或暂停时仅允许通过 PATCH 修复凭据/代理，其他配置修改返回 `409 deletion_locked`。
- 完成后写入 `ProviderHistory` 归档身份并释放 namespace。新建同名供应商使用新 accountId，旧客户端同名模型路径可能转向新账号；旧历史不会归到新账号。旧账单可通过归档身份继续编辑、补录付款或退款，但不能据此恢复供应商、推理、授权或同步。

## 设备
- `GET /api/catalog` → `CatalogResponse`，具体类型见packages/contracts；只包含可调用模型，syncedAt为供应商最后完整成功时间，不因读取缓存改变。
- `GET /api/quota` → `{items:QuotaSummary[]}`。
- `GET /v1/models` → OpenAI风格模型ID列表。
- `POST /v1/chat/completions`、`/v1/responses`、`/v1/messages`：body.model为业务ID（不含moris/），协议与模型不匹配返回400；同协议转发。

错误统一 `{error:{code,message}}`（不含上游原始正文）。前端遇到401回登录，403展示权限/CSRF错误。分页limit默认50最大200。服务端仅单实例。

## 轻量代理配置

- `GET /api/admin/proxies` → `{items: ProxyView[]}`；含协议、主机、端口、用户名、`hasPassword` 和引用供应商 `{id,name}[]`，绝不返回密码。
- `POST /api/admin/proxies`、`PATCH /api/admin/proxies/:id` → `{item: ProxyView}`；完整表单 `{name,protocol,host,port,username,passwordAction,password?}`。协议支持 `http/https/socks5/socks5h`；主机不含协议、端口、认证，IPv6 使用方括号。
- `passwordAction` 必须明确指定：`keep` 保留已保存密码（新增时为不设密码），`replace` 必须带非空 `password`，`clear` 清除。`keep/clear` 不接受 password；密码加密保存，地址编辑不会隐式清除。用户名传空串清除；SOCKS5 认证用户名密码须同时存在或同时清除，各最多 255 字节。无需调用方手工编码认证。
- `DELETE /api/admin/proxies/:id` → `{ok:true}`；被任何供应商引用（包括已停用）返回 `409 proxy_in_use`，须先解绑。
- 供应商 `proxyId` 为档案 ID 时绑定；`null` 为显式直连；不提交则保留旧配置。不得与 `proxyUrl` 同时提交。选档案／直连会清理原内联 URL 及其认证；未切换的旧内联代理继续原样生效。`secrets.__proxyUrl` 为保留键，不能通过通用秘密接口写入。绑定缺失时拒绝，不降级直连。
- `POST /api/admin/proxies/:id/diagnose` `{target:"cloudflare"|"openai"}` → `ProxyDiagnostic`。固定 HTTPS 站点 HEAD，无上游令牌／Cookie／推理；最长 10 秒，无重定向及重试。同档案探测不并发。状态分 `reachable/upstream_rejected/proxy_auth/connection_failed/timeout`，只返回固定文案和可选 HTTP 状态，不回传底层异常、凭据或响应正文。OpenAI 未认证探测返回 401 属目标拒绝，不能据此声称授权或推理可用。
- 档案修改影响所有引用账号的后续请求，释放旧连接池但不重放正在执行的请求；未完成的设备授权会失效，正在执行授权 HTTP 请求时返回 `409 oauth_busy`，避免授权中途换出口。不做代理池、自动切换或负载均衡；真实认证出口仍需在部署环境验证。
