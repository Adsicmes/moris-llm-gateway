# 开发接口契约

供并行实现使用；所有时间为ISO UTC，金额带币种，未知金额为null而非0。管理API `/api/admin/*` 需要HttpOnly会话cookie；修改操作需 `X-CSRF-Token`，登录返回csrfToken。设备Bearer密钥仅可 `/v1/*`、`/api/catalog`、`/api/quota`。

## 会话
- `POST /api/auth/login` `{username,password}` → `{username,csrfToken}` 并设置cookie。
- `GET /api/auth/session` → `{username,csrfToken}`，未登录401。
- `POST /api/auth/logout` → `{ok:true}`，需要CSRF。

## 管理
- `GET /api/admin/overview` → `{accounts,models,requests,attempts,paidCny,estimatedUsd,settledUsd,equivalentUsd,unknownAttempts}`，请求费用按北京时间当日统计，实付为全量净额，费用字段不相加。
- `GET /api/admin/providers` → `{items: ProviderAccount[]}`（绝不返回secrets，proxyUrl中的认证信息不回传）。
- `GET /api/admin/plugins` → `{items:[{id,name}]}`。
- `POST /api/admin/providers` → `{item}`。输入 `{namespace,name,plugin,baseUrl,billingType,enabled?,proxyUrl?,proxyId?,autoCreateTokens?,tokenTemplate?,options?,secrets?}`。
- `PATCH /api/admin/providers/:id` → `{item}`。字段同上但namespace/plugin不可变；secrets按键更新，空字符串删除该键。省略secrets/proxyUrl保留原值。
- `DELETE /api/admin/providers/:id` → `{ok:true}`。软停用，保留历史。
- `POST /api/admin/providers/:id/sync` → `{ok,state,error?}`。触发完整目录和额度刷新，失败保留旧快照。
- `POST /api/admin/providers/:id/oauth/start` → `{verificationUrl,userCode,expiresAt,intervalSeconds}`。插件支持设备授权时可用；设备授权ID仅保存在服务器内存，绑定当前管理员会话。
- `POST /api/admin/providers/:id/oauth/poll` → `{state:"pending",intervalSeconds,message}` 或 `{state:"complete",accountId,planType?,email?,expiresAt}`。按返回间隔轮询，过期或修改供应商后需重开；凭据加密保存且不返回浏览器。两接口均需CSRF。
- `GET /api/admin/models` → `{items: CatalogModel[]}` 包含停用条目。
- `GET /api/admin/models/:id/parameters` → `{automatic,effective,overrides,revision}`；`:id` 是经 URL 编码的完整业务模型 ID（含分组路径）。`automatic` 为插件自动快照，`effective` 为叠加覆盖并检查账号／TTL 后的结果。
- `PATCH /api/admin/models/:id/parameters` `{overrides,revision}` → 同上。覆盖字段仅允许 `context,input,output`（正安全整数）、`tools,reasoning,imageInput`（布尔）、`name`（1–200 字符）、`family`（1–100 字符）。输入／输出不能超过已知上下文。整份替换 overrides；省略字段恢复其自动值，`{}` 恢复全部自动值。首次 revision 为 null，之后使用读取值；并发修改返回 409。保存立即作用于目录与路由，不更新 syncedAt，不覆盖价格／协议／凭据／上游权限。
- `GET /api/admin/quota` → `{items: QuotaSummary[]}`。
- `GET /api/admin/requests?limit=50&offset=0` → `{items:[{id,modelId,deviceId,startedAt,finishedAt,status,attempts,estimatedCost,settledCost,equivalentUsd}],total}`。原币费用字段为Money数组。
- `GET /api/admin/requests/:id` → `{request,attempts}`，不包含正文或秘密。
- `GET /api/admin/bills` → `{items:[{id,accountId,paidAt,amountCny,period?,method?,note?,createdAt,updatedAt}],totalCny}`。
- `POST /api/admin/bills` `{accountId,paidAt,amountCny,period?,method?,note?}` → `{item}`。金额可负。
- `PATCH /api/admin/bills/:id` → `{item}`；`DELETE /api/admin/bills/:id` → `{ok:true}`。
- `GET /api/admin/devices` → `{items:[{id,name,createdAt,revokedAt,lastUsedAt}]}`。
- `POST /api/admin/devices` `{name}` → `{item,key}`，key仅此次返回。
- `DELETE /api/admin/devices/:id` → `{ok:true}` 撤销。
- `GET /api/admin/settings` → `Settings`；`PATCH /api/admin/settings` 部分Settings → `Settings`。

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
