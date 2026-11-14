export const PROVIDER_ID = 'moris' as const;
export type Protocol = 'chat-completions' | 'responses' | 'messages';
export type BillingType = 'subscription' | 'metered';
export type DataState = 'ok' | 'unknown' | 'stale' | 'error' | 'unsupported';
export interface Price {
  kind: 'token' | 'request' | 'complex' | 'unknown';
  currency: 'USD' | 'CNY';
  /** 每百万token的原币金额，不含缓存读取/写入部分。 */
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  perRequest?: number;
  expression?: string;
  source?: string;
  version?: string;
}
export interface ModelCapabilities {
  tools: boolean;
  input: Array<'text' | 'image'>;
  output: Array<'text'>;
  reasoning?: boolean;
}
export interface ProviderModel {
  path: string;
  upstreamModel: string;
  name: string;
  family: string;
  protocol: Protocol;
  capabilities: ModelCapabilities;
  limit: { context: number | null; output: number | null; input?: number };
  variants: Record<string, Record<string, unknown>>;
  price: Price;
  referencePrice?: Price;
  /** secrets 中的推理凭据键，由插件定义。 */
  credentialKey?: string;
  group?: string;
  enabled?: boolean;
  /** 独立于参数完整度的上游权限／凭据可用性；手工参数不得覆盖 false。 */
  available?: boolean;
  unknownParameters?: Array<'tools' | 'reasoning' | 'imageInput'>;
  disabledReason?: string;
  sources?: Record<string, string>;
}
export interface ModelParameterOverrides {
  context?: number;
  output?: number;
  input?: number;
  tools?: boolean;
  reasoning?: boolean;
  imageInput?: boolean;
  name?: string;
  family?: string;
}
export interface ModelParameterState {
  automatic: CatalogModel;
  effective: CatalogModel;
  overrides: ModelParameterOverrides;
  revision: string | null;
}
export interface CatalogModel extends ProviderModel {
  id: string;
  accountId: string;
  namespace: string;
  billingType: BillingType;
  enabled: boolean;
  syncedAt: string;
}
export interface TokenTemplate {
  namePrefix: string;
  quota: number;
  expiresInDays: number;
  unlimited?: boolean;
}
export interface ProxyProfile {
  id: string;
  name: string;
  protocol: 'http' | 'https' | 'socks5' | 'socks5h';
  host: string;
  port: number;
  username: string;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface ProxyInput {
  name: string;
  protocol: ProxyProfile['protocol'];
  host: string;
  port: number;
  username: string;
  passwordAction: 'keep' | 'replace' | 'clear';
  password?: string;
}
export interface ProxyView extends ProxyProfile {
  references: Array<{ id: string; name: string }>;
}
export interface ProxyDiagnostic {
  ok: boolean;
  code: 'reachable' | 'upstream_rejected' | 'proxy_auth' | 'connection_failed' | 'timeout';
  message: string;
  status?: number;
}
export interface ProviderAccount {
  id: string;
  namespace: string;
  name: string;
  plugin: string;
  baseUrl: string;
  billingType: BillingType;
  enabled: boolean;
  proxyUrl?: string;
  /** null 为显式直连；undefined 保留旧内联代理行为。 */
  proxyId?: string | null;
  autoCreateTokens: boolean;
  tokenTemplate?: TokenTemplate;
  options: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletionTaskId?: string;
}
/** 活动配置删除后，仅保留账务身份，不含任何连接配置或凭据。 */
export interface ProviderHistory {
  id: string; name: string; namespace: string; plugin: string; billingType: BillingType;
  createdAt: string; deletedAt: string;
}
export interface ManagedResourceInput {
  kind: 'token'; scope: string; externalId: string; name: string; group?: string;
  /** 不可逆凭据摘要，仅用于核验及共享保护；绝不是可用的令牌。 */
  fingerprint?: string;
  provenance: 'created' | 'adopted' | 'reused' | 'intent';
  credentialKey?: string;
}
export interface ManagedResource extends ManagedResourceInput {
  id: string; plugin: string; accountIds: string[]; createdAt: string; updatedAt: string;
}
export interface DeletionAction {
  id: string; name: string; externalId: string; group?: string;
  disposition: 'ready' | 'adopt' | 'blocked' | 'shared';
  reason?: string; defaultSelected: boolean;
  references: Array<{ id: string; name: string }>;
  state: 'pending' | 'running' | 'deleted' | 'absent' | 'skipped' | 'failed' | 'unknown';
}
export interface DeletionPreview {
  revision: string; expiresAt: string;
  account: Pick<ProviderAccount, 'id' | 'name' | 'namespace'>;
  cleanupSupported: boolean; actions: DeletionAction[]; unsettledAttempts: number; warnings: string[];
}
export interface ProviderDeletion {
  id: string; accountId: string; name: string; namespace: string;
  status: 'draining' | 'cleaning' | 'failed' | 'paused' | 'completed' | 'cancelled';
  actions: DeletionAction[]; createdAt: string; updatedAt: string;
  cancelRequested?: boolean; message?: string;
}
export interface Balance {
  currency: string;
  amount: number;
  unit?: string;
}
export interface QuotaWindow {
  id: string;
  name: string;
  pool: string;
  startsAt: string;
  resetsAt: string;
  usedRatio: number;
  sampledAt: string;
}
export interface ProviderMonitor {
  state: DataState;
  balances: Balance[];
  windows: QuotaWindow[];
  sampledAt: string;
  message?: string;
  planPrice?: { amount: number; currency: string; source: string };
}
export interface Usage {
  input: number;
  output: number;
  /** input包含缓存tokens；cacheWrite和cacheRead不得再次按普通输入价计算。 */
  cacheRead: number;
  cacheWrite: number;
}
export interface Money { amount: number; currency: 'USD' | 'CNY' }
export interface WindowEstimate {
  windowId: string;
  state: 'ok' | 'unavailable';
  totalUsd?: number;
  remainingUsd?: number;
  spentUsd?: number;
  reason?: string;
  sampledAt: string;
  label: string;
}
export interface QuotaSummary {
  accountId: string;
  name: string;
  namespace: string;
  monitor: ProviderMonitor;
  estimates: WindowEstimate[];
}
export interface CatalogResponse {
  providerID: 'moris';
  fetchedAt: string;
  models: CatalogModel[];
  accounts: Array<{ id: string; lastSyncedAt: string | null; state: DataState; error?: string }>;
}
export interface Settings {
  catalogRefreshMs: number;
  monitorRefreshMs: number;
  catalogTtlMs: number;
  balanceStaleMs: number;
  maxAttempts: number;
  connectTimeoutMs: number;
  firstEventTimeoutMs: number;
  idleTimeoutMs: number;
  requestTimeoutMs: number;
  usdCny: number | null;
  minEstimateRatio: number;
  timezone: 'Asia/Shanghai';
  fallback: Record<string, string[]>;
}
export const DEFAULT_SETTINGS: Settings = {
  catalogRefreshMs: 900_000, monitorRefreshMs: 120_000,
  catalogTtlMs: 86_400_000, balanceStaleMs: 360_000,
  maxAttempts: 3, connectTimeoutMs: 15_000, firstEventTimeoutMs: 120_000,
  idleTimeoutMs: 90_000, requestTimeoutMs: 900_000,
  usdCny: null, minEstimateRatio: 0.05, timezone: 'Asia/Shanghai', fallback: {},
};
