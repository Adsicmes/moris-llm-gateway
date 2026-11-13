# MorisLLMGateway 管理后台（UI）

本文说明 `apps/admin` 的实现范围、路由、接口映射、行为约定与验证边界。接口字段以 `docs/API.md`、`packages/contracts/src/index.ts` 和服务端实际路由为准；本文不新增接口。

## 1. 范围

独立 workspace：`@moris/admin`，React + TypeScript + Vite。

已实现：

- 管理员密码登录、会话恢复、退出、401 回登录、CSRF 请求头。
- 概览：账户/模型/请求/尝试计数，人民币实付、请求估算、已结算、API 等价四类金额分开展示。
- 供应商：新增、编辑、密钥按键更新/删除、代理、自动令牌模板、JSON options、插件选择、同步、软停用。
- 模型目录：来源汇总、搜索与筛选、价格/参考价格、能力、限制、字段级来源、变体、目录同步时间、停用条目。
- 余额与额度：供应商余额、上游窗口、窗口估算、未知/过期/失败状态、单账户同步。
- 请求：分页列表、生成级详情、attempt 级用量/费用/价格依据/原始元数据。
- 人民币账单：新增、编辑、删除确认、负数退款、账期筛选、服务端净额与筛选内合计分开。
- 设备密钥：创建后仅显示一次、复制、关闭即从页面内存清除、撤销确认。
- 设置：刷新周期、目录有效期、余额过期阈值、超时、最大尝试、汇率、最小估算比例、手动回退规则。

不包含：多用户/角色、多租户、自动成本分摊、请求正文或提示词展示、上游令牌的明文查看。

## 2. 运行与构建

```text
apps/admin/
  package.json          @moris/admin，独立脚本
  vite.config.ts        /api 代理到 http://127.0.0.1:8787
  tsconfig.json         独立严格 tsconfig（noEmit）
  index.html            Vite 入口
  src/                  React 源码
```

命令：

```bash
npm run dev --workspace=@moris/admin      # Vite 5173，/api 代理到 8787
npm run build --workspace=@moris/admin    # vite build && tsc --noEmit
npm run typecheck --workspace=@moris/admin
```

生产：

- 构建产物在 `apps/admin/dist`，服务端已在 `apps/gateway/src/main.ts` 中以 `MORIS_ADMIN_DIST`（默认 `apps/admin/dist`）挂载。
- 管理后台与 API 同源；不使用跨域请求。
- 前端使用 hash 路由（`#/providers` 等），因此静态服务不需要额外的 SPA 重写也能直接打开任意页面。服务端现有的 `index.html` fallback 保留即可。
- Vite 仅代理 `/api`；`/v1` 由设备直接调用，不经过后台。

### 依赖交接

`apps/admin/package.json` 已写入以下依赖，主模型已统一安装：

- dependencies：`react`、`react-dom`
- devDependencies：`@types/react`、`@types/react-dom`、`@vitejs/plugin-react`、`vite`、`typescript`、`@types/node`

未引入路由库、状态库、UI 组件库、图表库或 CSS 框架；路由、弹窗、toast、表格与图标均为本地实现，减少依赖面和锁文件变化。

## 3. 设计方向

- 调色：design-taste-frontend dealer 的 `soot-pale-lime`，深色近黑底 + 克制的青柠强调色。后台是操作台，不是营销页：没有 hero 大标题、营销照片或装饰性数据。
- 字体：Host Grotesk（界面）+ JetBrains Mono（ID、金额、JSON、时间），Google Fonts 不可达时回退到系统中文字体与等宽字体。
- 概念：“路由控制台 / 分组目录”。左侧固定侧栏按运行、路由目录、账务、访问、系统分组；强调色只用于当前导航、主操作、焦点环和关键金额。
- 密度：桌面 1440 下侧栏 236px，内容区最大 1340px；移动 390 下侧栏变为抽屉，表格保持真实表格并横向滚动。
- 语义色：成功/警告/失败/信息各有文字标签与图标，不依赖颜色单独表意。
- 动效：按钮/导航/行的短过渡、页面首次进入；`prefers-reduced-motion` 下全部停用。无滚动入场、视差、轮播或自动切换。

