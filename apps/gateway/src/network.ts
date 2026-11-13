import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher, type buildConnector } from 'undici';
import { SocksClient } from 'socks';
import { connect as tlsConnect } from 'node:tls';

/** 每个供应商复用连接池。所有网络访问都禁止自动重定向和隐式重试。 */
export class Transport {
  private dispatchers = new Map<string, Dispatcher>();
  fetch(proxyUrl: string | undefined, connectTimeoutMs: number): typeof globalThis.fetch {
    const key = `${proxyUrl ?? 'direct'}|${connectTimeoutMs}`;
    let dispatcher = this.dispatchers.get(key);
    if (!dispatcher) {
      if (!proxyUrl) dispatcher = new Agent({ connect: { timeout: connectTimeoutMs }, headersTimeout: 0, bodyTimeout: 0 });
      else {
        const proxy = new URL(proxyUrl);
        if (['http:', 'https:'].includes(proxy.protocol)) {
          const username = decodeURIComponent(proxy.username); const password = decodeURIComponent(proxy.password);
          proxy.username = ''; proxy.password = '';
          dispatcher = new ProxyAgent({ uri: proxy.href,
            token: username || password ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : undefined,
            connect: { timeout: connectTimeoutMs }, requestTls: { timeout: connectTimeoutMs }, proxyTls: { timeout: connectTimeoutMs }, headersTimeout: 0, bodyTimeout: 0 });
        } else if (['socks5:', 'socks5h:'].includes(proxy.protocol)) {
          const connector: buildConnector.connector = (options, callback) => {
            let called = false;
            const done: buildConnector.Callback = (...args) => { if (!called) { called = true; callback(...args); } };
            void SocksClient.createConnection({
              command: 'connect', timeout: connectTimeoutMs,
              proxy: { host: proxy.hostname, port: Number(proxy.port || 1080), type: 5, userId: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) },
              destination: { host: options.hostname, port: Number(options.port || (options.protocol === 'https:' ? 443 : 80)) },
            }).then(({ socket }) => {
              if (options.protocol !== 'https:') { done(null, socket); return; }
              const tls = tlsConnect({ socket, servername: options.servername || options.hostname });
              const timeout = setTimeout(() => { tls.destroy(); done(new Error('TLS连接超时'), null); }, connectTimeoutMs);
              tls.once('secureConnect', () => { clearTimeout(timeout); done(null, tls); });
              tls.once('error', error => { clearTimeout(timeout); done(error, null); });
            }).catch(() => done(new Error('SOCKS5代理连接失败'), null));
          };
          dispatcher = new Agent({ connect: connector, headersTimeout: 0, bodyTimeout: 0 });
        } else throw new Error('代理仅支持HTTP、HTTPS或SOCKS5');
      }
      this.dispatchers.set(key, dispatcher);
    }
    const active = dispatcher;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await undiciFetch(input instanceof Request ? input.url : input, {
        ...init, redirect: 'error', dispatcher: active,
      } as Parameters<typeof undiciFetch>[1]);
      return response as unknown as Response;
    }) as typeof globalThis.fetch;
  }
  async close(): Promise<void> { await Promise.all([...this.dispatchers.values()].map(d => d.close())); this.dispatchers.clear(); }
}
