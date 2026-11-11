import { build } from 'esbuild';
import { spawn } from 'node:child_process';
await build({ entryPoints: ['tests/native-smoke.ts'], outfile: '.local/native-smoke.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node24' });
const child = spawn(process.execPath, ['.local/native-smoke.mjs'], { stdio: 'inherit', windowsHide: true });
child.on('exit', code=>process.exit(code ?? 1));
