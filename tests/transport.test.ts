import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../apps/gateway/src/server.js';
import { Store } from '../apps/gateway/src/store.js';
import { ProviderRegistry } from '../apps/gateway/src/providers.js';
import { Transport } from '../apps/gateway/src/network.js';
import { proxyFailure } from '../apps/gateway/src/proxy.js';
import type { ProviderAccount, ProviderModel } from '../packages/contracts/src/index.js';

const key = () => randomBytes(32).toString('base64');

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务器未取得端口');
  return address.port;
}

async function closeServer(server: net.Server, sockets: Iterable<{ destroy: () => void }>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  const withConnections = server as net.Server & { closeAllConnections?: () => void };
  withConnections.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function waitFor(predicate: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待状态超时');
}

interface SocksStub {
  server: net.Server;
  targets: string[];
  sockets: Set<net.Socket>;
}

/** 最小 SOCKS5 服务端，支持无认证和用户名密码握手。 */
function createSocksStub(auth?: { username: string; password: string }): SocksStub {
  const targets: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));

    let buffer = Buffer.alloc(0);
    let stage: 'greeting' | 'auth' | 'request' = 'greeting';

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5) { client.destroy(); return; }
        const methods = buffer[1]!;
        if (buffer.length < 2 + methods) return;
        buffer = buffer.subarray(2 + methods);
        client.write(Buffer.from([5, auth ? 2 : 0]));
        stage = auth ? 'auth' : 'request';
      }

      if (stage === 'auth') {
        if (buffer.length < 2) return;
        const usernameLength = buffer[1]!;
        if (buffer.length < 3 + usernameLength) return;
        const passwordLength = buffer[2 + usernameLength]!;
        if (buffer.length < 3 + usernameLength + passwordLength) return;
        const valid = buffer.subarray(2, 2 + usernameLength).toString() === auth?.username && buffer.subarray(3 + usernameLength, 3 + usernameLength + passwordLength).toString() === auth?.password;
        client.write(Buffer.from([1, valid ? 0 : 1]));
        if (!valid) return;
        buffer = buffer.subarray(3 + usernameLength + passwordLength); stage = 'request';
      }

      if (buffer.length < 5) return;
      if (buffer[0] !== 5 || buffer[1] !== 1) { client.destroy(); return; }

      const atyp = buffer[3]!;
      let host: string;
      let offset: number;
      if (atyp === 1) {
        if (buffer.length < 10) return;
        host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
        offset = 8;
      } else if (atyp === 3) {
        const length = buffer[4]!;
        if (buffer.length < 7 + length) return;
        host = buffer.subarray(5, 5 + length).toString('utf8');
        offset = 5 + length;
      } else if (atyp === 4) {
        if (buffer.length < 22) return;
        host = buffer.subarray(4, 20).toString('hex');
        offset = 20;
      } else {
        client.destroy();
        return;
      }

      const port = buffer.readUInt16BE(offset);
      targets.push(`${host}:${port}`);
      client.removeListener('data', onData);

      const destination = net.connect(port, host, () => {
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        client.pipe(destination);
        destination.pipe(client);
      });
      sockets.add(destination);
      destination.on('close', () => sockets.delete(destination));
      destination.on('error', () => client.destroy());
    };

    client.on('data', onData);
  });
  return { server, targets, sockets };
}

function fixture(upstreamPort: number) {
  const store = new Store(':memory:', key());
  store.initializeAdmin('admin', 'a-test-password-only');
  const account: ProviderAccount = {
    id: 'a', namespace: 'test', name: '测试', plugin: 'test', baseUrl: 'http://127.0.0.1',
    billingType: 'metered', enabled: true, autoCreateTokens: false, options: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const model: ProviderModel = {
    path: 'g/m', upstreamModel: 'm', name: 'M', family: 'm', protocol: 'chat-completions',
    capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
    limit: { context: 10000, output: 1000 }, variants: {},
    price: { kind: 'token', currency: 'USD', input: 1, output: 2 },
  };
  store.saveAccount(account, { apiKey: 'upstream-secret' });
  store.replaceCatalog(account, [model], new Date().toISOString());

  const registry = new ProviderRegistry();
  registry.register({
    id: 'test', name: 'test',
    discover: async () => ({ complete: true, models: [model] }),
    prepare: async (_ctx, item, body) => ({
      url: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
      headers: {},
      body: { ...body, model: item.upstreamModel },
    }),
  });

  const device = store.createDevice('transport-test');
  return {
    store,
    registry,
    headers: { authorization: `Bearer ${device.key}`, 'content-type': 'application/json' },
  };
}

async function gatewayPort(app: FastifyInstance): Promise<number> {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('网关未监听');
  return address.port;
}

test('客户端流中断后取消请求，不再重试并尽力关闭上游', { timeout: 15_000 }, async () => {
  const upstreamSockets = new Set<net.Socket>();
  let upstreamRequests = 0;
  let upstreamClosed = false;
  const upstream = http.createServer((_req, res) => {
    upstreamRequests += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    // 故意不结束：等待客户端取消，而不是正常完成。
    res.on('close', () => { upstreamClosed = true; });
  });
  upstream.on('connection', (socket) => {
    upstreamSockets.add(socket);
    socket.on('close', () => upstreamSockets.delete(socket));
  });
  const upstreamPort = await listen(upstream);

  const { store, registry, headers } = fixture(upstreamPort);
  let app: FastifyInstance | undefined;
  try {
    app = await createApp({
      store,
      registry,
      secureCookie: false,
      background: false,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = await gatewayPort(app);

    const firstChunk = new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { ...headers, accept: 'text/event-stream' },
      }, (res) => {
        res.once('data', (chunk: Buffer) => {
          resolve(chunk.toString('utf8'));
          // 真实中断：收到首个有效事件后直接销毁连接。
          res.destroy();
          req.destroy();
        });
        res.once('error', reject);
      });
      req.on('error', () => undefined);
      req.end(JSON.stringify({
        model: 'test/g/m',
        stream: true,
        messages: [{ role: 'user', content: 'cancel-me' }],
      }));
    });

    assert.ok(
      (await timeout(firstChunk, 5000, '未收到首个流事件')).includes('first'),
      '首个流事件内容异常',
    );

    await waitFor(() => store.requests()[0]?.status === 'cancelled');
    await waitFor(() => store.attempts()[0]?.status === 'cancelled');
    await waitFor(() => upstreamClosed, 3000);

    // 给重试循环留出触发窗口：不应出现第二次上游请求或第二条 attempt。
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(upstreamRequests, 1);
    assert.equal(store.attempts().length, 1);
    assert.equal(store.requests().length, 1);
    assert.equal(store.requests()[0]?.status, 'cancelled');
    assert.equal(store.attempts()[0]?.number, 1);
  } finally {
    app?.server.closeAllConnections?.();
    await app?.close();
    store.close();
    await closeServer(upstream, upstreamSockets);
  }
});

