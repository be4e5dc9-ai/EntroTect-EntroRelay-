import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectionFor, harnessNames, nativeModel, supportsIsolatedLogin } from '../shared/harnesses';
import type { AgentHarness, Conversation, ModelReasoning, NativeBinding, NativeHistory, NativeModelCatalog, Settings } from '../shared/types';
import { AgentClient } from './agent-client';
import { publishCodexHistory, readCodexHistory, writeCodexHistory } from './codex-history';
import { appendKimiHistory, kimiHistoryVersion, readKimiCheckpoint, readKimiHistory, writeKimiHistory, type KimiCheckpoint } from './kimi-history';
import { appendOpenCodeHistory, openCodePartCursor, readOpenCodeStorage, writeOpenCodeHistory } from './opencode-history';
import type { NativeTokenReport } from './token-activity';
import { kimiNativeUsage } from './kimi-usage';
import { bridgeEntries, codexHistoryItems, completedEntries, contextSuffix, messagesToBridge, nativeContentFingerprint, portableHistoryFingerprint, unpublishedEntries, type PortableEntry } from './portable-history';
import { defaultAgentConnection, type SettingsStore } from './settings';
import { projectKey } from '../shared/project-path';
import type { NativeCommitState } from './history';

async function knownCodexWriters(client: AgentClient, activity: NativeCommitState) {
  const writers = activity.codexWriters;
  if (!client.hasVerifiedCodexWriterLock || !writers?.length) return false;
  const executable = await realpath(client.executable).catch(() => undefined);
  if (!executable) return false;
  const identities = await Promise.all(writers.map(writer => writer && path.isAbsolute(writer) ? realpath(writer).catch(() => undefined) : undefined));
  return identities.every(identity => identity && projectKey(identity) === projectKey(executable));
}

export class Agents {
  private catalogSettings?: Settings;
  private catalogs = new Map<string, { expires: number; value: Promise<NativeModelCatalog> }>();
  private codexStarting = new Map<string, Promise<AgentClient>>();
  constructor(readonly settings: SettingsStore) {}

  config(harness: AgentHarness) { return connectionFor(this.settings.value, harness) ?? defaultAgentConnection(harness); }

  location(harness: AgentHarness) {
    const config = this.config(harness);
    if (config.authMode === 'native' && config.isolatedNative && supportsIsolatedLogin(harness)) {
      return path.join(this.settings.root, 'agents', `${harness}-account`);
    }
    return config.authMode === 'api' || harness === 'opencode' ? path.join(this.settings.root, 'agents', harness) : config.home;
  }

  private async environment(harness: AgentHarness, location: string) {
    const config = this.config(harness);
    const ownsLocation = [harness, `${harness}-account`].some(name => projectKey(location) === projectKey(path.join(this.settings.root, 'agents', name)));
    if (ownsLocation) await mkdir(location, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    if (harness === 'kimi') env.KIMI_CODE_HOME = location;
    if (harness === 'codex') {
      env.CODEX_HOME = location;
      if (ownsLocation) env.CODEX_SQLITE_HOME = location;
      else if (projectKey(location) !== projectKey(config.home)) delete env.CODEX_SQLITE_HOME;
    }
    if (harness === 'opencode') {
      env.OPENCODE_DB = path.join(location, 'opencode.db');
      const data = config.authMode === 'native' && location === this.location(harness) ? config.home : location;
      env.XDG_DATA_HOME = path.dirname(data);
    }
    const api = config.authMode === 'api' && location === this.location(harness);
    const key = api ? await this.settings.key(harness) : undefined;
    if (api && !key) throw new Error(`请先在设置中保存 ${harnessNames[harness]} API Key`);
    if (api) {
      const endpoint = new URL(config.baseUrl);
      if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('API 地址必须是有效的 HTTP(S) 地址');
      if (['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
        env.NO_PROXY = [env.NO_PROXY ?? env.no_proxy, endpoint.hostname.replace(/^\[|\]$/g, '')].filter(Boolean).join(',');
        env.no_proxy = env.NO_PROXY;
      }
    }
    if (key && harness === 'kimi') {
      if (!config.model) throw new Error('请在 Kimi Code 连接中填写 API 模型');
      Object.assign(env, { KIMI_MODEL_API_KEY: key, KIMI_MODEL_PROVIDER_TYPE: 'openai', KIMI_MODEL_BASE_URL: config.baseUrl, KIMI_MODEL_NAME: config.model });
    }
    if (key && harness === 'opencode') {
      const model = openCodeModel(config.model, config.provider || 'entrotect');
      if (!model) throw new Error('请在 OpenCode 连接中填写 API 模型');
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: `${model.providerID}/${model.modelID}`, provider: {
        [model.providerID]: { npm: '@ai-sdk/openai-compatible', name: 'EntroTect', options: { apiKey: key, baseURL: config.baseUrl }, models: { [model.modelID]: { name: model.modelID } } },
      } });
    }
    return { env, key };
  }

