#!/usr/bin/env node
/** 开发期入口：用 tsx 加载 TS 源码；后续构建出 dist 后改为指向 dist/cli/index.js。 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'src', 'cli', 'index.ts');
const require_ = createRequire(import.meta.url);
const tsxImport = require_.resolve('tsx/esm', { paths: [here] });

const r = spawnSync(process.execPath, ['--import', tsxImport, entry], {
	stdio: 'inherit',
});
if (r.error) {
	process.stderr.write(`无法启动 test-forge: ${r.error.message}\n`);
	process.exit(2);
}
process.exit(r.status ?? 2);