test('Transport 直连请求可被 AbortSignal 中止', { timeout: 10_000 }, async () => {
  const sockets = new Set<net.Socket>();
  const server = http.createServer(() => {
    // 不响应，等待调用方中止。
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const port = await listen(server);
  const transport = new Transport();

  try {
    const fetcher = transport.fetch(undefined, 2000);
    const controller = new AbortController();
    const pending = fetcher(`http://127.0.0.1:${port}/slow`, {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();

    await assert.rejects(pending, (error: unknown) => {
      const value = error as { name?: string; message?: string };
      return value.name === 'AbortError' || /abort/i.test(String(value.message ?? error));
    });
  } finally {
    await transport.close();
    await closeServer(server, sockets);
  }
});

for (const authenticated of [false, true]) test(`HTTP CONNECT 转发（认证：${authenticated}）`, { timeout: 10_000 }, async () => {
  const targetSockets = new Set<net.Socket>();
  const target = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('proxy-ok');
  });
  target.on('connection', (socket) => {
    targetSockets.add(socket);
    socket.on('close', () => targetSockets.delete(socket));
  });
  const targetPort = await listen(target);

  const connects: string[] = [];
  const proxySockets = new Set<net.Socket | Duplex>();
  const proxy = http.createServer((_req, res) => {
    res.writeHead(400);
    res.end('proxy expects CONNECT');
  });
  proxy.on('connection', (socket) => {
    proxySockets.add(socket);
    socket.on('close', () => proxySockets.delete(socket));
  });
  proxy.on('connect', (req, clientSocket, head) => {
    if (authenticated && req.headers['proxy-authorization'] !== `Basic ${Buffer.from('user@name:p@ss#%:/中文').toString('base64')}`) { clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    connects.push(String(req.url));
    const [host, rawPort] = String(req.url).split(':');
    const upstream = net.connect(Number(rawPort), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    proxySockets.add(clientSocket);
    proxySockets.add(upstream);
    upstream.on('close', () => proxySockets.delete(upstream));
    upstream.on('error', () => clientSocket.destroy());
  });
  const proxyPort = await listen(proxy);

  const transport = new Transport();
  try {
    if (authenticated) await assert.rejects(transport.fetch(`http://wrong:password@127.0.0.1:${proxyPort}`, 2000)(`http://127.0.0.1:${targetPort}/hello`), error => proxyFailure(error).code === 'proxy_auth');
    const fetcher = transport.fetch(`http://${authenticated ? `${encodeURIComponent('user@name')}:${encodeURIComponent('p@ss#%:/中文')}@` : ''}127.0.0.1:${proxyPort}`, 2000);
    const response = await fetcher(`http://127.0.0.1:${targetPort}/hello`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'proxy-ok');
    assert.deepEqual(connects, [`127.0.0.1:${targetPort}`]);
  } finally {
    await transport.close();
    await closeServer(proxy, proxySockets);
    await closeServer(target, targetSockets);
  }
});

for (const authenticated of [false, true]) test(`SOCKS5 CONNECT 转发（认证：${authenticated}）`, { timeout: 10_000 }, async () => {
  const targetSockets = new Set<net.Socket>();
  const target = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('socks-ok');
  });
  target.on('connection', (socket) => {
    targetSockets.add(socket);
    socket.on('close', () => targetSockets.delete(socket));
  });
  const targetPort = await listen(target);

  const stub = createSocksStub(authenticated ? { username: 'user@name', password: 'p@ss#%:/中文' } : undefined);
  const proxyPort = await listen(stub.server);
  const transport = new Transport();

  try {
    if (authenticated) await assert.rejects(transport.fetch(`socks5://wrong:password@127.0.0.1:${proxyPort}`, 2000)(`http://127.0.0.1:${targetPort}/hello`), error => proxyFailure(error).code === 'proxy_auth');
    const fetcher = transport.fetch(`socks5://${authenticated ? `${encodeURIComponent('user@name')}:${encodeURIComponent('p@ss#%:/中文')}@` : ''}127.0.0.1:${proxyPort}`, 2000);
    const response = await fetcher(`http://127.0.0.1:${targetPort}/over-socks`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'socks-ok');
    assert.deepEqual(stub.targets, [`127.0.0.1:${targetPort}`]);
  } finally {
    await transport.close();
    await closeServer(stub.server, stub.sockets);
    await closeServer(target, targetSockets);
  }
});