  async requireExecutable(harness: AgentHarness) {
    const entry = await this.settings.agentExecutable(harness);
    if (!entry) throw new Error(`${harnessNames[harness]} 的启动文件不可用。${this.settings.usesManagedLauncher(harness) ? '请重新解压 EntroTect' : '请检查连接设置'}`);
    return entry;
  }

  private async command(harness: AgentHarness) {
    const config = this.config(harness);
    const entry = await this.requireExecutable(harness);
    const script = /\.(mjs|cjs|js)$/i.test(entry);
    return { executable: script ? this.settings.node : entry, prefix: script ? [entry] : [], args: config.args };
  }

  async loginCommand(harness: AgentHarness) {
    const config = this.config(harness);
    if (!supportsIsolatedLogin(harness) || config.authMode !== 'native' || !config.isolatedNative) throw new Error('请先保存独立登录设置');
    const { executable, prefix } = await this.command(harness);
    const home = this.location(harness);
    await mkdir(home, { recursive: true });
    return { executable, args: [...prefix, 'login'], home };
  }

  async connect(harness: AgentHarness, cwd: string, location = this.location(harness), probe = false) {
    if (harness !== 'codex') return this.openClient(harness, cwd, location, probe);
    // Probes and the first turn can start together. The first App Server must
    // finish initializing the profile database before another one opens it.
    const key = projectKey(location);
    const previous = this.codexStarting.get(key);
    const startup = (previous?.catch(() => undefined) ?? Promise.resolve()).then(() => this.openClient(harness, cwd, location, probe));
    this.codexStarting.set(key, startup);
    try { return await startup; }
    finally { if (this.codexStarting.get(key) === startup) this.codexStarting.delete(key); }
  }

  private async openClient(harness: AgentHarness, cwd: string, location: string, probe: boolean) {
    const { executable, prefix, args } = await this.command(harness);
    const { env, key } = await this.environment(harness, location);
    if (probe && harness === 'opencode') env.OPENCODE_DB = ':memory:';
    const overrides: string[] = [];
    let apiLogin = false;
    if (harness === 'codex' && key) {
      const { baseUrl } = this.config(harness);
      apiLogin = baseUrl.replace(/\/$/, '') === 'https://api.openai.com/v1';
      overrides.push('-c', 'cli_auth_credentials_store="ephemeral"');
      if (!apiLogin) {
        env.ENTROTECT_CODEX_API_KEY = key;
        overrides.push('-c', 'model_provider="entrotect_api"', '-c', 'model_providers.entrotect_api.name="EntroTect API"',
          '-c', `model_providers.entrotect_api.base_url=${JSON.stringify(baseUrl)}`,
          '-c', 'model_providers.entrotect_api.env_key="ENTROTECT_CODEX_API_KEY"', '-c', 'model_providers.entrotect_api.wire_api="responses"');
      }
    }
    const client = await AgentClient.connect(harness, { executable, args: [...prefix, ...overrides, ...args] }, cwd, env);
    try {
      if (apiLogin) await client.rpc.request('account/login/start', { type: 'apiKey', apiKey: key }, 15_000);
      return client;
    } catch (error) { await client.close(); throw error; }
  }

  model(harness: AgentHarness, selected?: string) {
    const config = this.config(harness);
    if (config.authMode === 'api' && harness === 'kimi') return undefined;
    const model = nativeModel(selected) ?? nativeModel(config.model);
    if (config.authMode === 'api' && harness === 'opencode') {
      const entry = openCodeModel(model, config.provider || 'entrotect');
      return entry && `${entry.providerID}/${entry.modelID}`;
    }
    return model;
  }

  catalog(harness: AgentHarness, cwd: string, modelId: string) {
    if (this.catalogSettings !== this.settings.value) {
      this.catalogs.clear();
      this.catalogSettings = this.settings.value;
    }
    const key = JSON.stringify([harness, projectKey(cwd), modelId]);
    const cached = this.catalogs.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const entry = { expires: Date.now() + 120_000, value: this.readCatalog(harness, cwd, modelId).catch(error => {
      if (this.catalogs.get(key) === entry) this.catalogs.delete(key);
      throw error;
    }) };
    this.catalogs.set(key, entry);
    if (this.catalogs.size > 64) this.catalogs.delete(this.catalogs.keys().next().value!);
    return entry.value;
  }

