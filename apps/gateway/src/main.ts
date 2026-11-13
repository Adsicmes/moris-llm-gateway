import { resolve } from 'node:path';
import { Store } from './store.js';
import { ProviderRegistry } from './providers.js';
import type { ProviderPlugin } from '../../../packages/provider-sdk/src/index.js';
import { createApp } from './server.js';
import { DailyLog } from './logging.js';
import { runBackup } from '../../../scripts/backup.js';

const dataDir = resolve(process.env.MORIS_DATA_DIR ?? 'data');
const key = process.env.MORIS_MASTER_KEY;
if (!key) throw new Error('请配置MORIS_MASTER_KEY，参见.env.example与部署文档');
const store = new Store(resolve(dataDir, 'moris.sqlite'), key);
if (!store.getMeta('admin')) store.initializeAdmin(process.env.MORIS_ADMIN_USERNAME ?? 'admin', process.env.MORIS_ADMIN_PASSWORD ?? '');
const registry = new ProviderRegistry();
for (const name of ['realseek', 'deepseek', 'vm2api', 'openai-subscription']) {
  const module = await import(`../../../packages/providers/${name}/src/index.js`) as { default: ProviderPlugin };
  registry.register(module.default);
}
// 仅服务器部署者配置可信已安装包，管理API不提供上传执行入口。
for (const name of (process.env.MORIS_PLUGIN_PACKAGES ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
  if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error('MORIS_PLUGIN_PACKAGES必须为已安装npm包名');
  const module = await import(name) as { default: ProviderPlugin }; registry.register(module.default);
}
const app = await createApp({ store, registry, secureCookie: process.env.MORIS_SECURE_COOKIE !== 'false', adminDist: resolve(process.env.MORIS_ADMIN_DIST ?? 'apps/admin/dist'), logger: { level: 'info', stream: new DailyLog(resolve(dataDir, 'logs')), redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie', 'password', 'secrets'] } });
let backingUp: Promise<void> | undefined;
const backupTick = () => {
  const day = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  if (backingUp || store.getMeta('lastBackupDay') === day) return;
  backingUp = runBackup(resolve(dataDir, 'moris.sqlite'), resolve(process.env.MORIS_BACKUP_DIR ?? 'backups')).then(() => {
    store.setMeta('lastBackupDay', day); app.log.info({ event: 'backup_completed' });
  }).catch(() => { app.log.error({ event: 'backup_failed' }, '本地备份失败，请检查存储空间和权限'); }).finally(() => { backingUp = undefined; });
};
const backupTimer = setInterval(backupTick, 60_000); backupTimer.unref();
let closing = false;
async function close(): Promise<void> { if (closing) return; closing = true; clearInterval(backupTimer); await app.close(); await backingUp; store.close(); }
process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
await app.listen({ host: process.env.MORIS_HOST ?? '127.0.0.1', port: Number(process.env.MORIS_PORT ?? 8787) });
backupTick();