## 4. 路由

| hash | 页面 | 说明 |
| --- | --- | --- |
| `#/login` | 登录 | 未登录时任何路由都会显示登录页 |
| `#/` | 概览 | 默认页 |
| `#/providers` | 供应商列表 | 同步、编辑、软停用 |
| `#/providers/new` | 新增供应商 | 创建 |
| `#/providers/:id/edit` | 编辑供应商 | 从列表数据中查找该 ID |
| `#/models` | 模型目录 | 只读目录与详情弹窗 |
| `#/quota` | 余额与额度 | 余额、窗口、估算 |
| `#/requests` | 请求列表 | `limit=50/100/200`、`offset` 分页 |
| `#/requests/:id` | 请求详情 | attempt 级追溯 |
| `#/bills` | 人民币账单 | 增删改、退款、账期筛选 |
| `#/devices` | 设备密钥 | 创建、一次性密钥、撤销 |
| `#/settings` | 设置 | 刷新、超时、汇率、回退 |

未知 hash 显示 404 页面并可回到概览。

## 5. 接口映射

### 5.1 会话与安全

- 启动：`GET /api/auth/session`。401 视为未登录；其他错误显示“网关未响应”并提供重试。
- 登录：`POST /api/auth/login`，成功后把 `csrfToken` 放在 React 内存（`AuthContext`）。
- 退出：`POST /api/auth/logout`，带 `X-CSRF-Token`；失败也会清理本地状态。
- 所有管理读写经 `useApi()`：自动附带内存中的 CSRF；遇到 401 清理会话并回到 `#/login`；403 显示“权限或 CSRF 校验失败”。
- 不写入 `localStorage` / `sessionStorage`：密码、CSRF、设备密钥都不持久化。密码提交后立即清空；设备密钥关闭弹窗即置空。

### 5.2 概览

`GET /api/admin/overview`

- 四类金额分别展示：人民币实付、请求估算、上游已结算、API 等价，并明确“费用口径互不相加”。
- `paidCny` 为全量净实付；`estimatedUsd`、`settledUsd`、`equivalentUsd` 为 USD 口径。
- `unknownAttempts` 单独标记，不摊入 0；`unknownEquivalentAttempts > 0` 时，API 等价卡片标注“已知部分”，并说明未知部分未计入。
- 服务端返回的 `estimatedCost` / `settledCost`（Money[]）按币种单独展示，保留 USD、CNY 等原币金额；不会因为 USD 汇总为 0 就把 CNY 金额静默丢弃。
- “估算与结算均未知”与“等价金额未知”分别显示；订阅模型估算为 0 不代表参考额度已知。
- 额外读取 `GET /api/admin/requests?limit=8&offset=0`、`/providers`、`/quota` 做最近请求、供应商状态与需要核对的窗口；各区块独立处理读取失败。

### 5.3 供应商

- `GET /api/admin/providers`、`GET /api/admin/plugins`。
- 新建：`POST /api/admin/providers`，字段严格为 `namespace,name,plugin,baseUrl,billingType,enabled,proxyUrl,autoCreateTokens,tokenTemplate,options,secrets`。
- 编辑：`PATCH /api/admin/providers/:id`；**不提交 `namespace` 与 `plugin`**（服务端将其视为不可变）。`proxyUrl` 仅在值与回显值不同时提交；清空并保存会发送空字符串以移除代理。未改动时完全省略该字段，避免擦除服务端保存的代理认证信息。
- 密钥：列表绝不回显 secrets。新增/替换按 `{key: value}` 提交；勾选“删除”的键以 `{key: ""}` 提交。未填写的键不提交。
- 自动令牌：默认关闭；模板完整（名称前缀、额度、0–3650 整数天有效期，0 表示长期有效）才提交。`unlimited` 可选，额度按 0 提交；不会猜测或隐式开启。
- `options` 必须是 JSON 对象；无效 JSON 在客户端阻止提交。
- 同步：`POST /api/admin/providers/:id/sync`，展示返回的 `state` 与 `error`；失败保留旧快照。
- 停用：`DELETE /api/admin/providers/:id`（软停用）。确认文案说明历史与在途请求不被删除/主动打断。
- 状态：`enabled` 由 PATCH 保存；停用行降低视觉权重但仍可编辑。

