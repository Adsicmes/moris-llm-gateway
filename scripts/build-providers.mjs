import { build } from 'esbuild';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const name of ['realseek', 'deepseek', 'vm2api', 'openai-subscription']) {
  await build({
    entryPoints: [resolve(root, `packages/providers/${name}/src/index.ts`)],
    outfile: resolve(root, `packages/providers/${name}/dist/index.js`),
    bundle: true, platform: 'node', target: 'node24', format: 'esm', sourcemap: true,
    packages: 'external', logLevel: 'info',
  });
}
