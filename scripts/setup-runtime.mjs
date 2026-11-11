import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, writeFile, copyFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { prepareBundledAgents } from './prepare-bundled-agents.mjs';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const runtime = path.join(root, '.runtime');
await mkdir(path.join(runtime, 'downloads'), { recursive: true });
async function download(url, name, sha256) {
  const file = path.join(runtime, 'downloads', name);
  let bytes; try { bytes = await readFile(file); } catch {}
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== sha256) {
    console.log(`Downloading ${name}`); const response = await fetch(url); if (!response.ok) throw new Error(`${response.status} ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`Checksum mismatch: ${name}`);
    await writeFile(file, bytes);
  }
  return file;
}
function execute(executable, args) { return new Promise((resolve, reject) => { const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: 'inherit' }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Process exited ${code}`))); }); }
const zcode = await download('https://github.com/zai-org/ZCode/releases/download/v3.17.2/ZCode-3.17.2-win-x64.exe', 'zcode-3.17.2.exe', '2466b25b747918a8bdf8a2ef71419e377ede60541e9e8f3c88771de07855dc3d');
const sevenZip = require('7zip-bin').path7za;
const nodeZip = await download('https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip', 'node-24.18.0.zip', '0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821');
const nodeStage = path.join(runtime, 'downloads', 'node-stage');
await execute(sevenZip, ['x', nodeZip, 'node-v24.18.0-win-x64/node.exe', 'node-v24.18.0-win-x64/LICENSE', 'node-v24.18.0-win-x64/node_modules/npm/*', `-o${nodeStage}`, '-y']);
await mkdir(path.join(runtime, 'node'), { recursive: true });
await copyFile(path.join(nodeStage, 'node-v24.18.0-win-x64', 'node.exe'), path.join(runtime, 'node', 'node.exe'));
await copyFile(path.join(nodeStage, 'node-v24.18.0-win-x64', 'LICENSE'), path.join(runtime, 'node', 'LICENSE'));
await cp(path.join(nodeStage, 'node-v24.18.0-win-x64', 'node_modules', 'npm'), path.join(runtime, 'node', 'node_modules', 'npm'), { recursive: true });
await execute(sevenZip, ['x', zcode, 'resources/glm/*', 'resources/tools/*', 'resources/config/*', 'resources/THIRD-PARTY-NOTICES.md', `-o${path.join(runtime, 'zcode')}`, '-y']);
await mkdir(path.join(runtime, 'zcode', 'resources', 'glm', 'provider'), { recursive: true });
await copyFile(path.join(runtime, 'zcode', 'resources', 'config', 'provider', 'zcode-builtin.json'), path.join(runtime, 'zcode', 'resources', 'glm', 'provider', 'zcode-builtin.json'));
const zcodeLicense = await download('https://raw.githubusercontent.com/zai-org/ZCode/a9fe401eede6e6e5e01be9048679c206fe6f02d9/LICENSE', 'zcode-LICENSE', 'fa36dc312bc4946b1c22dba3c726ad8d3052b353f81424e7b997dbb3d9b40a49');
await copyFile(zcodeLicense, path.join(runtime, 'zcode', 'LICENSE'));
await mkdir(path.join(runtime, 'dsh'), { recursive: true });
const npmPath = process.env.npm_execpath?.includes('npm-cli') ? process.env.npm_execpath : path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
await access(npmPath).catch(() => { throw new Error('npm is required to prepare the development runtime'); });
await execute(process.execPath, [npmPath, 'install', '--prefix', path.join(runtime, 'dsh'), '--save-exact', '--no-audit', '--no-fund', '@deepseek-ai/dsh@0.2.2-rc.1']);
await writeFile(path.join(runtime, 'versions.json'), JSON.stringify({ node: '24.18.0', dsh: '0.2.2-rc.1', zcode: '3.17.2', zcodeCli: '0.17.1' }, null, 2));
await prepareBundledAgents();
console.log('Native runtimes are ready. Run pnpm desktop.');
