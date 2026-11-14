import { z } from 'zod';
import type { ProviderAccount, ProxyDiagnostic, ProxyProfile } from '../../../packages/contracts/src/index.js';
import type { Store } from './store.js';

export const proxyInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  protocol: z.enum(['http', 'https', 'socks5', 'socks5h']),
  host: z.string().trim().min(1).max(253).refine(value => {
    try {
      if (/[\s/@?#\\]/.test(value)) return false;
      const url = new URL(`http://${value}:12345`);
      return url.hostname === value.toLowerCase() && url.port === '12345';
    } catch { return false; }
  }, '只填写主机名或 IP；IPv6 使用方括号，不要包含协议、端口或认证'),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(255).refine(value => !/[\r\n:]/.test(value), '用户名不能含冒号或换行'),
  passwordAction: z.enum(['keep', 'replace', 'clear']),
  password: z.string().max(255).optional(),
}).strict().superRefine((data, ctx) => {
  if (data.passwordAction === 'replace' && !data.password) ctx.addIssue({ code: 'custom', path: ['password'], message: '替换密码时需要填写新密码' });
  if (data.passwordAction !== 'replace' && data.password !== undefined) ctx.addIssue({ code: 'custom', path: ['password'], message: '只有替换操作可提交密码' });
  if (data.protocol.startsWith('socks') && (Buffer.byteLength(data.username) > 255 || Buffer.byteLength(data.password ?? '') > 255)) ctx.addIssue({ code: 'custom', path: ['username'], message: 'SOCKS5 账号密码各不能超过 255 字节' });
});

export function proxyUrl(profile: ProxyProfile, password: string): string {
  const url = new URL(`${profile.protocol}://${profile.host}:${profile.port}`);
  url.username = encodeURIComponent(profile.username);
  url.password = encodeURIComponent(password);
  return url.href;
}

/** 显式绑定失败必须关闭出口，不能降级直连。旧内联配置只在没有新绑定时生效。 */
export function accountProxy(store: Store, account: ProviderAccount): string | undefined {
  if (account.proxyId === null) return undefined;
  if (account.proxyId !== undefined) {
    const profile = store.proxy(account.proxyId);
    if (!profile) throw new Error('供应商绑定的代理档案不存在，请重新选择代理');
    return proxyUrl(profile, store.proxyPassword(profile.id));
  }
  return store.secrets(account.id).__proxyUrl ?? account.proxyUrl;
}

/** 仅输出固定类别，不把代理 URL、上游正文或底层异常发给浏览器。 */
export function proxyFailure(error: unknown): ProxyDiagnostic {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const item = current as { code?: string; message?: string; cause?: unknown };
    if (item.code === 'PROXY_AUTH' || /Proxy response \(407\)|Proxy Authentication Required \(407\)/.test(item.message ?? '')) return { ok: false, code: 'proxy_auth', message: '代理认证失败，请检查用户名、密码和代理支持的认证方式。' };
    if (['TimeoutError', 'AbortError'].includes((current as Error).name) || ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(item.code ?? '')) return { ok: false, code: 'timeout', message: '探测超时，请检查网关到代理及目标站点的网络。' };
    current = item.cause;
  }
  return { ok: false, code: 'connection_failed', message: '连接或 TLS 握手失败，请检查代理监听地址、端口、防火墙和证书。' };
}