  private async readCatalog(harness: AgentHarness, cwd: string, modelId: string): Promise<NativeModelCatalog> {
    const client = await this.connect(harness, cwd, undefined, true);
    const reasoning: ModelReasoning = { modelId, harness, levels: [] };
    const config = this.config(harness);
    try {
      if (harness === 'codex') {
        const rows = (await client.modelCatalog()).filter(row => !row.hidden && typeof (row.model ?? row.id) === 'string');
        const configured = config.authMode === 'api' && config.baseUrl.replace(/\/$/, '') !== 'https://api.openai.com/v1';
        const available = configured ? rows.filter(row => (row.model ?? row.id) === config.model) : rows;
        const selected = this.model(harness, modelId);
        const current = available.find(row => selected ? (row.model ?? row.id) === selected : row.isDefault) ?? (!selected ? available[0] : undefined);
        const levels = Array.isArray(current?.supportedReasoningEfforts) ? current.supportedReasoningEfforts.flatMap((item: any) =>
          typeof item?.reasoningEffort === 'string' ? [{ id: item.reasoningEffort, label: item.reasoningEffort, nativeValue: item.reasoningEffort }] : []) : [];
        return { models: available.map(row => ({ id: row.model ?? row.id, label: row.displayName || row.model || row.id })), currentModel: current?.model ?? current?.id ?? selected,
          reasoning: { ...reasoning, levels, defaultLevel: current?.defaultReasoningEffort, sourceUrl: 'https://learn.chatgpt.com/docs/app-server#models' } };
      }
      return await client.probe(cwd, async session => {
        const requested = this.model(harness, modelId);
        const declared = client.sessionModels(session);
        if (requested && requested !== declared.currentModel && !declared.models.some(model => model.id === requested)) return { ...declared, reasoning };
        await client.configureModel(session, requested);
        const selection = client.sessionModels(session);
        if (config.authMode === 'api' && harness === 'kimi') return { models: [], currentModel: config.model, reasoning };
        return { ...selection, reasoning: { ...reasoning, ...client.sessionReasoning(session) } };
      });
    } finally { await client.close(); }
  }

  async codexRateLimits() {
    const workspace = this.settings.value.defaultWorkspace;
    const cwd = (await stat(workspace).catch(() => undefined))?.isDirectory() ? workspace : this.settings.root;
    const client = await this.connect('codex', cwd);
    try {
      const { account } = await client.rpc.request('account/read', { refreshToken: false }, 8_000);
      if (account?.type !== 'chatgpt') return undefined;
      return await client.rpc.request('account/rateLimits/read', {}, 12_000);
    } finally { await client.close(); }
  }

  async kimiUsage() {
    const home = this.location('kimi');
    const { env } = await this.environment('kimi', home);
    if (!(await stat(home).catch(() => undefined))?.isDirectory()) return;
    const { executable, prefix } = await this.command('kimi');
    return kimiNativeUsage(executable, prefix, home, env);
  }

  async list(harness: AgentHarness, location: string): Promise<NativeHistory[]> {
    const client = await this.connect(harness, this.settings.value.defaultWorkspace, location);
    try {
      const rows = await Promise.all((await client.list()).map(async row => {
        const updatedAt = historyTime(row.updatedAt), createdAt = historyTime(row.createdAt) || updatedAt;
        const relative = typeof row.path === 'string' ? path.relative(location, row.path) : '';
        const file = relative.startsWith(`sessions${path.sep}`) ? await stat(row.path!).catch(() => undefined) : undefined;
        const version = harness === 'kimi' ? await kimiHistoryVersion(location, row.cwd, row.id).catch(() => undefined)
          : file ? `${file.size}:${file.mtimeMs}` : row.updatedAt === undefined ? undefined : String(row.updatedAt);
        return { id: row.id, title: row.title || '未命名对话', workspace: row.cwd, updatedAt, createdAt, version, busy: row.busy };
      }));
      return rows.sort((a, b) => b.updatedAt - a.updatedAt);
    } finally { await client.close(); }
  }

