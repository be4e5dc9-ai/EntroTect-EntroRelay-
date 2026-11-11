import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { Harness, LaunchConfig } from '../shared/types';
import { isAgentHarness } from '../shared/harnesses';
import { setupRequests } from './controller';
import { dshIntegration } from './dsh-integration';
import { nativeSqlite } from './native-sqlite';
import { RpcProcess } from './rpc';
import { codexWindowsPackage, harnessEntry, openCodeWindowsPackage } from './settings';
import { atomicJson } from './store';
import { verifyAgentRuntime } from './runtime-agent-probe';

const execute = promisify(execFile);
const npmPackages = { deepseek: '@deepseek-ai/dsh', kimi: '@moonshot-ai/kimi-code', opencode: 'opencode-ai', codex: '@openai/codex' } as const;
const npmRegistry = 'https://registry.npmjs.org';
const zcodeRepo = 'https://github.com/zai-org/ZCode';
const zcodeApi = 'https://api.github.com/repos/zai-org/ZCode';
const metadataTimeout = 20_000;
const installTimeout = 10 * 60_000;
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isRuntimeVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 70 && versionPattern.test(value);
}

export function compareRuntimeVersions(a: string, b: string) {
  const [, ...left] = versionPattern.exec(a)!;
  const [, ...right] = versionPattern.exec(b)!;
  for (let i = 0; i < 3; i++) {
    const order = Number(left[i]) - Number(right[i]);
    if (order) return order;
  }
  if (!left[3] || !right[3]) return Number(!left[3]) - Number(!right[3]);
  const l = left[3].split('.'), r = right[3].split('.');
  for (let i = 0; i < Math.min(l.length, r.length); i++) {
    if (l[i] === r[i]) continue;
    const ln = /^\d+$/.test(l[i]), rn = /^\d+$/.test(r[i]);
    if (ln && rn) {
      const diff = BigInt(l[i]) - BigInt(r[i]);
      if (diff) return diff > 0n ? 1 : -1;
      continue;
    }
    if (ln !== rn) return ln ? -1 : 1;
    return l[i] < r[i] ? -1 : 1;
  }
  return l.length - r.length;
}

export type RuntimeRelease = { version: string; integrity?: string; assetId?: number };
export interface RuntimeSource {
  latest(harness: Harness, scratch: string, signal: AbortSignal): Promise<RuntimeRelease>;
  prepare(harness: Harness, release: RuntimeRelease, scratch: string, signal: AbortSignal): Promise<void>;
}

function npmArtifact(harness: Exclude<Harness, 'zcode'>, version: string) {
  if (harness === 'codex') {
    const platformVersion = `${version}-win32-${process.arch}`;
    const spec = `${npmPackages.codex}@${platformVersion}`;
    return { name: codexWindowsPackage, version: platformVersion, spec, install: `${codexWindowsPackage}@npm:${spec}` };
  }
  const name = harness === 'opencode' ? openCodeWindowsPackage : npmPackages[harness];
  const spec = `${name}@${version}`;
  return { name, version, spec, install: spec };
}

export async function verifyNpmRuntime(harness: Exclude<Harness, 'zcode'>, release: RuntimeRelease, directory: string) {
  const artifact = npmArtifact(harness, release.version);
  const lock = JSON.parse(await readFile(path.join(directory, 'package-lock.json'), 'utf8'));
  const installed = lock.packages?.[`node_modules/${artifact.name}`];
  if (!release.integrity || installed?.version !== artifact.version || installed.integrity !== release.integrity) throw new Error('官方 npm 安装包完整性校验失败');
}

function isolatedEnv(directory: string): NodeJS.ProcessEnv {
  const { SystemRoot, SystemDrive, windir, ComSpec, PATH, PATHEXT, ProgramFiles } = process.env;
  return { SystemRoot, SystemDrive, windir, ComSpec, PATH, PATHEXT, ProgramFiles,
    HOME: directory, USERPROFILE: directory, LOCALAPPDATA: directory, APPDATA: directory,
    TEMP: directory, TMP: directory, NO_COLOR: '1' };
}

