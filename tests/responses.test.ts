import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../apps/gateway/src/store.js';
import { ProviderRegistry } from '../apps/gateway/src/providers.js';
import { createApp } from '../apps/gateway/src/server.js';
import type { ProviderAccount, ProviderModel } from '../packages/contracts/src/index.js';

test('仅SSE的订阅上游可聚合为非流式Responses并保留工具和用量', async () => {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  const account: ProviderAccount = { id: 'a', namespace: 'subscription', name: 'Subscription', plugin: 'fixture', baseUrl: 'https://upstream.test', billingType: 'subscription', enabled: true, autoCreateTokens: false, options: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const model: ProviderModel = { path: 'model', upstreamModel: 'model', name: 'Model', family: 'test', protocol: 'responses', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 10000, output: 1000 }, variants: {}, price: { kind: 'token', currency: 'USD', input: 0, output: 0 }, referencePrice: { kind: 'token', currency: 'USD', input: 1, output: 2 } };
  const registry = new ProviderRegistry();
  registry.register({ id: 'fixture', name: 'fixture', discover: async () => ({ complete: true, models: [model] }), prepare: async (_ctx, _model, body) => ({ url: 'https://upstream.test/responses', headers: {}, body: { ...body, stream: true }, responseFormat: 'sse' }) });
  store.saveAccount(account); store.replaceCatalog(account, [model], new Date().toISOString());
  const device = store.createDevice('test');
  const completed = { id: 'resp-1', status: 'completed', output: [{ type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{}' }], usage: { input_tokens: 20, output_tokens: 10 } };
  const app = await createApp({ store, registry, background: false, fetch: (async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return new Response(`data: ${JSON.stringify({ type: 'response.output_item.added', item: completed.output[0] })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch });
  try {
    const result = await app.inject({ method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${device.key}` }, payload: { model: 'subscription/model', input: 'test', stream: false } });
    assert.equal(result.statusCode, 200); assert.deepEqual(result.json(), completed);
    assert.equal(store.attempts()[0]?.usage?.input, 20);
    assert.equal(store.attempts()[0]?.estimatedCost?.amount, 0);
    assert.equal(store.attempts()[0]?.equivalentUsd, 0.00004);
    assert.equal(store.requests()[0]?.status, 'succeeded');
  } finally { await app.close(); store.close(); }
});