  async read(harness: AgentHarness, location: string, cwd: string, id: string, resident?: AgentClient) {
    if (harness === 'kimi') return readKimiHistory(location, cwd, id);
    if (harness === 'opencode') return readOpenCodeStorage(path.join(location, 'opencode.db'), id);
    if (resident?.harness === 'codex') return readCodexHistory(resident, location, id);
    const client = await this.connect(harness, cwd, location);
    try { return await readCodexHistory(client, location, id); }
    finally { await client.close(); }
  }

  async kimiTurn(workspace: string, binding: NativeBinding) {
    return (await readKimiHistory(binding.location ?? this.location('kimi'), workspace, binding.sessionId)).turnId;
  }

  openCodeUsageCursor(location: string, id: string) {
    return openCodePartCursor(path.join(location, 'opencode.db'), id);
  }

  private async readLocalContext(c: Conversation, file: string) {
    const [directory, resolved] = await Promise.all([
      realpath(path.join(this.settings.root, 'conversations', c.id, 'context')),
      realpath(file),
    ]);
    if (path.dirname(resolved) !== directory || ![contextSuffix, '.hbridge.json'].some(suffix => resolved.endsWith(suffix))) throw new Error('会话的原始上下文不在当前对话目录中');
    return JSON.parse(await readFile(resolved, 'utf8'));
  }

  async recoverCodexContext(c: Conversation, binding: NativeBinding) {
    if (binding.seed?.view !== 'archive' || !c.canonicalPath) return;
    const source = await this.readLocalContext(c, binding.seed.file);
    const archive = bridgeEntries(source, 'archive');
    const resume = bridgeEntries(source);
    if (!resume.length || completedEntries(resume).length >= completedEntries(archive).length) return;

    const current = bridgeEntries(await this.readLocalContext(c, c.canonicalPath), 'archive');
    // Recover only an old clone whose sole addition was the rejected prompt.
    // A clone with any additional model or tool activity keeps its thread.
    const attempted = current.at(-1);
    if (current.length !== archive.length + 1 || !attempted || !('role' in attempted) || attempted.role !== 'user' ||
        nativeContentFingerprint({ history: current.slice(0, -1) }) !== nativeContentFingerprint({ history: archive })) return;
    const file = path.join(path.dirname(c.canonicalPath), `recovered-${randomUUID()}${contextSuffix}`);
    const bundle = messagesToBridge(current, { id: c.id, title: c.title, cwd: c.workspace, createdAt: c.createdAt, updatedAt: c.updatedAt }, resume);
    await writeFile(file, JSON.stringify(bundle), { flag: 'wx' });
    return file;
  }

  async snapshot(c: Conversation, harness: AgentHarness, binding: NativeBinding, resident?: AgentClient,
    checkpoint?: KimiCheckpoint, cursor?: number | string) {
    const location = binding.location ?? this.location(harness);
    const history = harness === 'kimi' && checkpoint
      ? await readKimiCheckpoint(location, c.workspace, binding.sessionId, checkpoint)
      : await this.read(harness, location, c.workspace, binding.sessionId, resident);
    if (!history.archived.length) throw new Error(`${harnessNames[harness]} 尚未保存可转译的对话内容`);
    let archive = history.history;
    const resume = 'retained' in history ? history.retained : history.history;
    if (binding.seed) {
      const source = await this.readLocalContext(c, binding.seed.file);
      const transferred = completedEntries(bridgeEntries(source, binding.seed.view));
      // The imported prefix can omit archive-only records and compaction
      // history. Keep the source archive and add only this runtime's new events.
      const matching = completedEntries(archive);
      if (matching.length < transferred.length || portableHistoryFingerprint(matching.slice(0, transferred.length)) !== portableHistoryFingerprint(transferred)) {
        throw new Error(`${harnessNames[harness]} 的原生历史与导入记录不一致，已保留之前的统一上下文`);
      }
      const boundary = transferred.length ? archive.indexOf(matching[transferred.length - 1]) + 1 : 0;
      archive = [...bridgeEntries(source, 'archive'), ...archive.slice(boundary)];
    }
    const bundle = messagesToBridge(archive, { id: binding.sessionId, title: c.title, cwd: c.workspace, createdAt: c.createdAt, updatedAt: c.updatedAt, source: harness }, resume);
    let reports: NativeTokenReport[] = [];
    if (typeof cursor === 'number' && 'turnId' in history && history.tokenReports) {
      reports = history.tokenReports.filter(report => 'turn' in report && report.turn > cursor);
    } else if (typeof cursor === 'string' && 'records' in history && history.tokenReports) {
      reports = history.tokenReports.filter(report => report.id > cursor);
    }
    return { bundle, reports, checkpoint: { version: history.version, content: nativeContentFingerprint(history), turnId: 'turnId' in history ? history.turnId : undefined } };
  }