async function response(url: string, signal: AbortSignal, timeout = metadataTimeout, redirect: RequestRedirect = 'error', accept = '*/*') {
  const result = await fetch(url, { redirect, headers: { 'User-Agent': 'EntroTect', Accept: accept }, signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
  if (!result.ok) {
    await result.body?.cancel();
    throw new Error(`官方更新源返回 HTTP ${result.status}`);
  }
  return result;
}

export class OfficialRuntimeSource implements RuntimeSource {
  constructor(private readonly runtime: string, private readonly node: string) {}

  private async npm(args: string[], scratch: string, signal: AbortSignal, timeout: number) {
    const config = path.join(scratch, 'empty.npmrc');
    await writeFile(config, '');
    return execute(this.node, [path.join(this.runtime, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args,
      '--registry', npmRegistry, '--cache', path.join(scratch, 'npm-cache'), '--userconfig', config,
      '--globalconfig', path.join(scratch, 'empty-global.npmrc'), '--fetch-retries', '0', '--fetch-timeout', '30000', '--loglevel', 'error'],
    { cwd: scratch, env: isolatedEnv(scratch), windowsHide: true, signal, timeout });
  }

  async latest(harness: Harness, scratch: string, signal: AbortSignal) {
    if (harness !== 'zcode') {
      const metadata = async (spec: string) => {
        const { stdout } = await this.npm(['view', spec, 'version', 'dist.integrity', '--json', '--prefer-online'], scratch, signal, metadataTimeout);
        return JSON.parse(stdout);
      };
      const published = await metadata(`${npmPackages[harness]}@latest`);
      const version = published?.version;
      if (!isRuntimeVersion(version)) throw new Error('官方 npm 发布版本无效');
      const artifact = npmArtifact(harness, version);
      const platform = harness === 'codex' || harness === 'opencode' ? await metadata(artifact.spec) : published;
      const integrity = platform?.['dist.integrity'];
      if (platform?.version !== artifact.version || typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
        throw new Error('官方 npm 发布缺少对应的 Windows 安装包或完整性校验');
      }
      return { version, integrity };
    }
    const { tag_name: tag, draft, prerelease, assets } = await (await response(`${zcodeApi}/releases/latest`, signal)).json();
    const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : undefined;
    if (!isRuntimeVersion(version) || draft || prerelease || version.includes('-')) throw new Error('ZCode 官方发布版本无效');
    const asset = Array.isArray(assets) && assets.find(asset => asset.name === `ZCode-${version}-win-${process.arch}.exe`);
    if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0) throw new Error('ZCode 官方发布缺少对应的 Windows 安装包');
    const integrity = typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest) ? asset.digest : undefined;
    return { version, integrity, assetId: asset.id };
  }

  async prepare(harness: Harness, release: RuntimeRelease, scratch: string, signal: AbortSignal) {
    const destination = path.join(scratch, 'runtime');
    await mkdir(destination);
    if (harness !== 'zcode') {
      const artifact = npmArtifact(harness, release.version);
      await this.npm(['install', '--prefix', destination, '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', artifact.install], scratch, signal, installTimeout);
      await verifyNpmRuntime(harness, release, destination);
    } else {
      const version = release.version;
      const filename = `ZCode-${version}-win-${process.arch}.exe`;
      const base = `${zcodeRepo}/releases/download/v${version}`;
      let checksum = release.integrity?.slice('sha256:'.length);
      if (!checksum) {
        const checksums = await (await response(`${base}/SHA256SUMS`, signal, metadataTimeout, 'follow')).text();
        checksum = checksums.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line)).find(match => match?.[2] === filename)?.[1];
      }
      if (!checksum) throw new Error('ZCode 官方校验清单中没有此 Windows 安装包');
      const archive = path.join(scratch, 'zcode-installer.exe');
      const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(installTimeout)]);
      let result = release.assetId ? await response(`${zcodeApi}/releases/assets/${release.assetId}`, downloadSignal, installTimeout, 'follow', 'application/octet-stream').catch(() => undefined) : undefined;
      // GitHub can return asset metadata instead of serving the binary.
      if (result?.headers.get('content-type')?.includes('json')) {
        await result.body?.cancel();
        result = undefined;
      }
      result ??= await response(`${base}/${filename}`, downloadSignal, installTimeout, 'follow');
      if (!result.body || new URL(result.url).protocol !== 'https:') throw new Error('ZCode 下载响应无效');
      const hash = createHash('sha256');
      let size = 0;
      await pipeline(result.body, new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > 1024 ** 3) return callback(new Error('ZCode 安装包超出大小限制'));
        hash.update(chunk);
        callback(null, chunk);
      } }), createWriteStream(archive, { flags: 'wx' }), { signal: downloadSignal });
      if (hash.digest('hex') !== checksum.toLowerCase()) throw new Error('ZCode 安装包 SHA256 校验失败');
      const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
      await execute(tar, ['-xf', archive, '-C', destination, '--', 'resources/glm', 'resources/tools', 'resources/config', 'resources/THIRD-PARTY-NOTICES.md'],
        { cwd: scratch, windowsHide: true, signal, timeout: 120_000 });
      const resources = path.join(destination, 'resources');
      const provider = path.join(resources, 'glm', 'provider');
      await mkdir(provider, { recursive: true });
      await copyFile(path.join(resources, 'config', 'provider', 'zcode-builtin.json'), path.join(provider, 'zcode-builtin.json'));
      const license = await (await response(`${zcodeApi}/contents/LICENSE?ref=v${version}`, signal)).json();
      if (license.encoding !== 'base64' || typeof license.content !== 'string') throw new Error('ZCode 官方许可文件无效');
      await writeFile(path.join(destination, 'LICENSE'), Buffer.from(license.content, 'base64'));
    }
    await verifyRuntime(harness, this.node, destination, path.join(scratch, 'probe'), signal);
  }
}