#### OpenAI 订阅设备授权

仅在**已保存**且 `plugin=openai-subscription` 的供应商编辑页显示“授权 OpenAI 订阅”。新增页不发起授权。

- 开始：`POST /api/admin/providers/:id/oauth/start` → `{verificationUrl,userCode,expiresAt,intervalSeconds}`。
- 轮询：`POST /api/admin/providers/:id/oauth/poll` → `{state:'pending',intervalSeconds?,message?}` 或 `{state:'complete',accountId,planType?,email?,expiresAt?}`。
- 全部请求沿用管理员 Cookie 与 `X-CSRF-Token`；设备授权 ID/token 只由服务端保管，前端不接收、不持久化。
- 不自动开始、不自动打开外部页面、不预轮询：首次检查严格在 `intervalSeconds` 之后；后续按服务端返回的间隔使用 `setTimeout` 链式调度，避免并发请求。
- 一次性 `userCode` 只存在 React state；展示链接、代码、到期时间与剩余时间，并使用 `aria-live` 状态区。授权完成或过期后立即清除代码。
- 本机到期计时器与轮询计时器分开；离开页面、取消、完成、过期或出错时都会清理计时器并中止在途请求。不使用 `localStorage` / `sessionStorage`。
- 完成状态显示 `accountId`、可选套餐/邮箱/到期时间，并提供“同步模型目录”（复用 `POST /api/admin/providers/:id/sync`）。
- 过期、CSRF/权限错误、服务端错误分别显示可恢复的提示与“重新开始授权/重试”。

### 5.4 模型目录

`GET /api/admin/models`

- 展示全部条目（含停用）。账户级“来源”卡片按返回条目的 `accountId/namespace` 汇总，并取条目 `syncedAt` 的最大值，页面明确标注“由条目的 syncedAt 汇总”，不冒充服务端账户级同步状态。
- 详情显示 `path/upstreamModel/family/group/protocol/capabilities/limit/variants/price/referencePrice/sources/credentialKey/enabled/disabledReason`。
- 价格只显示实际存在的字段；缺失显示“未提供/未知”，不补 0。
- 筛选/搜索仅作用于已读取的目录列表，不发额外查询。

### 5.5 余额与额度

`GET /api/admin/quota`

- `monitor.state` 为 `ok/unknown/stale/error/unsupported`，使用可区分的中文标签。
- 非 `ok` 状态显示提示，并声明“以下不是实时值”；`monitor.message` 原样呈现。
- 余额 `amount` 为 0 时显示 0；没有余额条目时显示“未返回余额”，不显示 0。
- 窗口 `usedRatio` 的真实百分比以文本显示，进度条仅作辅助。
- 估算 `state=ok` 显示总额/剩余/已用；`unavailable` 显示 `reason`。页脚注明“基于本网关记录的估算，不是官方额度”。
- “同步”调用该账户的 `POST /api/admin/providers/:id/sync`，不另造额度刷新接口。

### 5.6 请求与 attempt

- 列表：`GET /api/admin/requests?limit=&offset=`，显示 `attempts` 数量、`estimatedCost` / `settledCost`（Money 数组）和数值型 `equivalentUsd`。
- 详情：`GET /api/admin/requests/:id`。
  - `request` 是生成级原始记录；详情费用卡片由当前返回的 attempt 汇总，并标注“由 attempt 汇总”。
  - 汇总规则与服务端一致：已有 `settledCost` 的 attempt 不再计入估算；等价 USD 只有在全部 attempt 都有数值时才汇总，否则显示“未知”。
  - attempt 实际字段包括 `number/accountId/modelId/status/httpStatus/upstreamRequestId/usage/price/billingType/estimatedCost/settledCost/equivalentUsd/usdCny/estimatedCny/settledCny/settlementSource/pool/...`；费用为单个 `Money | null`，不是数组。
  - 原始元数据通过 `<details>` 展示，不包含请求正文或秘密。
