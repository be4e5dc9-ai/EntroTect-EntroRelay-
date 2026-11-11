import { lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { harnesses, type Harness, type HarnessUpdates, type HarnessUpdateStatus } from '../shared/types';
import { connectionFor } from '../shared/harnesses';
import { compareRuntimeVersions, isRuntimeVersion, OfficialRuntimeSource, type RuntimeSource } from './runtime-release';
import { bundledRuntimeKey, harnessEntry, type SettingsStore } from './settings';
import { atomicJson } from './store';

const checkInterval = 6 * 60 * 60_000;
type InstalledVersions = { active?: string; pending?: string };
type Check = { abort: AbortController; done: Promise<void> };

async function ownedDirectory(directory: string) {
  await mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Harness 更新目录不是本应用的普通目录');
}

export class RuntimeUpdates {
  private readonly root: string;
  private readonly installed: Partial<Record<Harness, InstalledVersions>> = {};
  private readonly current = Object.fromEntries(harnesses.map(harness => [harness, { state: 'idle' }])) as HarnessUpdates;
  private readonly checks = new Map<Harness, Check>();
  private readonly enabled = new Set<Harness>();
  private startupTimer?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;
  private stopping = false;

  constructor(private readonly settings: SettingsStore, private readonly notify: (status: HarnessUpdates) => void,
    private readonly source: RuntimeSource = new OfficialRuntimeSource(settings.runtimeRoot, settings.node)) {
    this.root = path.resolve(settings.root, 'harness-runtimes');
  }

  private directory(harness: Harness) { return path.join(this.root, harness); }
  private manifest(harness: Harness) { return path.join(this.directory(harness), 'versions.json'); }
  private isEnabled(harness: Harness) {
    return this.settings.usesManagedLauncher(harness) && this.settings.value.harnessUpdates?.[harness] !== false;
  }

  get status(): HarnessUpdates {
    const view = (harness: Harness): HarnessUpdateStatus => {
      if (!this.settings.usesManagedLauncher(harness)) return { state: 'external' };
      if (!this.isEnabled(harness)) return { state: 'idle', version: this.current[harness].version };
      return { ...this.current[harness] };
    };
    return Object.fromEntries(harnesses.map(harness => [harness, view(harness)])) as HarnessUpdates;
  }

  private publish(harness: Harness, state: HarnessUpdateStatus['state'], detail?: string) {
    const version = this.current[harness].version;
    this.current[harness] = { version, state, detail, pending: this.installed[harness]?.pending };
    if (!this.stopping) this.notify(this.status);
  }

  async init() {
    const bundled = await readFile(path.join(this.settings.runtimeRoot, 'versions.json'), 'utf8').then(JSON.parse).catch(() => ({}));
    await Promise.all(harnesses.map(async harness => {
      const base = bundled[bundledRuntimeKey(harness)];
      if (!isRuntimeVersion(base)) {
        this.publish(harness, 'error', '内置 Harness 缺少版本信息');
        return;
      }
      this.current[harness].version = base;
      try {
        await ownedDirectory(this.root);
        await ownedDirectory(this.directory(harness));
        const versions: InstalledVersions = await readFile(this.manifest(harness), 'utf8').then(JSON.parse).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return {};
        });
        if (!versions || [versions.active, versions.pending].some(version => version !== undefined && !isRuntimeVersion(version))) throw new Error('Harness 更新记录无效');
        let active = versions.active;
        if (active && (compareRuntimeVersions(active, base) <= 0 || !await this.hasRuntime(harness, active))) active = undefined;
        const pending = versions.pending;
        const previous = active ?? base;
        if (this.isEnabled(harness) && pending && compareRuntimeVersions(pending, previous) > 0 && await this.hasRuntime(harness, pending)) active = pending;
        const installed = { active };
        if (versions.active !== active || pending) await atomicJson(this.manifest(harness), installed);
        this.installed[harness] = installed;
        if (active) {
          this.settings.useManagedRuntime(harness, path.join(this.directory(harness), active));
          this.current[harness].version = active;
        }
        await this.prune(harness, active);
      } catch (error) {
        this.publish(harness, 'error', error instanceof Error ? error.message : String(error));
      }
    }));
  }

  private async hasRuntime(harness: Harness, version: string) {
    const directory = path.join(this.directory(harness), version);
    const info = await lstat(directory).catch(() => undefined);
    return !!info?.isDirectory() && !info.isSymbolicLink() &&
      !!(await lstat(harnessEntry(harness, directory)).catch(() => undefined))?.isFile();
  }

  private async prune(harness: Harness, active?: string) {
    // Only clean this app's version slots and incomplete staging directory.
    // A launcher with custom arguments may still reference an earlier slot.
    const directory = this.directory(harness);
    const config = connectionFor(this.settings.value, harness);
    const paths = config ? [config.executable, ...config.args].filter(path.isAbsolute).map(value => path.resolve(value).toLowerCase()) : [];
    const entries = await readdir(directory);
    await Promise.all(entries.filter(name => name !== active && (name === 'staging' || isRuntimeVersion(name))).map(async name => {
      const slot = path.join(directory, name);
      if (paths.some(value => value === slot.toLowerCase() || value.startsWith(slot.toLowerCase() + path.sep))) return;
      await rm(slot, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    }));
  }

  start() {
    for (const harness of harnesses) if (this.isEnabled(harness)) this.enabled.add(harness);
    this.startupTimer = setTimeout(() => this.check(), 8_000).unref();
    this.interval = setInterval(() => this.check(), checkInterval).unref();
  }

  preferencesChanged() {
    for (const harness of harnesses) {
      if (this.isEnabled(harness)) {
        if (!this.enabled.has(harness)) this.checkHarness(harness);
        this.enabled.add(harness);
      } else {
        this.enabled.delete(harness);
        this.checks.get(harness)?.abort.abort();
      }
    }
    this.notify(this.status);
  }

  check() {
    for (const harness of harnesses) this.checkHarness(harness);
    return this.status;
  }

  private checkHarness(harness: Harness) {
    const version = this.current[harness].version;
    const installed = this.installed[harness];
    if (this.stopping || !this.isEnabled(harness) || !installed || !version || installed.pending || this.checks.has(harness)) return;
    const abort = new AbortController();
    const done = this.prepare(harness, installed, version, abort.signal).finally(() => this.checks.delete(harness));
    this.checks.set(harness, { abort, done });
  }

  private async prepare(harness: Harness, installed: InstalledVersions, version: string, signal: AbortSignal) {
    const directory = this.directory(harness);
    const scratch = path.join(directory, 'staging');
    let state: HarnessUpdateStatus['state'] = 'idle';
    let detail: string | undefined;
    try {
      this.publish(harness, 'checking');
      await mkdir(scratch);
      const release = await this.source.latest(harness, scratch, signal);
      signal.throwIfAborted();
      if (!isRuntimeVersion(release.version)) throw new Error('Harness 发布版本无效');
      if (compareRuntimeVersions(release.version, version) <= 0) {
        state = 'current';
        return;
      }
      this.publish(harness, 'preparing', release.version);
      await this.source.prepare(harness, release, scratch, signal);
      signal.throwIfAborted();
      const target = path.join(directory, release.version);
      await rename(path.join(scratch, 'runtime'), target);
      try {
        signal.throwIfAborted();
        if (!await this.hasRuntime(harness, release.version)) throw new Error('Harness 更新缺少可执行入口');
        signal.throwIfAborted();
        const next = { ...installed, pending: release.version };
        await atomicJson(this.manifest(harness), next);
        this.installed[harness] = next;
        state = 'ready';
      } finally {
        if (state !== 'ready') await rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
      }
    } catch (error) {
      if (!signal.aborted) {
        state = 'error';
        detail = error instanceof Error ? error.message : String(error);
      }
    } finally {
      try { await rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); }
      catch { detail ??= '暂存目录仍被占用，将在下次启动清理'; }
      this.publish(harness, state, detail);
    }
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.startupTimer);
    clearInterval(this.interval);
    for (const check of this.checks.values()) check.abort.abort();
    await Promise.allSettled([...this.checks.values()].map(check => check.done));
  }
}