export async function verifyRuntime(harness: Harness, node: string, runtime: string, scratch: string, signal: AbortSignal) {
  await mkdir(scratch);
  const entry = harnessEntry(harness, runtime);
  const env = isolatedEnv(scratch);
  if (isAgentHarness(harness)) return verifyAgentRuntime(harness, node, entry, scratch, env, signal);
  const baseUrl = 'http://127.0.0.1:9';
  const config: LaunchConfig = { executable: node, args: [], home: scratch, provider: '', model: '', authMode: 'api', baseUrl };
  if (harness === 'deepseek') {
    const plugin = path.join(scratch, 'integration.mjs');
    const patch = path.join(scratch, 'profile.patch.json');
    await writeFile(plugin, dshIntegration);
    await atomicJson(patch, [
      { id: 'session-persistence-jsonl', config: { root: path.join(scratch, 'sessions'), compression: 'none' } },
      { insert: [{ id: 'entrotect-desktop', name: pathToFileURL(plugin).href }] },
    ]);
    config.args = [entry, '--profile', 'sdk', '--patch', patch];
    Object.assign(env, { DSH_HOME: scratch, DEEPSEEK_API_KEY: 'entrotect-update-check', DEEPSEEK_BASE_URL: baseUrl });
  } else {
    const help = await execute(node, [entry, '--help'], { cwd: scratch, env, windowsHide: true, timeout: metadataTimeout, signal });
    if (!['--prompt', '--resume', '--mode'].every(flag => help.stdout.includes(flag))) throw new Error('ZCode 命令行与当前 EntroTect 不兼容');
    config.args = [entry, 'agent-server', '--stdio'];
    Object.assign(env, { ZCODE_DATA_BASE_DIR: scratch, ZCODE_SESSION_DB_PATH: path.join(scratch, 'db.sqlite'), ZCODE_STORAGE_DIR: scratch });
  }
  async function probe(check: (rpc: RpcProcess) => Promise<void>) {
    signal.throwIfAborted();
    const rpc = new RpcProcess(config, scratch, env, harness === 'deepseek');
    const abort = () => { void rpc.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    setupRequests(rpc);
    try {
      if (harness === 'deepseek') await rpc.request('initialize', { cwd: scratch, provider: 'deepseek-official', model: 'deepseek-flash' }, metadataTimeout);
      await check(rpc);
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener('abort', abort);
      await rpc.close();
    }
  }
  const sessionId = randomUUID();
  if (harness === 'deepseek') {
    await probe(async rpc => {
      await rpc.request('session/working-directory/get', { sessionId }, metadataTimeout);
      if (!Array.isArray(await rpc.dshRequest('list', metadataTimeout, sessionId))) throw new Error('DeepSeek SDK 命令目录不兼容');
      await rpc.dshRequest('pause', metadataTimeout, sessionId);
      await rpc.dshRequest('flush', metadataTimeout, sessionId);
    });
    const history = await readdir(path.join(scratch, 'sessions'), { recursive: true });
    if (!history.some(file => path.basename(file) === 'session.v4.jsonl')) throw new Error('DeepSeek 会话文件格式不兼容');
    await probe(async rpc => { await rpc.request('session/resume', { sessionId }, metadataTimeout); });
  } else {
    const workspace = { workspacePath: scratch, workspaceKey: `entrotect:${sessionId}` };
    await probe(async rpc => {
      await rpc.request('session/list', { workspace }, metadataTimeout);
      const presentation = await rpc.request('workspace/readPresentation', { workspace }, metadataTimeout);
      if (!Array.isArray(presentation?.slashCommands)) throw new Error('ZCode 命令目录不兼容');
    });
    const id = randomUUID();
    await nativeSqlite(node, { action: 'create', target: env.ZCODE_SESSION_DB_PATH, sessionId: id, workspace: scratch, title: 'EntroTect update probe' });
    await probe(async rpc => {
      await rpc.request('session/resume', { sessionId: id, workspace }, metadataTimeout);
      await rpc.request('session/stop', { sessionId: id }, metadataTimeout);
    });
    signal.throwIfAborted();
    await nativeSqlite(node, { action: 'inspect', source: env.ZCODE_SESSION_DB_PATH, sessionId: id });
  }
}