- 失败、取消、中断、超时都保留展示，不默认免费。

### 5.7 人民币账单

- `GET /api/admin/bills` 返回 `items` 与 `totalCny`；总净额始终使用服务端值。
- `POST/PATCH/DELETE /api/admin/bills[/:id]`。
- 必填：`accountId`、`paidAt`、`amountCny`；`paidAt` 由日期输入转换为北京时间当日 00:00 的 ISO 时间。金额最多两位小数，允许负数。
- 负数显示“退款”标签并按负数计入净实付；备注可选。
- 删除必须二次确认；确认框重复供应商、日期与金额。
- 账期筛选只影响当前表格；筛选内合计单独标注“仅按当前返回记录计算”，不与服务端全量净额混淆。

### 5.8 设备密钥

- `GET /api/admin/devices`、`POST /api/admin/devices`、`DELETE /api/admin/devices/:id`。
- `POST` 返回的 `key` 只进入组件 state，展示在不可背景关闭的弹窗中；关闭后置空。没有再次读取接口。
- 撤销需确认；提示立即失效、其他设备不受影响、历史账目保留。
- 已撤销设备行仍然展示 `revokedAt`，不能再次撤销。

### 5.9 设置

- `GET /api/admin/settings`、`PATCH /api/admin/settings`。
- 只提交变更字段。
- 时间字段在 UI 以秒输入，提交时转换为毫秒；范围与服务端一致：
  - 目录/余额刷新、余额过期阈值 ≤ 86400 秒
  - 目录 TTL ≤ 604800 秒
  - 连接超时 ≤ 120 秒；首事件/空闲/总期限 ≤ 3600 秒
  - `maxAttempts` 1–10
  - `usdCny` 可空，>0 且 ≤10000
  - `minEstimateRatio` 0.1%–100%（API 为 0.001–1）
- 汇率留空表示未配置；页面注明“只影响后续请求，历史快照与账单不重算”。
- 回退规则为 `Record<modelId, targets[]>`：每行一个源模型，目标用逗号或换行分隔，顺序即尝试顺序；最多 20 个目标。客户端阻止空源、空目标和重复源。
- 时区固定显示 `Asia/Shanghai`，不可编辑。

## 6. 数据真实性约定

- 未知金额一律显示“未知”，不显示 0；0 只有接口明确返回 0 时才显示。
- `null` 与空数组分别处理：`null` 为未知，空费用数组为“无费用记录”。
- 人民币实付、请求估算、上游已结算、API 等价消费分卡展示，不求和成一个“总成本”。
- 余额、上游窗口和额度估算使用不同的卡片与说明；估算明确标注“基于本网关记录”。
- “目录来源”的账户级时间是从条目 `syncedAt` 汇总的派生值，已明确标注。
- 详情页请求级费用是从 attempts 汇总的派生值，已明确标注；原始请求对象另在 `<details>` 中展示。
- 空状态只说明下一步，不填充示例供应商、假金额或假请求。

## 7. 可访问性与响应式

- 语义：`main`、`nav`、`table`、`label for`、按钮/链接区分；模态框 `role="dialog"`、`aria-modal`、焦点陷阱、Escape 关闭、背景 `inert`、关闭后恢复焦点。
- 每页一个 `h1`；卡片/详情标题按层级下降。
- 所有图标按钮有 `aria-label`；状态同时有文字与颜色。
- 表单提交时 `aria-invalid` + 字段错误文本，首个错误字段自动聚焦。
- 焦点环 2px 青柠色；跳转链接第一个可聚焦。
- 路由切换更新 `document.title`、滚动到顶部并把焦点移到 `main`。
- toast 使用 `role="status"`；错误 toast 不自动消失，直到手动关闭。
- 桌面 1440、平板 1024/900、手机 560/390 断点；表格在窄屏横向滚动，不压缩成不可读卡片；表单单列；弹窗在手机底部铺开。
- `prefers-reduced-motion: reduce` 下停用页面入场、弹窗/提示动画和过渡；触屏设备取消 hover 位移。

