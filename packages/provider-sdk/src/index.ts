import type { Money, Price, Protocol, ProviderAccount, ProviderModel, ProviderMonitor, Usage } from '../../contracts/src/index.js';
export type * from '../../contracts/src/index.js';
export interface ProviderContext {
  account: ProviderAccount;
  secrets: Record<string, string>;
  /** 已配置代理，且不自动重试。 */
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
  now: () => Date;
  updateSecrets: (patch: Record<string, string>) => Promise<void>;
}
export interface Discovery {
  models: ProviderModel[];
  /** 只有完整且权限明确的目录才能替换旧快照。 */
  complete: boolean;
  warnings?: string[];
}
export interface PreparedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** 上游仅支持SSE时，核心可为非流式Responses调用聚合完成事件。 */
  responseFormat?: 'sse';
}
export interface Settlement {
  upstreamRequestId: string;
  money: Money;
  source: string;
}
export interface ProviderPlugin {
  id: string;
  name: string;
  discover(context: ProviderContext): Promise<Discovery>;
  prepare(context: ProviderContext, model: ProviderModel, body: Record<string, unknown>, protocol: Protocol): Promise<PreparedRequest>;
  monitor?(context: ProviderContext): Promise<ProviderMonitor>;
  /** 仅精确关联的请求可用于真实结算。 */
  reconcile?(context: ProviderContext, since: string): Promise<Settlement[]>;
  estimate?(price: Price, usage: Usage, body: Record<string, unknown>): Money | null;
  authorization?: {
    start(context: ProviderContext): Promise<DeviceAuthorization>;
    poll(context: ProviderContext, grant: DeviceAuthorization): Promise<AuthorizationResult>;
  };
}
export interface DeviceAuthorization {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: string;
}
export type AuthorizationResult =
  | { state: 'pending'; intervalSeconds: number; message: string }
  | { state: 'complete'; accountId: string; planType?: string; email?: string; expiresAt: string };
export class ProviderError extends Error {
  constructor(message: string, public readonly code = 'provider_error', public readonly status = 502) {
    super(message); this.name = 'ProviderError';
  }
}
export async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new ProviderError(`上游接口返回HTTP ${response.status}`, 'upstream_http', response.status);
  return response.json();
}
export function protocolPath(protocol: Protocol): string {
  return protocol === 'responses' ? '/responses' : protocol === 'messages' ? '/messages' : '/chat/completions';
}
export function apiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base.endsWith('/v1') ? base : `${base}/v1`}${path}`;
}