  async import(c: Conversation, harness: AgentHarness, file: string, location = this.location(harness), view: 'resume' | 'archive' = 'resume', publish = false): Promise<NativeBinding> {
    const messages = bridgeEntries(JSON.parse(await readFile(file, 'utf8')), view);
    let sessionId: string;
    if (harness === 'kimi') sessionId = (await writeKimiHistory(location, c.workspace, c.title, messages)).id;
    else {
      let publication: Awaited<ReturnType<typeof readCodexHistory>> | undefined;
      const client = await this.connect(harness, c.workspace, location);
      try {
        if (harness === 'codex') {
          sessionId = (await writeCodexHistory(client, c.workspace, c.title, messages)).id;
          if (publish) publication = await readCodexHistory(client, location, sessionId);
        }
        else {
          const config = this.config(harness);
          let model = openCodeModel(this.model(harness, c.modelId), config.provider);
          if (!model) {
            const probe = await client.open(c.workspace);
            model = openCodeModel(probe.configOptions?.find(option => option.id === 'model')?.currentValue ?? probe.models?.currentModelId, '');
          }
          if (!model) throw new Error('OpenCode 尚未提供默认模型，请先在连接设置中配置');
          const command = await this.command(harness);
          sessionId = await writeOpenCodeHistory({ ...command, ...(await this.environment(harness, location)) }, c.workspace, c.title, messages, model);
        }
      } finally { await client.close(); }
      if (publication) await publishCodexHistory(location, publication, sessionId);
    }
    return { sessionId, revision: c.revision, location, ...(!publish && { seed: { file, view } }) };
  }

  async append(c: Conversation, harness: AgentHarness, location: string, sessionId: string, expected: string, messages: readonly PortableEntry[], canCommit: (result: readonly PortableEntry[]) => Promise<NativeCommitState | void>) {
    if (harness === 'codex') {
      const client = await this.connect(harness, c.workspace, location);
      try {
        const original = await readCodexHistory(client, location, sessionId);
        if (original.version !== expected || original.busy) throw new Error('Codex 会话已更新或还未结束');
        const delta = unpublishedEntries(original.history, messages);
        if (!delta.length) return original.history;
        const result = [...original.history, ...delta];
        const activity = await canCommit(result);
        if (activity?.externalOpen && !await knownCodexWriters(client, activity)) {
          throw new Error('独立 Codex 正在使用其他启动程序，退出后将自动写回');
        }
        try {
          await client.open(c.workspace, sessionId);
        } catch (error) {
          if (/active writer|open in another|writer lock/i.test((error as Error).message)) {
            throw new Error('此会话已在独立 Codex 中打开，关闭该会话后将自动写回');
          }
          throw error;
        }
        const confirmed = await canCommit(result);
        if (confirmed?.externalOpen && !await knownCodexWriters(client, confirmed)) {
          throw new Error('独立 Codex 正在使用其他启动程序，退出后将自动写回');
        }
        const checked = await readCodexHistory(client, location, sessionId);
        if (checked.version !== expected || checked.busy) throw new Error('Codex 会话已更新或还未结束');
        await client.inject(sessionId, codexHistoryItems(delta));
        return result;
      } finally { await client.close(); }
    }
    const original = await this.read(harness, location, c.workspace, sessionId);
    if (original.version !== expected) throw new Error('原生会话已在独立端更新');
    const delta = unpublishedEntries(original.history, messages);
    if (!delta.length) return original.history;
    const result = [...original.history, ...delta];
    const activity = await canCommit(result);
    if (harness === 'kimi') await appendKimiHistory(location, c.workspace, sessionId, expected, delta);
    else await appendOpenCodeHistory(path.join(location, 'opencode.db'), c.workspace, sessionId, expected, messages, activity?.externalOpen);
    return result;
  }
}

function historyTime(value: string | number | undefined) {
  if (typeof value === 'string') return Date.parse(value) || 0;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return 0;
}

function openCodeModel(value?: string, fallback = '') {
  if (!value) return undefined;
  const slash = value.indexOf('/');
  const providerID = slash < 0 ? fallback : value.slice(0, slash);
  const modelID = slash < 0 ? value : value.slice(slash + 1);
  return providerID && modelID ? { providerID, modelID } : undefined;
}