## 8. 验证记录

本次已执行：

- 全部 `.ts/.tsx` 先通过 TypeScript `transpileModule` 语法检查（23 个源文件，0 diagnostics），随后由 `tsc --noEmit` 完整类型检查通过。
- CSS 大括号平衡检查通过；无未闭合块。
- 颜色对比度计算（WCAG 2.2 AA，文本 4.5:1）：
  - ink `#f3f3ef` / surface `#161616` = 16.27
  - muted `#a3a39c` / surface = 7.13
  - faint `#85857d` / surface = 4.87
  - accent `#dafa9c` / bg `#0f0f0f` = 16.55
  - bad `#ff9d9d` / surface-2 = 8.57；warn 10.61；ok 11.52；info 9.82
- 静态检查：所有导入均被使用；无 `localStorage` / `sessionStorage` 写入；无第三方网络请求（仅 Google Fonts 样式）。
- 对照 `apps/gateway/src/server.ts` 复核了请求/attempt/账单/设置的实际字段与校验范围，修正了 `equivalentUsd`（数值而非 Money）、attempt 费用（单 Money）、设置上下限与令牌有效期。
- `npm run admin:build` 通过：Vite 7.3.8 构建成功，`tsc --noEmit` 通过（React 19 / Vite 7 根依赖）。
- Tabbit 真实浏览器（本地临时后端 + 临时数据目录）验证：
  - 登录、401 回登录、CSRF 保护下的 PATCH 设置、供应商创建/编辑、设备密钥创建/一次性展示/撤销；
  - 1440 与 390 下登录、概览、供应商、模型目录、请求、余额、账单、设置与移动抽屉均无横向溢出；
  - 模态框背景 `inert`、焦点陷阱、Escape 行为、关闭后清除密钥与解除 `inert` 验证通过；
  - 表单校验后聚焦首个错误字段验证通过；
  - 概览新版六项计数与“原币估算与结算”卡片渲染通过；
  - OpenAI 供应商编辑页显示“授权 OpenAI 订阅”空闲态，点击前没有 `/oauth/` 请求，也没有 localStorage 写入；
  - 代理认证保留验证：第一次保存带凭据的代理时 PATCH 包含 `proxyUrl`；重新打开编辑页只回显去凭据地址，未改动代理仅修改名称时，第二次 PATCH 完全不包含 `proxyUrl`，服务端代理认证不会被擦除。

主模型补充验证：

- 账单 500 已修复：`apps/gateway/src/store.ts` 的 SQLite JSON 路径改为 `$.paidAt`，`tests/core.test.ts` 覆盖排序及退款负数。
- 使用最新编译服务和临时数据库，实际登录、创建停用供应商并录入 -20 CNY 退款，列表返回成功，净实付显示 `¥-20.00`；未调用真实上游。
- 统一 `mise exec -- npm run check`：74 项测试、类型检查与全部构建通过。最后窄屏导航 CSS 修正后，单独执行 `mise exec -- npm run admin:build` 通过。

尚未执行：

- OpenAI 设备授权的真实 start/poll 端到端；假插件的权限、会话、间隔、加密和脱敏测试 6 项通过，真实授权仍需账号。
- 真实上游目录同步、模型/请求/额度有数据状态下的页面验收（当前临时环境无上游凭据）。

## 9. 已知边界

