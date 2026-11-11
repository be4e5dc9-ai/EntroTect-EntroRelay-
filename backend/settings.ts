import { access, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { agentHarnesses, bundledHarnesses, harnesses, type AgentHarness, type BundledHarness, type ConnectionKeys, type Harness, type HarnessStartup, type HarnessUpdatePreferences, type LaunchConfig, type RuntimeHealth, type Settings, type SettingsView } from '../shared/types';
import { connectionFor, isAgentHarness } from '../shared/harnesses';
import { atomicJson } from './store';
import { zcodeReasoningRules } from '../shared/reasoning';
import { defaultAccent, isAccentColor } from '../shared/appearance';

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function startupPreferences(value?: HarnessStartup): HarnessStartup {
  const additional = Array.isArray(value?.additional) ? value.additional : [];
  return { followLast: value?.followLast !== false, additional: harnesses.filter(harness => additional.includes(harness)) };
}

function updatePreferences(value?: HarnessUpdatePreferences): HarnessUpdatePreferences {
  return Object.fromEntries(harnesses.map(harness => [harness, value?.[harness] !== false]));
}

export const codexWindowsPackage = `@openai/codex-win32-${process.arch}`;
export const openCodeWindowsPackage = `opencode-windows-${process.arch}`;

export function bundledRuntimeKey(harness: Harness) { return harness === 'deepseek' ? 'dsh' : harness; }

export function harnessEntry(harness: Harness, directory: string) {
  switch (harness) {
    case 'deepseek': return path.join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    case 'zcode': return path.join(directory, 'resources', 'glm', 'zcode.cjs');
    case 'kimi': return path.join(directory, 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
    case 'opencode': return path.join(directory, 'node_modules', openCodeWindowsPackage, 'bin', 'opencode.exe');
    case 'codex': return path.join(directory, 'node_modules', codexWindowsPackage, 'vendor',
      process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  }
}

export function defaultAgentConnection(harness: AgentHarness): LaunchConfig {
  const home = harness === 'codex' ? process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
    : harness === 'kimi' ? process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code')
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode');
  return {
    executable: `${harness}.exe`, args: harness === 'codex' ? ['app-server', '--listen', 'stdio://'] : ['acp'],
    home: path.resolve(home), provider: '', model: '', authMode: 'native',
    baseUrl: harness === 'kimi' ? 'https://api.moonshot.ai/v1' : 'https://api.openai.com/v1',
  };
}

export async function resolveAgentExecutable(executable: string) {
  const packageEntries: Record<string, string[]> = {
    'codex.exe': [harnessEntry('codex', ''), harnessEntry('codex', path.join('node_modules', '@openai', 'codex')), 'node_modules/@openai/codex/bin/codex.js'],
    'kimi.exe': [harnessEntry('kimi', '')],
    'opencode.exe': [harnessEntry('opencode', ''), harnessEntry('opencode', path.join('node_modules', 'opencode-ai'))],
  };
  const npmEntries = packageEntries[executable.toLowerCase()] ?? [];
  const candidates = path.isAbsolute(executable) ? [executable] : (process.env.PATH ?? '').split(path.delimiter)
    .filter(path.isAbsolute).flatMap(folder => [path.join(folder, executable), ...npmEntries.map(entry => path.join(folder, entry))]);
  for (const file of candidates) if (/\.(?:exe|mjs|cjs|js)$/i.test(file) && await access(file).then(() => true, () => false)) return file;
  return undefined;
}

export class SettingsStore {
  value!: Settings;
  private keys: Record<string, string> = {};
  private updatedEntries: Partial<Record<Harness, string>> = {};
  constructor(readonly root: string, readonly runtimeRoot: string, readonly node: string, private crypto: { protect(value: string): Promise<string>; unprotect(value: string): Promise<string> }) {}
  private bundledArgs(harness: BundledHarness) {
    const entry = this.updatedEntries[harness] ?? harnessEntry(harness, path.join(this.runtimeRoot, bundledRuntimeKey(harness)));
    return harness === 'deepseek'
      ? [entry, '--profile', 'sdk']
      : [entry, 'agent-server', '--stdio'];
  }
  useManagedRuntime(harness: Harness, directory: string) {
    const bundled = !isAgentHarness(harness) && this.usesBundledLauncher(harness);
    this.updatedEntries[harness] = harnessEntry(harness, directory);
    if (bundled && !isAgentHarness(harness)) this.value[harness].args = this.bundledArgs(harness);
  }
  usesManagedLauncher(harness: Harness) {
    if (!isAgentHarness(harness)) return this.usesBundledLauncher(harness);
    const config = connectionFor(this.value, harness) ?? defaultAgentConnection(harness);
    const standard = defaultAgentConnection(harness);
    return config.executable.toLowerCase() === standard.executable &&
      config.args.length === standard.args.length && config.args.every((arg, index) => arg === standard.args[index]);
  }
  async agentExecutable(harness: AgentHarness) {
    if (this.usesManagedLauncher(harness)) {
      const bundled = harnessEntry(harness, path.join(this.runtimeRoot, bundledRuntimeKey(harness)));
      for (const entry of [this.updatedEntries[harness], bundled]) {
        if (entry && await access(entry).then(() => true, () => false)) return entry;
      }
    }
    return resolveAgentExecutable((this.value.agents?.[harness] ?? defaultAgentConnection(harness)).executable);
  }
  usesBundledLauncher(harness: BundledHarness) {
    const { executable, args } = this.value[harness];
    const bundled = this.bundledArgs(harness);
    return path.isAbsolute(executable) && samePath(executable, this.node)
      && args.length === bundled.length && path.isAbsolute(args[0]) && samePath(args[0], bundled[0])
      && args.slice(1).every((arg, index) => arg === bundled[index + 1]);
  }
  async init() {
    const defaults: Settings = {
      deepseek: { executable: this.node, args: this.bundledArgs('deepseek'), home: path.join(os.homedir(), '.dsh'), provider: 'deepseek-account', model: 'deepseek-flash', authMode: 'native', baseUrl: 'https://api.deepseek.com/anthropic' },
      zcode: { executable: this.node, args: this.bundledArgs('zcode'), home: os.homedir(), provider: '', model: '', reasoning: 'high', authMode: 'native', baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
      defaultWorkspace: os.homedir(),
      history: { autoImport: true, autoExport: true },
      theme: 'light',
      accentColor: defaultAccent,
      quotaRegion: 'auto',
    };
    try { const saved = JSON.parse(await readFile(path.join(this.root, 'settings.json'), 'utf8')); delete saved.bridge; this.value = { ...defaults, ...saved, deepseek: { ...defaults.deepseek, ...saved.deepseek }, zcode: { ...defaults.zcode, ...saved.zcode } }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.value = defaults; }
    this.value.agents = Object.fromEntries(agentHarnesses.map(harness => [harness, { ...defaultAgentConnection(harness), ...this.value.agents?.[harness] }]));
    for (const harness of bundledHarnesses) {
      const config = this.value[harness];
      if (config.executable === '@bundled/node') config.executable = this.node;
      if (config.args[0] === `@bundled/${harness}`) config.args[0] = defaults[harness].args[0];
    }
    this.value.history = { ...defaults.history!, ...this.value.history };
    this.value.startup = startupPreferences(this.value.startup);
    this.value.harnessUpdates = updatePreferences(this.value.harnessUpdates);
    if (!['light', 'dark', 'system'].includes(this.value.theme ?? '')) this.value.theme = 'light';
    if (!isAccentColor(this.value.accentColor)) this.value.accentColor = defaultAccent;
    if (!['auto', 'zai', 'bigmodel'].includes(this.value.quotaRegion ?? '')) this.value.quotaRegion = 'auto';
    try { this.keys = JSON.parse(await readFile(path.join(this.root, 'credentials.v2.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // The single-instance lock is held before init. Remove only this app's
    // temporary provider files left behind by an interrupted process.
    const conversations = await readdir(path.join(this.root, 'conversations')).catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
    await Promise.all(conversations.filter(id => /^[\da-f-]{36}$/i.test(id)).map(id => this.cleanupRuntime(path.join(this.root, 'conversations', id, 'native'))));
  }
  view(): SettingsView { return { ...this.value, hasDeepseekKey: !!this.keys.deepseek, hasZcodeKey: !!this.keys.zcode, hasZcodeUsageKey: !!this.keys.zcodeUsage, hasAgentKeys: Object.fromEntries(agentHarnesses.map(harness => [harness, !!this.keys[harness]])) }; }
  async key(harness: string) { const encrypted = this.keys[harness]; if (!encrypted) return undefined; return this.crypto.unprotect(encrypted); }
  async save(value: Settings, keys?: ConnectionKeys) {
    const agents = Object.fromEntries(agentHarnesses.map(harness => [harness, { ...defaultAgentConnection(harness), ...this.value.agents?.[harness], ...value.agents?.[harness] }]));
    for (const config of [value.deepseek, value.zcode, ...Object.values(agents)]) {
      if (!config.executable.trim() || !path.isAbsolute(config.home) || !Array.isArray(config.args) || config.args.some(a => typeof a !== 'string')) throw new Error('执行路径、参数数组或原生数据目录无效');
    }
    if (!path.isAbsolute(value.defaultWorkspace)) throw new Error('默认工作目录无效');
    if (value.theme && !['light', 'dark', 'system'].includes(value.theme)) throw new Error('主题选项无效');
    if (value.accentColor !== undefined && !isAccentColor(value.accentColor)) throw new Error('强调色选项无效');
    if (value.quotaRegion && !['auto', 'zai', 'bigmodel'].includes(value.quotaRegion)) throw new Error('用量地区选项无效');
    const savedKeys = { ...this.keys };
    for (const name of [...harnesses, 'zcodeUsage'] as const) {
      const key = keys?.[name];
      if (typeof key === 'string' && key.trim()) savedKeys[name] = await this.crypto.protect(key.trim());
    }
    if (keys?.zcodeUsage === null) delete savedKeys.zcodeUsage;
    if (Object.keys(savedKeys).some(name => savedKeys[name] !== this.keys[name]) || keys?.zcodeUsage === null && this.keys.zcodeUsage) {
      await atomicJson(path.join(this.root, 'credentials.v2.json'), savedKeys);
      this.keys = savedKeys;
    }
    const stored: Settings = {
      deepseek: { ...value.deepseek, args: [...value.deepseek.args] },
      zcode: { ...value.zcode, args: [...value.zcode.args] },
      agents,
      defaultWorkspace: value.defaultWorkspace,
      history: { autoImport: true, autoExport: true, ...value.history },
      startup: startupPreferences(value.startup ?? this.value.startup),
      harnessUpdates: updatePreferences(value.harnessUpdates ?? this.value.harnessUpdates),
      autoAppUpdate: (value.autoAppUpdate ?? this.value.autoAppUpdate) !== false,
      theme: value.theme ?? this.value.theme ?? 'light',
      accentColor: value.accentColor ?? this.value.accentColor ?? defaultAccent,
      quotaRegion: value.quotaRegion ?? this.value.quotaRegion ?? 'auto',
    };
    for (const harness of ['deepseek', 'zcode'] as const) {
      const config = stored[harness];
      if (samePath(config.executable, this.node)) config.executable = '@bundled/node';
      const [entry] = this.bundledArgs(harness);
      if (config.args[0] && samePath(config.args[0], entry)) config.args[0] = `@bundled/${harness}`;
    }
    await atomicJson(path.join(this.root, 'settings.json'), stored);
    this.value = { ...value, agents, history: stored.history, startup: stored.startup, harnessUpdates: stored.harnessUpdates, autoAppUpdate: stored.autoAppUpdate, theme: stored.theme, quotaRegion: stored.quotaRegion };
    return this.view();
  }
  async environment(harness: 'deepseek' | 'zcode', nativeRoot: string, modelId?: string, reasoning?: string) {
    const config = { ...this.value[harness], ...(modelId ? { model: modelId } : {}) };
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    // Each conversation gets isolated native histories while account settings stay native.
    if (harness === 'deepseek') {
      Object.assign(env, { DSH_HOME: config.home });
      if (config.authMode === 'api') {
        const key = await this.key(harness); if (!key) throw new Error('请先在设置中保存 DeepSeek API Key');
        Object.assign(env, { DEEPSEEK_API_KEY: key, DEEPSEEK_BASE_URL: config.baseUrl });
      }
    } else {
      const db = path.join(nativeRoot, 'zcode', 'db.sqlite'); await mkdir(path.dirname(db), { recursive: true });
      Object.assign(env, { ZCODE_DATA_BASE_DIR: config.home, ZCODE_SESSION_DB_PATH: db, ZCODE_STORAGE_DIR: path.dirname(db) });
      if (config.authMode === 'api') {
        const key = await this.key(harness); if (!key) throw new Error('请先在设置中保存 GLM API Key');
        const file = path.join(nativeRoot, 'zcode', 'provider.runtime.json');
        await atomicJson(file, { schemaVersion: 1, config: { providerConfigRules: { providerRules: [{ providerId: config.provider || 'entrotect-glm', providerName: 'GLM API', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: key }, api: { type: 'openai-chat-completions', baseUrl: config.baseUrl }, personalModelIds: [config.model || 'glm-5.3'] } }] }, modelConfigRules: { providerModelRules: zcodeReasoningRules(config.model || 'glm-5.3',config.provider || 'entrotect-glm'), manualProviderModelRules: [] }, defaultModelSelection: { providerId: config.provider || 'entrotect-glm', modelId: config.model || 'glm-5.3', ...(reasoning ? {options:{reasoningLevel:reasoning}} : {}) } } });
        Object.assign(env, { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: file });
      }
    }
    return env;
  }
  async cleanupRuntime(nativeRoot: string) { await unlink(path.join(nativeRoot, 'zcode', 'provider.runtime.json')).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  async agentHealth(harness: AgentHarness): Promise<RuntimeHealth> {
    const config = this.value.agents?.[harness] ?? defaultAgentConnection(harness);
    const executable = await this.agentExecutable(harness);
    const detail = executable ? (config.authMode === 'native' ? '使用原生账号配置' : '使用 API Key')
      : this.usesManagedLauncher(harness) ? '内置运行时缺失，请重新解压 EntroTect' : '请检查连接设置中的启动文件';
    return { harness, available: !!executable, executable: executable ?? config.executable, detail };
  }
  async health() {
    const bundled = bundledHarnesses.map(async harness => {
      const config = this.value[harness];
      try { await access(config.executable); if (config.args[0] && /\.(?:mjs|cjs|js)$/.test(config.args[0])) await access(config.args[0]); return { harness, available: true, executable: config.executable, detail: config.authMode === 'native' ? '使用原生账号配置' : '使用 API Key' }; }
      catch { return { harness, available: false, executable: config.executable, detail: '运行时尚未就绪，请配置启动路径' }; }
    });
    const agents = agentHarnesses.map(harness => this.agentHealth(harness));
    return Promise.all([...bundled, ...agents]);
  }
}