- 后端没有 `GET /api/admin/providers/:id`，编辑页从列表接口按 ID 查找；供应商数量大时可改为服务端补单条接口。
- 后端没有账户级目录同步状态接口；模型页的“来源”时间是条目级 `syncedAt` 派生值，额度页的 `monitor.state` 才是账户级状态。
- `docs/API.md` 未逐字段定义 attempt；本次按 `apps/gateway/src/store.ts` 的 `AttemptRecord` 渲染，并对未知额外字段保留原始元数据入口。若服务端字段再变，详情页仍以原始 JSON 兜底。
- 服务端登录 Cookie 默认 `Secure`；本地 HTTP 开发如浏览器不接受 Secure Cookie，需要后端以 `MORIS_SECURE_COOKIE=false` 启动，或经 HTTPS/Caddy 访问。
- OpenAI 设备授权的 `/oauth/start` 与 `/oauth/poll` 已接入；前端已实现空闲、等待、成功、过期和错误状态，真实授权仍待账号验收。
- Google Fonts 可能在内网不可达；字体回退到系统中文字体和等宽字体，不阻塞使用。
- 设备密钥只在创建响应中出现一次；前端无法恢复明文，这是接口约束，不是缺少功能。

## 10. 最终界面复核（better-interface）

范围：运行概览及共享桌面／手机导航；React、本地 CSS tokens，无 UI 框架。约定依据为本文第 3、7 节和项目 AGENTS 指令。其他页面沿用第 8 节的既有联调记录，不冒充本轮逐页重审。

| 领域 | 检查证据 | 结果 |
| --- | --- | --- |
| Accessibility | `Layout.tsx`、`styles.css`，320px Tab 顺序和 Enter 打开／选择导航，焦点环实际为 2px | 关闭导航的隐藏焦点问题已修复；检查范围内无遗留 HIGH |
| Layout | 概览、导航源码及 1440／390／320 截图；390 与 320 的 scrollWidth 分别为 375／305 | 无横向溢出，内容与控件在已查看区域可达 |
| Writing | `Overview.tsx` 的金额口径、未知提示、空状态与带重试的错误分支 | 估算、结算、实付和等价含义分开，检查范围内无新增问题 |
| Typography | `styles.css` 与运行时字号、行高，金额等宽字体 | body 改用 0.9375rem；可见文字换行正常 |
| Colors | 实际计算样式的 muted／faint 与 surface 配对 | #a3a39c / #161616 为 7.13，#85857d / #161616 为 4.87；满足正文 4.5 阈值 |
| UI | 共享按钮、导航状态、图标、reduced-motion 覆盖规则及截图 | 风格一致；状态有文字，未发现检查范围内阻断项 |

按严重度排列的发现与处理：

| 严重度 | 领域 | 位置 | 修复前 | 修复后 | 原因 |
| --- | --- | --- | --- | --- | --- |
| HIGH（已修复） | Accessibility | `apps/admin/src/styles.css:2834` | 手机导航仅 translateX 移出屏幕，Tab 聚焦“概览”的 x=-263 | 关闭时 visibility:hidden，打开时 visible；复验 Tab 落在 x=16 的“回到概览” | 屏幕外焦点不可见，违反 WCAG 2.4.7 |
| LOW（已修复） | Typography | `apps/admin/src/styles.css:70` | body 为 15px | 改为等值 0.9375rem | 根字号跟随浏览器默认字号设置 |

验证：Tabbit 任务 `Moris后台验收`，请求 `clean-shots2`、`overview-320`、`nav-before`、`nav-after`。`nav-after` 返回手机键盘导航与桌面导航均成功。早期两张截图被密码管理器覆盖，不用于最终判断。

最终已查看截图目录：`C:\Users\abbey\AppData\Local\Tabbit Browser\User Data\LocalAgent\Runtime\artifacts\task-c375ffa2-a10c-4a90-a155-841d46950c7a\`：
- 桌面：`screenshot-shot-9647902f-466a-4643-9a69-e2c5736dd5a9.png`
- 手机：`screenshot-shot-63d233c1-16e2-49cb-ae34-88b8cd33a35c.png`
- 320px 键盘焦点：`screenshot-shot-c1d3bd42-1b11-429d-8e8c-a954c6a16f52.png`

Not verified：屏幕阅读器、200% 浏览器缩放、RTL、多语言、真实上游有数据状态、完整动态对比度审计；未宣称 WCAG 全面合规或营销页 taste gate 通过。

结论：**Approve，仅限上述已检查范围**。没有未处理的 HIGH；真实供应商、客户端宿主与生产部署验收继续保留为待实测。
