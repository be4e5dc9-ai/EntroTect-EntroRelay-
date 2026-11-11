import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { Approval, ContextUsage, Conversation, DesktopEvent, DisplayItem, Harness, LaunchConfig, NativeBinding, RuntimeSelection } from '../shared/types';
import { Store, atomicJson } from './store';
import { SettingsStore } from './settings';
import { ContextCodec } from './codec';
import { RpcProcess } from './rpc';
import { Projection } from './projection';
import { effectiveReasoning, modelReasoning, reasoningKey } from '../shared/reasoning';
import {nativeSqlite} from './native-sqlite';
import { dshIntegration } from './dsh-integration';
import { slashCommand, type HarnessCommand } from '../shared/commands';
import { dshProjectKey } from './dsh-files';
import type { DeepSeekAccountBalance } from './account-usage';
import { ContextUsageProjection } from './context-usage';
import { projectKey } from '../shared/project-path';
import { catalogModel, defaultModel, harnessNames, isAgentHarness, isHarness, modelHarness, nativeModel } from '../shared/harnesses';
import type { AgentHarness } from '../shared/types';
import { isCodexContextOverflow, type AgentClient } from './agent-client';
import type { KimiCheckpoint } from './kimi-history';
import { Agents } from './agents';

type ResidentRuntime = {
  harness: Harness;
  key: string;
  nativeRoot: string;
  launched: Promise<RpcProcess>;
  ready: Promise<RpcProcess>;
  agent?: Promise<AgentClient>;
  sessionId?: string;
  closing?: Promise<void>;
};
type ActiveRun = {
  rpc: RpcProcess;
  runtime?: ResidentRuntime;
  settled: Promise<void>;
  finish(error?: Error): void;
  stopping: boolean;
  pause?: () => Promise<void>;
  stopTask?: Promise<boolean>;
  done?: Promise<void>;
  drain?: () => Promise<void>;
  detach(): void;
  captureContext?: () => Promise<void>;
  skipSnapshot?: boolean;
  kimiCheckpoint?: KimiCheckpoint;
  usageCursor?: number | string;
};
const pauseTimeout = 10_000;
const runtimePreferences={nativeSearchEnhancementsEnabled:true,toolSearchMode:'off',subagentRuntimeConfigEnabled:false,memoryEnabled:false,askUserQuestionAutoResolutionEnabled:false,modelContextBudgetStrategy:'preflight-v1'};
function answerPreparation(rpc: RpcProcess, frame: any) {
  if (frame.method === 'session/requestRuntimePreferences') rpc.respond(frame.id, runtimePreferences);
  else rpc.rejectRequest(frame.id, '准备会话时不执行交互请求');
}
export function setupRequests(rpc: RpcProcess) { rpc.on('request', frame => answerPreparation(rpc, frame)); }
function zcodeModel(config: LaunchConfig) {
  const providerId = config.provider || (config.authMode === 'api' ? 'entrotect-glm' : '');
  const modelId = config.model || (config.authMode === 'api' ? 'glm-5.3' : '');
  return providerId && modelId ? { providerId, modelId, ...(config.reasoning ? { options: { reasoningLevel: config.reasoning } } : {}) } : undefined;
}
const workspaceRef = (c: Conversation) => ({ workspacePath: c.workspace, workspaceKey: `entrotect:${c.id}` });

export class Controller {
  readonly codec: ContextCodec;
  readonly agents: Agents;
  private active = new Map<string, ActiveRun>();
  private residents = new Map<string, ResidentRuntime>();
  private drafts = new Map<Harness, Conversation>();
  private pendingSends = new Set<Promise<void>>();
  private lastSelection?: RuntimeSelection;
  private prewarming?: Promise<void>;
  private reconfiguring?: Promise<unknown>;
  private shuttingDown = false;
  private shutdown?: Promise<void>;
  private operations = new Set<string>();
  private exclusiveOperations = new Set<Promise<unknown>>();
  private startingStops = new Set<string>();
  private approvals = new Map<string, { rpc: RpcProcess; frame: any; harness: Harness; conversationId: string }>();
  constructor(readonly store: Store, readonly settings: SettingsStore, private emit: (event: DesktopEvent) => void) {
    this.agents = new Agents(settings);
    this.codec = new ContextCodec(store, () => settings.value, settings.node ?? process.execPath, this.agents);
  }
  isBusy(id: string) { return this.active.has(id) || this.operations.has(id); }
  hasForegroundWork() { return !!(this.active.size || this.operations.size || this.pendingSends.size || this.reconfiguring); }
  private config(c: Conversation): LaunchConfig {
    const connection = isAgentHarness(c.harness) ? this.agents.config(c.harness) : this.settings.value[c.harness];
    const model = nativeModel(c.modelId) || connection.model || (c.harness === 'zcode' && connection.authMode === 'native' ? '' : defaultModel(this.settings.value, c.harness));
    return { ...connection, model, reasoning: effectiveReasoning(c, this.settings.value) };
  }
  private agentBinding(c: Conversation, harness: AgentHarness) {
    const binding = c.bindings[harness];
    if (binding?.location && projectKey(binding.location) === projectKey(this.agents.location(harness))) return binding;
  }
  private get selectionFile() { return path.join(this.store.root, 'runtime-selection.json'); }
  async initStartup() {
    const saved = await readFile(this.selectionFile, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    if (saved) {
      try {
        const selection = JSON.parse(saved) as RuntimeSelection;
        if (isHarness(selection?.harness)) {
          this.lastSelection = { harness: selection.harness, conversationId: typeof selection.conversationId === 'string' ? selection.conversationId : undefined };
          return;
        }
      } catch { /* A damaged preference must not prevent the app from opening. */ }
    }
    const recent = this.store.list().find(c => c.revision > 0 && !c.importedFrom && !c.workspaceMissing);
    if (recent) this.rememberRuntime(recent.harness, recent.id);
  }
  rememberRuntime(harness: Harness, conversationId?: string) {
    if (this.shuttingDown || (conversationId && this.store.conversations.get(conversationId)?.harness !== harness)) return;
    this.lastSelection = { harness, conversationId };
  }
  get startupRoute(): RuntimeSelection | undefined {
    const selection = this.lastSelection;
    if (!selection || this.settings.value.startup?.followLast === false) return;
    const chat = selection.conversationId ? this.store.conversations.get(selection.conversationId) : undefined;
    return { harness: selection.harness, conversationId: chat?.harness === selection.harness ? chat.id : undefined };
  }
  startPrewarming() {
    if (this.prewarming || this.shuttingDown) return;
    const selection = this.startupRoute;
    const lastChat = selection?.conversationId ? this.store.conversations.get(selection.conversationId) : undefined;
    const workspace = lastChat && !lastChat.workspaceMissing ? lastChat.workspace : this.settings.value.defaultWorkspace;
    const wanted = new Set(this.settings.value.startup?.additional ?? []);
    if (selection) wanted.add(selection.harness);
    this.prewarming = Promise.all([...wanted].map(async harness => {
      if (harness === 'zcode' && this.settings.value.zcode.authMode === 'native') return;
      const previous = selection?.harness === harness && !lastChat?.workspaceMissing ? lastChat : undefined;
      const chat = previous ?? this.newConversation(workspace, harness);
      if (chat !== previous) this.drafts.set(harness, chat);
      if (!(await stat(chat.workspace).catch(() => null))?.isDirectory() || this.shuttingDown || this.reconfiguring || this.isBusy(chat.id) || this.residents.has(chat.id)) return;
      const runtime = this.prepareRuntime(chat, true);
      try { await runtime.ready; }
      catch { await this.releaseRuntime(chat.id, runtime).catch(() => {}); }
    })).then(() => {});
  }
  async updateConnections<T>(update: () => Promise<T>): Promise<T> {
    if (this.shuttingDown || this.reconfiguring || this.active.size || this.operations.size) throw new Error('请等待运行结束后再修改连接设置');
    const updating = (async () => {
      await Promise.all([...this.residents.keys()].map(id => this.releaseRuntime(id)));
      return update();
    })();
    this.reconfiguring = updating;
    try { return await updating; } finally { this.reconfiguring = undefined; }
  }
  async selectReasoning(id: string, level?: string) {
    return this.exclusive(id, async c => {
      const harness = c.harness;
      const model = c.modelId || defaultModel(this.settings.value, harness);
      const agent = isAgentHarness(harness);
      if (level) {
        const declared = agent ? (await this.agents.catalog(harness, c.workspace, model)).reasoning : modelReasoning(model, harness);
        if (!declared.levels.some(option => option.id === level)) throw new Error('此模型没有经过核实的该思考档位');
      }
      c.reasoningByModel = { ...c.reasoningByModel };
      const key = reasoningKey(model, c.harness);
      if (level || agent) c.reasoningByModel[key] = level ?? ''; else delete c.reasoningByModel[key];
      await this.state(c,'idle'); return c;
    });
  }
  private newConversation(workspace: string, harness: Harness, id: string = randomUUID()): Conversation {
    const now = Date.now();
    return { id, title: '新对话', workspace, harness, createdAt: now, updatedAt: now, revision: 0, state: 'idle', bindings: {} };
  }
  async create(workspace: string, harness: Harness) {
    if (!path.isAbsolute(workspace) || !(await stat(workspace)).isDirectory()) throw new Error('请选择有效的工作目录');
    if (this.shuttingDown) throw new Error('应用正在退出');
    const draft = this.drafts.get(harness);
    const reusable = draft && projectKey(draft.workspace) === projectKey(workspace) ? draft : undefined;
    if (reusable) this.drafts.delete(harness);
    const c = this.newConversation(workspace, harness, reusable?.id);
    await this.store.save(c); return c;
  }
  async exclusive<T>(id: string, action: (c: Conversation) => Promise<T>) {
    if (this.shuttingDown) throw new Error('应用正在退出');
    if (this.reconfiguring) throw new Error('连接设置正在保存，请稍后重试');
    if (this.isBusy(id)) throw new Error('请等待本轮结束或暂停完成后再迁移对话');
    this.operations.add(id);
    const task = Promise.resolve().then(() => action(this.store.get(id)));
    this.exclusiveOperations.add(task);
    try { return await task; }
    finally { this.exclusiveOperations.delete(task); this.operations.delete(id); }
  }
  async initializeDatabase(c: Conversation) {
    const rpc = await this.launch({ ...c, harness: 'zcode' }, undefined, 'offline');
    setupRequests(rpc);
    try { await rpc.request('session/list', { workspace: { workspacePath: c.workspace, workspaceKey: `entrotect:${c.id}` } }); }
    finally { await rpc.close(); await this.settings.cleanupRuntime?.(this.codec.nativeRoot(c)); }
  }
  async verifyNative(c: Conversation) {
    const binding = c.bindings[c.harness]; if (!binding) throw new Error('缺少原生会话绑定');
    if (isAgentHarness(c.harness)) {
      const client = await this.agents.connect(c.harness, c.workspace, binding.location);
      try { await client.open(c.workspace, binding.sessionId, this.agents.model(c.harness, c.modelId)); }
      finally { await client.close(); }
      return;
    }
    const rpc = await this.launch(c);
    rpc.on('request', frame => {
      if (frame.method === 'session/requestRuntimePreferences') rpc.respond(frame.id, { nativeSearchEnhancementsEnabled: true, toolSearchMode: 'off', memoryEnabled: false, subagentRuntimeConfigEnabled: false, askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1' });
      else rpc.rejectRequest(frame.id, '历史恢复验证不执行交互请求');
    });
    try {
      if (c.harness === 'deepseek') {
        const config = this.config(c);
        await rpc.request('initialize', { cwd: c.workspace, provider: config.authMode === 'api' ? 'deepseek-official' : config.provider, model: config.model, ...(config.reasoning?{reasoningEffort:config.reasoning}:{}) });
        await rpc.request('session/resume', { sessionId: binding.sessionId });
      } else await rpc.request('session/resume', { sessionId: binding.sessionId, workspace: { workspacePath: c.workspace, workspaceKey: `entrotect:${c.id}` } });
    } finally { await rpc.close(); await this.settings.cleanupRuntime?.(this.codec.nativeRoot(c)); }
  }
  private async state(c: Conversation, state: Conversation['state'], error?: string) { c.state = state; c.error = error; await this.store.save(c); this.emit({ type: 'conversation', conversation: { ...c } }); }
  private async item(c: Conversation, item: DisplayItem) { await this.store.append(c.id, 'display', item); this.emit({ type: 'item', conversationId: c.id, item }); }
  private async initializeDeepseek(c: Conversation, rpc: RpcProcess) {
    const config = this.config(c);
    await rpc.request('initialize', { cwd: c.workspace, provider: config.authMode === 'native' ? config.provider : 'deepseek-official', model: config.model, ...(config.reasoning ? { reasoningEffort: config.reasoning } : {}), approvalRequests: true, capabilities: { userQuestions: true } });
  }
  private async openDeepseek(c: Conversation, rpc: RpcProcess, sessionId: string, create: boolean) {
    if (c.bindings.deepseek) await rpc.request('session/resume', { sessionId });
    else if (create) await rpc.request('session/working-directory/get', { sessionId });
  }
  private async zcodeCommands(c: Conversation, rpc: RpcProcess): Promise<HarnessCommand[]> {
    const result = await rpc.request('workspace/readPresentation', { workspace: workspaceRef(c) }, 15_000);
    if (!Array.isArray(result?.slashCommands)) throw new Error('当前 ZCode 版本没有返回斜杠命令目录');
    return (result.slashCommands as (HarnessCommand & { source: string })[])
      .filter(command => command.source === 'custom' || ['compact', 'init'].includes(command.name))
      .map(({ name, description, inputHint }) => {
        const prefix = '/' + name;
        if (inputHint === prefix || inputHint?.startsWith(prefix + ' ')) inputHint = inputHint.slice(prefix.length).trim();
        return { name, description, inputHint };
      });
  }
  async deepseekBalance(): Promise<DeepSeekAccountBalance> {
    const id = randomUUID();
    const scratch: Conversation = { id, title: '', workspace: this.store.directory(id), harness: 'deepseek', state: 'idle', bindings: {}, revision: 0, createdAt: 0, updatedAt: 0 };
    try {
      const rpc = await this.launch(scratch, undefined, 'account');
      setupRequests(rpc);
      try {
        // Initialize the SDK host only. No session or inference request is needed.
        await rpc.request('initialize', { cwd: scratch.workspace, provider: 'deepseek-official', model: 'deepseek-flash' }, 12_000);
        return await rpc.dshRequest('balance', 12_000);
      } finally { await rpc.close(); }
    } finally { await this.store.discardUnpublished(id); }
  }
  async listCommands(harness: Harness, workspace: string, modelId: string, id?: string): Promise<HarnessCommand[]> {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || !(await stat(workspace).catch(() => null))?.isDirectory()) throw new Error('请先选择有效的工作目录');
    const existing = id ? this.store.get(id) : undefined;
    if (existing && (existing.harness !== harness || existing.workspace !== workspace || (existing.modelId && existing.modelId !== modelId))) throw new Error('当前执行环境已切换，请重新打开命令菜单');
    if (isAgentHarness(harness)) {
      const binding = existing && this.agentBinding(existing, harness);
      const resident = id ? this.residents.get(id)?.agent : undefined;
      const client = resident && binding ? await resident : await this.agents.connect(harness, workspace, binding?.location, !binding);
      try {
        if (harness === 'codex') return await client.commands();
        if (!binding) return await client.probe(workspace, session => client.commands(session.id));
        await client.open(workspace, binding.sessionId);
        return await client.commands(binding.sessionId);
      } finally { if (!resident || !binding) await client.close(); }
    }
    const scratch: Conversation = { id: randomUUID(), title: '', workspace, harness, modelId, state: 'idle', bindings: {}, revision: 0, createdAt: 0, updatedAt: 0 };
    try {
      const binding = harness === 'deepseek' ? existing?.bindings.deepseek : undefined;
      if (binding) {
        if (!/^[a-f0-9-]{36}$/i.test(binding.sessionId)) throw new Error('无效的 DeepSeek 会话 ID');
        const relative = path.join('deepseek', 'sessions', dshProjectKey(workspace), binding.sessionId);
        const target = path.join(this.codec.nativeRoot(scratch), relative);
        await mkdir(target, { recursive: true });
        await copyFile(path.join(this.codec.nativeRoot(existing!), relative, 'session.v4.jsonl'), path.join(target, 'session.v4.jsonl'));
        scratch.bindings.deepseek = binding;
      }
      const rpc = await this.launch(scratch, undefined, 'offline');
      setupRequests(rpc);
      try {
        if (harness === 'zcode') return await this.zcodeCommands(scratch, rpc);
        const sessionId = scratch.bindings.deepseek?.sessionId ?? randomUUID();
        await this.initializeDeepseek(scratch, rpc);
        await this.openDeepseek(scratch, rpc, sessionId, true);
        return await rpc.dshCommand('list', sessionId);
      } finally { await rpc.close(); }
    }
    finally { await this.store.discardUnpublished(scratch.id); }
  }
  async nativeModels(harness: AgentHarness, workspace: string, modelId: string) {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || !(await stat(workspace).catch(() => null))?.isDirectory()) throw new Error('请先选择有效的工作目录');
    if (typeof modelId !== 'string' || !modelId.trim()) throw new Error('无效模型');
    return this.agents.catalog(harness, workspace, modelId);
  }
  private async launch(c: Conversation, prompt?: string, mode: 'normal' | 'resident' | 'offline' | 'account' = 'normal') {
    if (isAgentHarness(c.harness)) throw new Error('当前执行器使用原生客户端连接');
    let config = this.config(c);
    const offline = mode === 'offline' || mode === 'account';
    const env: NodeJS.ProcessEnv = offline ? { ...process.env, NO_COLOR: '1' } : await this.settings.environment(c.harness, this.codec.nativeRoot(c), nativeModel(c.modelId), config.reasoning);
    if (offline) {
      delete env.ELECTRON_RUN_AS_NODE;
      if (c.harness === 'deepseek') env.DSH_HOME = mode === 'account' ? path.join(this.store.directory(c.id), 'account-home') : config.home;
      else {
        const db = this.codec.database(c);
        delete env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
        Object.assign(env, { ZCODE_DATA_BASE_DIR: config.home, ZCODE_SESSION_DB_PATH: db, ZCODE_STORAGE_DIR: path.dirname(db) });
        await mkdir(path.dirname(db), { recursive: true });
      }
    }
    if (c.harness === 'deepseek') {
      env.ENTROTECT_DSH_KEEP_IMPORTED_ARCHIVE_LOCAL = c.bindings.deepseek?.translated ? '1' : '0';
      const directory = path.join(this.store.directory(c.id), 'integration'); await mkdir(directory, { recursive: true });
      const plugin = path.join(directory, 'stream.mjs');
      await writeFile(plugin, dshIntegration);
      const patch = path.join(directory, 'desktop.patch.json');
      await atomicJson(patch, [
        { id: 'session-persistence-jsonl', config: { root: path.join(this.codec.nativeRoot(c), 'deepseek', 'sessions'), compression: 'none' } },
        // The SDK startup creates a browser credential and profile files. For
        // balance reads keep the home isolated and load only the native grant.
        ...(mode === 'account' ? [
          { id: 'connection', disabled: true },
          { id: 'credentials', config: { path: path.join(config.home, '.credentials.yaml'), watch: false } },
        ] : []),
        { insert: [{ id: 'entrotect-desktop', name: pathToFileURL(plugin).href }] },
      ]);
      config = { ...config, args: [...config.args, '--patch', patch] };
    } else if (prompt !== undefined && config.authMode === 'native') {
      // The official standalone entry owns native account refresh. agent-server
      // delegates that responsibility to its host and cannot reuse login alone.
      const args = config.args.filter(arg => !['agent-server', 'app-server', '--stdio'].includes(arg));
      if (prompt.length + args.join(' ').length + c.workspace.length > 27_000) throw new Error('ZCode 原生登录模式受 Windows 命令行长度限制，请缩短本条输入，或改用 API Key 模式');
      args.push('--prompt', prompt, '--cwd', c.workspace, '--mode', 'build', '--output-format', 'stream-json');
      if (c.bindings.zcode) args.push('--resume', c.bindings.zcode.sessionId);
      config = { ...config, args };
    }
    // Windows holds the process working directory open. Built-in servers
    // receive the project path through RPC, so an idle server need not lock it.
    const cwd = mode === 'resident' && this.settings.usesBundledLauncher?.(c.harness)
      ? this.store.directory(c.id) : c.workspace;
    return new RpcProcess(config, cwd, env, c.harness === 'deepseek');
  }
  private runtimeKey(c: Conversation) { return JSON.stringify([c.harness, projectKey(c.workspace), isAgentHarness(c.harness) ? this.agents.config(c.harness) : this.config(c)]); }
  private prepareRuntime(c: Conversation, prewarm: boolean): ResidentRuntime {
    const nativeRoot = this.codec.nativeRoot(c);
    const agent = isAgentHarness(c.harness) ? this.agents.connect(c.harness, c.workspace) : undefined;
    const launched = agent ? agent.then(client => client.rpc) : this.launch(c, undefined, 'resident');
    const ready = launched.then(async rpc => {
      rpc.on('request', frame => {
        const active = this.active.get(c.id);
        if (active?.rpc === rpc && !active.stopping) this.requestApproval(this.store.get(c.id), rpc, frame);
        else answerPreparation(rpc, frame);
      });
      if (c.harness === 'deepseek') await this.initializeDeepseek(c, rpc);
      else if (prewarm && c.harness === 'zcode') {
        try { await rpc.request('session/list', { workspace: workspaceRef(c) }, 15_000); }
        finally { await this.settings.cleanupRuntime?.(nativeRoot); }
      }
      return rpc;
    });
    const runtime: ResidentRuntime = { harness: c.harness, key: this.runtimeKey(c), nativeRoot, launched, ready, agent };
    this.residents.set(c.id, runtime);
    return runtime;
  }
  async releaseRuntime(id: string, runtime = this.residents.get(id)) {
    if (!runtime || this.residents.get(id) !== runtime) return;
    runtime.closing ??= (async () => {
      const rpc = await runtime.launched.catch(() => undefined);
      await rpc?.close();
      await runtime.ready.catch(() => {});
      await this.settings.cleanupRuntime?.(runtime.nativeRoot);
      if (this.residents.get(id) === runtime) this.residents.delete(id);
    })().catch(error => { runtime.closing = undefined; throw error; });
    await runtime.closing;
  }
  private async acquireRuntime(c: Conversation) {
    const current = this.residents.get(c.id);
    if (current && current.key === this.runtimeKey(c) && !current.closing) {
      const rpc = await current.ready.catch(() => undefined);
      if (rpc?.available && !current.closing && !this.startingStops.has(c.id) && !this.shuttingDown) {
        try {
          if (c.harness === 'zcode') {
            // The registry file contains the API key. Restore it only while a
            // turn is active, and tell the resident server to reload the file.
            const config = this.config(c);
            await this.settings.environment(c.harness, current.nativeRoot, nativeModel(c.modelId), config.reasoning);
            await rpc.request('provider/refreshRegistry', { reason: 'entrotect-turn' }, 15_000);
          }
          return { rpc, runtime: current };
        } catch (error) {
          // No prompt has been sent. It is safe to reopen the native session
          // if an old or disconnected server could not reload its provider.
          this.emit({ type: 'diagnostic', conversationId: c.id, message: 'ZCode 将重新启动。' + (error as Error).message });
        }
      }
    }
    if (current) await this.releaseRuntime(c.id, current);
    if (this.startingStops.has(c.id) || this.shuttingDown) throw new Error('已暂停启动');
    const runtime = this.prepareRuntime(c, false);
    return { rpc: await runtime.ready, runtime };
  }
  send(id: string, text: string) {
    const task = this.beginSend(id, text);
    this.pendingSends.add(task);
    void task.finally(() => this.pendingSends.delete(task)).catch(() => {});
    return task;
  }
  private async beginSend(id: string, text: string) {
    const c = this.store.get(id);
    if (!text.trim()) throw new Error('请输入任务内容');
    const command = slashCommand(text);
    if (text.trim() === '/') throw new Error('请选择一条斜杠命令');
    if (c.workspaceMissing||!(await stat(c.workspace).catch(()=>null))?.isDirectory()) throw new Error('项目目录已不存在，请点击项目目录按钮重新选择');
    if (this.shuttingDown) throw new Error('应用正在退出');
    if (this.reconfiguring) throw new Error('连接设置正在保存，请稍后重试');
    if (this.isBusy(id)) throw new Error('当前任务仍在运行');
    this.rememberRuntime(c.harness, id);
    if (isAgentHarness(c.harness)) return this.beginAgentSend(c, c.harness, text.trim());
    const previousRevision = c.revision;
    const previousBinding = c.bindings[c.harness] ? { ...c.bindings[c.harness]! } : undefined;
    const previousTitle = c.title, previousUpdatedAt = c.updatedAt, previousMirror = c.externalMirror;
    let submitted = false;
    this.operations.add(id);
    try {
      await this.state(c, 'starting');
      const headless = c.harness === 'zcode' && this.settings.value.zcode.authMode === 'native';
      const compact = c.harness === 'zcode' && command?.[1] === 'compact';
      if (headless && command && !(await this.listCommands(c.harness, c.workspace, this.config(c).model)).some(row => row.name === command[1])) {
        throw new Error(`ZCode 当前不支持 /${command[1]}`);
      }
      if (this.startingStops.has(id)) throw new Error('已暂停启动');
      if (c.title === '新对话') c.title = text.trim().slice(0, 30);
      c.externalMirror=false;
      c.updatedAt = Date.now(); c.revision++;
      const recordInput = () => this.item(c, { id: randomUUID(), kind: 'user', text: text.trim(), harness: c.harness, time: Date.now() });
      if (!command || headless && !compact) await recordInput();
      if (headless) {
        if (!c.bindings.zcode) {
          await this.initializeDatabase(c);
          const nativeId=`sess_${randomUUID()}`;
          await nativeSqlite(this.settings.node,{action:'create',target:this.codec.database(c),sessionId:nativeId,workspace:c.workspace,title:c.title});
          c.bindings.zcode={sessionId:nativeId,revision:c.revision-1};
        }
        await this.codec.configureZcodeModel(c,c.bindings.zcode!.sessionId);
      }
      if (this.startingStops.has(id)) throw new Error('已暂停启动');
      const { rpc, runtime } = headless
        ? { rpc: await this.launch(c, text.trim()), runtime: undefined }
        : await this.acquireRuntime(c);
      if (headless) submitted = true;
      const listeners: (() => void)[] = [];
      const listen = (name: string, handler: (frame: any) => void) => {
        rpc.on(name, handler);
        listeners.push(() => rpc.off(name, handler));
      };
      let finish!: (error?: Error) => void;
      const settled = new Promise<void>((resolve, reject) => { finish = error => error ? reject(error) : resolve(); });
      // A handler is attached immediately; native notifications can finish during startup.
      void settled.catch(() => {});
      const active: ActiveRun = { rpc, runtime, settled, finish, stopping: false, detach: () => listeners.forEach(remove => remove()) };
      this.active.set(id, active);
      const projection = new Projection(c.harness, randomUUID());
      const modelId = this.config(c).model || (c.harness === 'deepseek' ? 'deepseek-flash' : 'glm-5.3');
      const context = new ContextUsageProjection(c, modelId);
      const publishContext = (reading: ContextUsage | undefined) => {
        if (!reading || reading.revision !== c.revision) return;
        c.contextUsage = reading;
        this.emit({ type: 'conversation', conversation: { ...c } });
      };
      const compactId = `${id}:compact:${c.revision}`;
      const showCompact = (status: DisplayItem['status'], result = '') => this.item(c, projection.update(compactId, {
        kind: 'command', commandName: 'compact', status, text: result, input: command?.[2],
      }));
      let events = Promise.resolve();
      let rootId = c.bindings[c.harness]?.sessionId ?? randomUUID();
      if (c.harness === 'deepseek') active.captureContext = async () => {
        await events;
        publishContext(context.native(await rpc.dshRequest('context', 3_000, rootId)));
      };
      let nativeError: Error | undefined;
      let engaged = false;
      let sawResult = false;
      let settleZcode!: (ready: boolean) => void;
      const zcodeReady = new Promise<boolean>(resolve => { settleZcode = resolve; });
      let zcodeTurnEnded = false;
      listen('diagnostic', (message: string) => this.emit({ type: 'diagnostic', conversationId: id, message: message.slice(-2000) }));
      listen('closed', (error: Error) => {
        settleZcode(false);
        if (!active.stopping) {
          if (sawResult) void events.then(() => finish(nativeError));
          else finish(error);
        }
      });
      if (headless) listen('request', frame => this.requestApproval(c, rpc, frame));
      listen('frame', frame => {
        if (!headless) return;
        const rootEvent = !frame.sessionId || frame.sessionId === rootId;
        if (frame.sessionId) { rootId = frame.sessionId; c.bindings.zcode = { sessionId: rootId, revision: c.revision - 1 }; }
        if (frame.type === 'result') sawResult = true;
        events = events.then(async () => {
          await this.store.append(id, 'native', { harness: 'zcode', runSessionId: rootId, frame, time: Date.now() });
          if (rootEvent) publishContext(context.zcode(frame));
          if (frame.type === 'result') {
            if (compact) await showCompact(nativeError ? 'error' : 'done', nativeError?.message || frame.response || 'ZCode 已结束上下文压缩');
            else if (frame.response && ![...projection.items.values()].some(item => item.kind === 'assistant' && item.text === frame.response)) await this.item(c, projection.update(`${id}:result:${c.revision}`, { text: frame.response }));
            await this.store.save(c); finish(nativeError); return;
          }
          for (const item of projection.zcode(frame)) this.emit({ type: 'item', conversationId: id, item });
          if (frame.type === 'turn.failed') nativeError = new Error(frame.payload?.error?.message ?? 'ZCode 本轮执行失败');
        }).catch(error => finish(error));
      });
      listen('notification', frame => {
        events = events.then(async () => {
          if (frame.method === 'entrotect.stream' && frame.params.sessionId === rootId) {
            for (const item of projection.deepseekStream(frame.params.frame)) this.emit({ type: 'item', conversationId: c.id, item });
            return;
          }
          await this.store.append(id, 'native', { harness: c.harness, runSessionId: rootId, frame, time: Date.now() });
          if (c.harness === 'deepseek' && frame.method === 'session.event' && frame.params.sessionId === rootId) {
            const event = frame.params.event;
            if (event.type === 'turn/start') engaged = true;
            publishContext(context.deepseek(event));
            for (const item of projection.deepseek(event)) await this.item(c, item);
            if (event.type === 'turn/end' && event.data.reason?.kind === 'error') nativeError = new Error(event.data.reason.error?.message ?? 'DeepSeek 本轮执行失败');
          }
          if (!command && c.harness === 'deepseek' && frame.method === 'session.status' && frame.params.sessionId === rootId && frame.params.status === 'idle' && engaged) finish(nativeError);
          if (c.harness === 'zcode' && frame.method === 'session/event' && frame.params.sessionId === rootId) {
            const event = frame.params;
            publishContext(context.zcode(event));
            for (const item of projection.zcode(event)) this.emit({ type: 'item', conversationId: id, item });
            if (!compact && event.type === 'turn.completed') { zcodeTurnEnded = true; finish(); }
            if (event.type === 'turn.failed') {
              zcodeTurnEnded = true;
              nativeError = new Error(event.payload?.error?.message ?? event.payload?.message ?? 'ZCode 本轮执行失败');
              if (!compact) finish(nativeError);
            }
          }
          if (c.harness === 'zcode' && !headless && submitted && frame.method === 'state.updated' && frame.params.sessionId === rootId) {
            const reason = frame.params.reason;
            // ZCode releases the active prompt before publishing this state.
            // A turn event or the session/stop reply can precede that release.
            if (!compact && (reason === 'prompt_failed' || reason === 'prompt_completed' && zcodeTurnEnded)) settleZcode(true);
            if (compact && (reason === 'session_compacted' || reason === 'session_compact_failed' || reason === 'session_compact_cancelled')) {
              const failed = reason !== 'session_compacted' || !!nativeError;
              await showCompact(failed ? 'error' : 'done', failed ? nativeError?.message || 'ZCode 压缩失败或已取消' : 'ZCode 已结束上下文压缩');
              settleZcode(true);
              finish(failed ? nativeError : undefined);
            }
          }
        }).catch(error => finish(error));
      });
      active.drain = async () => {
        await events;
        for (const item of projection.items.values()) {
          await this.item(c, item.kind === 'command' && item.status === 'running' ? { ...item, status: 'error', text: '命令未完成' } : item);
        }
      };
      if (this.startingStops.has(id)) { active.stopping = true; await rpc.close(); throw new Error('已暂停启动'); }
      const workspace = workspaceRef(c);
      let execute: (() => Promise<void>) | undefined;
      if (c.harness === 'deepseek') {
        if (runtime!.sessionId !== rootId) await this.openDeepseek(c, rpc, rootId, !!command);
        if (command && !(await rpc.dshCommand('list', rootId)).some((row: HarnessCommand) => row.name === command[1])) throw new Error(`DeepSeek Harness 当前不支持 /${command[1]}`);
        if (active.stopping) throw new Error('已暂停启动');
        runtime!.sessionId = rootId;
        c.bindings.deepseek = { ...c.bindings.deepseek, sessionId: rootId, revision: c.revision - 1 }; await this.store.save(c);
        if (active.stopping) throw new Error('已暂停启动');
        submitted = true;
        if (command) {
          execute = async () => {
            await rpc.dshCommand('execute', rootId, text.trim());
            if (active.stopping) return;
            await rpc.request('session/wait', { sessionId: rootId }, 24 * 60 * 60 * 1000);
            await events;
            finish(nativeError);
          };
        } else await rpc.request('session/prompt', { sessionId: rootId, contentBlocks: [{ type: 'text', text: text.trim() }] });
        active.pause = async () => {
          await rpc.dshRequest('pause', pauseTimeout, rootId);
          // The pause acknowledgement travels over IPC. A reply on stdout
          // lets the earlier native turn notifications drain in order.
          await rpc.request('session/working-directory/get', { sessionId: rootId }, pauseTimeout);
        };
      } else if (!headless) {
        if (command && !(await this.zcodeCommands(c, rpc)).some(row => row.name === command[1])) throw new Error(`ZCode 当前不支持 /${command[1]}`);
        if (active.stopping) throw new Error('已暂停启动');
        const model = zcodeModel(this.config(c));
        if (runtime!.sessionId !== rootId) {
          if (c.bindings.zcode) await rpc.request('session/resume', { sessionId: rootId, workspace });
          else {
            const result = await rpc.request('session/create', { sessionId: rootId, workspace, mode: 'build', titleGenerationEnabled: false, ...(model ? { model } : {}) });
            rootId = result.session?.id ?? result.sessionId ?? rootId;
          }
        }
        c.bindings.zcode = { sessionId: rootId, revision: c.revision - 1 }; await this.store.save(c);
        if (model) await rpc.request('session/setModel', { sessionId: rootId, model });
        if (runtime!.sessionId !== rootId) {
          await rpc.request('session/subscribe', { sessionId: rootId, deliveryKind: 'desktop-continuous', includeSnapshot: false });
          runtime!.sessionId = rootId;
        }
        if (compact) await showCompact('running');
        else if (command) await recordInput();
        if (active.stopping) throw new Error('已暂停启动');
        submitted = true;
        if (compact) await rpc.request('session/compact', { sessionId: rootId, instructions: command[2] });
        else await rpc.request('session/send', { sessionId: rootId, content: text.trim() });
        active.pause = async () => {
          await rpc.request('session/stop', { sessionId: rootId }, pauseTimeout);
          if (!await zcodeReady) throw new Error('ZCode 未确认本轮已停止');
        };
      } else if (compact && !projection.items.has(compactId)) {
        await showCompact('running');
      }
      if (execute) void execute().catch(error => { if (!active.stopping) finish(error); });
      if (!active.stopping) await this.state(c, 'running');
      this.operations.delete(id);
      active.done = this.complete(c, active, active.drain);
    } catch (error) {
      const active = this.active.get(id);
      const cancelled = !!active?.stopping || this.startingStops.has(id);
      if ((cancelled || command) && !submitted) {
        c.revision = previousRevision;
        if (previousBinding) c.bindings[c.harness] = previousBinding;
        else delete c.bindings[c.harness];
        if (command) { c.title = previousTitle; c.updatedAt = previousUpdatedAt; c.externalMirror = previousMirror; }
      }
      if (active) {
        active.finish(cancelled ? undefined : error as Error);
        active.done ??= this.complete(c, active, active.drain ?? (async () => {}));
        await active.done;
      } else {
        try {
          await this.releaseRuntime(id);
          await this.settings.cleanupRuntime?.(this.codec.nativeRoot(c));
        } catch (cleanupError) {
          await this.state(c, 'error', (cleanupError as Error).message);
          throw cleanupError;
        }
        await this.state(c, cancelled ? 'idle' : 'error', cancelled ? undefined : (error as Error).message);
      }
      if (!cancelled) throw error;
    } finally { this.operations.delete(id);this.startingStops.delete(id); }
  }

  private async lastCodexTurnOverflowed(c: Conversation, sessionId: string) {
    const file = path.join(this.store.directory(c.id), 'native.jsonl');
    const stream = createReadStream(file);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let overflowed = false;
    try {
      for await (const line of lines) {
        if (!line.includes('"method":"turn/completed"')) continue;
        const event = JSON.parse(line);
        if (event.harness !== 'codex' || event.runSessionId !== sessionId || event.frame?.params?.threadId !== sessionId) continue;
        const turn = event.frame.params.turn;
        overflowed = turn?.status === 'failed' && isCodexContextOverflow(turn.error);
      }
      return overflowed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      return false;
    } finally { lines.close(); stream.destroy(); }
  }

  private async recoverCodexContext(c: Conversation, binding?: NativeBinding) {
    if (binding?.seed?.view !== 'archive' || !await this.lastCodexTurnOverflowed(c, binding.sessionId)) return;
    return this.agents.recoverCodexContext(c, binding);
  }

  private async beginAgentSend(c: Conversation, harness: AgentHarness, text: string) {
    this.operations.add(c.id);
    const original = { title: c.title, revision: c.revision, updatedAt: c.updatedAt, externalMirror: c.externalMirror, contextUsage: c.contextUsage, binding: c.bindings[harness] };
    const recovering = c.state === 'error' && harness === 'codex' && !slashCommand(text);
    let submitted = false;
    try {
      await this.state(c, 'starting');
      if (!this.agentBinding(c, harness) && c.revision) {
        if (!c.canonicalPath) throw new Error('旧连接没有可迁移的上下文，请恢复原连接后重试');
        if (original.binding) await this.releaseRuntime(c.id);
        c.bindings[harness] = await this.agents.import(c, harness, c.canonicalPath, undefined, harness === 'codex' ? 'resume' : 'archive');
      } else if (recovering) {
        const recovered = await this.recoverCodexContext(c, original.binding);
        if (recovered) {
          await this.releaseRuntime(c.id);
          c.bindings[harness] = await this.agents.import(c, 'codex', recovered);
          c.contextUsage = undefined;
          this.emit({ type: 'diagnostic', conversationId: c.id, message: '已从原会话压缩后的上下文恢复 Codex 续聊。' });
        }
      }
      const { rpc, runtime } = await this.acquireRuntime(c);
      const client = await runtime.agent!;
      const binding = c.bindings[harness];
      const session = await client.open(c.workspace, binding?.sessionId, this.agents.model(harness, c.modelId));
      const command = slashCommand(text);
      if (command && !(await client.commands(session.id)).some(item => item.name === command[1])) throw new Error(`${harnessNames[harness]} 当前不支持 /${command[1]}`);
      const localCommand = !!command && harness === 'kimi' && ['help', 'status', 'usage', 'mcp', 'tasks'].includes(command[1]);
      if (command?.[1] === 'compact' && !c.revision) throw new Error('请先开始对话，再压缩上下文');
      const model = c.modelId ?? defaultModel(this.settings.value, harness);
      const levelKey = reasoningKey(model, harness);
      const selectedLevel = c.reasoningByModel?.[levelKey];
      const configuredLevel = this.agents.config(harness).reasoning;
      const effort = selectedLevel || configuredLevel;
      const declared = !localCommand && (selectedLevel !== undefined || configuredLevel) ? (await this.agents.catalog(harness, c.workspace, model)).reasoning : undefined;
      const nativeEffort = declared?.levels.find(option => option.id === effort || option.nativeValue === effort)?.nativeValue;
      if (selectedLevel && !localCommand && !nativeEffort) {
        delete c.reasoningByModel![levelKey];
        this.emit({ type: 'diagnostic', conversationId: c.id, message: '原生模型已调整思考档位，本轮使用默认值。' });
      }
      const location = binding?.location ?? this.agents.location(harness);
      let lastTurn: number | undefined;
      if (harness === 'kimi' && !localCommand) {
        lastTurn = -1;
        if (binding) {
          const loadedTurn = runtime.sessionId === session.id ? binding.nativeCheckpoint?.turnId : undefined;
          lastTurn = loadedTurn ?? await this.agents.kimiTurn(c.workspace, binding);
        }
      }
      const usageCursor = harness === 'opencode' ? await this.agents.openCodeUsageCursor(location, session.id).catch(() => undefined) : lastTurn;
      if (this.startingStops.has(c.id) || this.shuttingDown) throw new Error('已暂停启动');
      runtime.sessionId = session.id;
      c.bindings[harness] = { ...binding, sessionId: session.id, revision: c.revision, location };
      if (!localCommand) {
        if (c.title === '新对话') c.title = text.slice(0, 30);
        c.revision++; c.updatedAt = Date.now(); c.externalMirror = false;
      }
      const commandItem: DisplayItem | undefined = command ? { id: randomUUID(), kind: 'command', commandName: command[1], input: command[2], text: '', status: 'running', harness, time: Date.now() } : undefined;
      await this.item(c, commandItem ?? { id: randomUUID(), kind: 'user', text, harness, time: c.updatedAt });
      const projection = new Projection(harness, randomUUID());
      const contextUsage = new ContextUsageProjection(c, model);
      const abort = new AbortController();
      let events = Promise.resolve();
      const notice = (frame: any) => {
        if ((frame.params?.sessionId ?? frame.params?.threadId) !== session.id) return;
        events = events.then(async () => {
          await this.store.append(c.id, 'native', { harness, runSessionId: session.id, frame, time: Date.now() });
          const context = contextUsage.agent(frame);
          if (context) c.contextUsage = context;
          for (const item of projection.agent(frame)) await this.item(c, item);
        });
        void events.catch(error => active.finish(error));
      };
      const diagnostic = (message: string) => this.emit({ type: 'diagnostic', conversationId: c.id, message: message.slice(-2000) });
      let finish!: (error?: Error) => void;
      const settled = new Promise<void>((resolve, reject) => { finish = error => error ? reject(error) : resolve(); });
      void settled.catch(() => {});
      const active: ActiveRun = { rpc, runtime, settled, finish, stopping: false, skipSnapshot: localCommand, detach: () => { rpc.off('notification', notice); rpc.off('diagnostic', diagnostic); } };
      this.active.set(c.id, active);
      rpc.on('notification', notice); rpc.on('diagnostic', diagnostic);
      submitted = true;
      const started = this.state(c, 'running');
      const turn = started.then(async () => {
        if (abort.signal.aborted) return;
        if (lastTurn !== undefined && !command) active.kimiCheckpoint = { text, afterTurn: lastTurn };
        active.usageCursor = usageCursor;
        await client.turn(session, text, { model: this.agents.model(harness, c.modelId), effort: nativeEffort, defaultEffort: declared?.defaultLevel, signal: abort.signal });
      }).catch(error => { if (error !== abort.signal.reason) throw error; });
      active.pause = async () => { abort.abort(); await turn; };
      void turn.then(() => finish(), finish);
      active.drain = async () => {
        await events;
        if (commandItem) await this.item(c, { ...commandItem, status: await settled.then(() => 'done', () => 'error') });
      };
      active.done = this.complete(c, active, active.drain);
    } catch (error) {
      const cancelled = this.startingStops.has(c.id);
      if (!submitted) {
        const { binding, ...fields } = original;
        Object.assign(c, fields);
        if (binding) c.bindings[harness] = binding; else delete c.bindings[harness];
      }
      await this.releaseRuntime(c.id).catch(() => {});
      await this.state(c, cancelled ? 'idle' : 'error', cancelled ? undefined : (error as Error).message);
      if (!cancelled) throw error;
    } finally { this.operations.delete(c.id); this.startingStops.delete(c.id); }
  }
  private async complete(c: Conversation, active: ActiveRun, events: () => Promise<void>) {
    let failure: Error | undefined;
    try { await active.settled; } catch (error) { failure = error as Error; }
    const stopping = active.stopping;
    active.stopping = true;
    let paused = false;
    try { paused = await active.stopTask ?? false; } catch (error) { failure ??= error as Error; }
    let reusable = !!active.runtime && !failure && (!stopping || paused) && active.rpc.available;
    try {
      await this.state(c, 'syncing');
      if (reusable && c.harness === 'deepseek') {
        const sessionId = c.bindings.deepseek!.sessionId;
        try {
          // Native pause already settled the foreground. Do not wait on
          // independent child work that the harness deliberately kept alive.
          if (!paused) await active.rpc.request('session/wait', { sessionId }, 10_000);
          await active.rpc.dshRequest('flush', 10_000, sessionId);
          await active.captureContext?.().catch(() => {});
        } catch (error) {
          this.emit({ type: 'diagnostic', conversationId: c.id, message: 'DeepSeek 写盘尚未确认，将在进程退出后保存。' + (error as Error).message });
          // Shutdown also flushes the native log. Fall back to the cold path
          // if the running SDK cannot confirm the checkpoint.
          reusable = false;
        }
      }
      reusable = reusable && active.rpc.available && !this.shuttingDown;
      if (!reusable) await active.rpc.close();
      active.detach();
      await events();
      await this.settings.cleanupRuntime?.(this.codec.nativeRoot(c));
      if (!active.skipSnapshot && c.bindings[c.harness]) {
        await this.codec.snapshot(c, true, reusable ? await active.runtime?.agent : undefined,
          paused || failure ? undefined : active.kimiCheckpoint, active.usageCursor);
      }
    } catch (error) {
      failure ??= error as Error;
      reusable = false;
    } finally { active.detach(); }
    if (!reusable) {
      try {
        if (active.runtime) await this.releaseRuntime(c.id, active.runtime);
        else await active.rpc.close();
      } catch (error) { failure ??= error as Error; }
    }
    for (const [key, approval] of this.approvals) if (approval.conversationId === c.id) { this.approvals.delete(key); this.emit({ type: 'approval-cleared', id: key }); }
    // A failed transport is not proof of exit. Keep the conversation
    // locked until the process is gone or it can safely serve another turn.
    if (reusable || active.rpc.exited) this.active.delete(c.id);
    await this.state(c, failure ? 'error' : 'idle', failure?.message);
    if (reusable) {
      // Each live process owns one conversation's native files. Retain at
      // most one idle process per harness, along with any concurrent runs.
      for (const [id, runtime] of this.residents) {
        if (id !== c.id && runtime.harness === c.harness && !this.isBusy(id)) void this.releaseRuntime(id, runtime).catch(() => {});
      }
    }
  }
  async stop(id: string) {
    const c = this.store.get(id), active = this.active.get(id);
    if (!active) {
      if (this.operations.has(id) && c.state === 'starting') {
        this.startingStops.add(id);
        await this.state(c, 'stopping');
        await this.releaseRuntime(id);
      }
      return;
    }
    if (!active.stopping || c.state === 'error' && !active.rpc.exited) {
      active.stopping = true;
      active.stopTask = this.stopRun(c, active);
    }
    await active.stopTask;
    if (!active.done) return; // Startup owns cleanup while its RPC is being cancelled.
    await active.done;
    if (this.active.get(id) === active && active.rpc.exited) {
      active.done = this.complete(c, active, active.drain ?? (async () => {}));
      await active.done;
    }
  }
  private async stopRun(c: Conversation, active: ActiveRun) {
    try { await this.state(c, 'stopping'); }
    catch (error) { this.emit({ type: 'diagnostic', conversationId: c.id, message: '无法保存暂停状态。' + (error as Error).message }); }
    if (active.pause && active.rpc.available) {
      const deadline = new AbortController();
      try {
        await Promise.race([
          active.pause(),
          delay(pauseTimeout, undefined, { signal: deadline.signal, ref: false }).then(() => { throw new Error('等待原生暂停超时'); }),
        ]);
        active.finish();
        return true;
      } catch (error) {
        this.emit({ type: 'diagnostic', conversationId: c.id, message: '原生暂停尚未确认，将关闭执行器。' + (error as Error).message });
      } finally { deadline.abort(); }
    }
    try { await active.rpc.close(); }
    catch (error) { active.finish(error as Error); throw error; }
    active.finish();
    return false;
  }
  async selectModel(id: string, modelId: string, override?: Harness) {
    return this.exclusive(id, async c => {
      const preferred = modelHarness(this.settings.value, modelId);
      if (!preferred) throw new Error('请先在连接设置中配置此模型');
      const discovery = catalogModel(modelId);
      if (discovery && !(await this.agents.catalog(discovery.harness, c.workspace, modelId)).models.some(model => model.id === discovery.id)) {
        throw new Error('此模型已不在原生模型目录中');
      }
      const previousModel = c.modelId, previousMode = c.harnessMode;
      c.modelId = modelId;
      try {
        await this.changeHarness(c, override ?? preferred);
        c.harnessMode = override ? 'manual' : 'auto';
        if (c.harness === 'zcode' && c.bindings.zcode && previousModel !== modelId) {
          await this.releaseRuntime(id);
          await this.codec.configureZcodeModel(c, c.bindings.zcode.sessionId);
        }
        await this.state(c, 'idle');
        this.rememberRuntime(c.harness, id);
        return c;
      } catch (error) {
        c.modelId = previousModel;
        c.harnessMode = previousMode;
        await this.store.save(c);
        throw error;
      }
    });
  }
  async switchHarness(id: string, target: Harness) {
    return this.exclusive(id, async c => {
      await this.changeHarness(c, target);
      this.rememberRuntime(c.harness, id);
      return c;
    });
  }
  private async changeHarness(c: Conversation, target: Harness) {
    if (c.harness === target) return;
    if (c.revision > 0 && isAgentHarness(target)) await this.agents.requireExecutable(target);
    const recovering = c.state === 'error' && c.harness === 'codex';
    try {
      await this.state(c, 'syncing');
      await this.releaseRuntime(c.id);
      if (c.revision > 0) {
        const current = c.bindings[c.harness];
        if (!c.canonicalPath || current && current.revision !== c.revision) await this.codec.snapshot(c);
        const binding = isAgentHarness(target) ? this.agentBinding(c, target) : c.bindings[target];
        if (binding?.revision !== c.revision) {
          const recovered = recovering ? await this.recoverCodexContext(c, current) : undefined;
          if (target === 'zcode') {
            const temporary = { ...c, harness: target };
            const rpc = await this.launch(temporary);
            try { await rpc.request('session/list', { workspace: { workspacePath: c.workspace, workspaceKey: `entrotect:${c.id}` } }); } finally { await rpc.close(); }
          }
          const binding = await this.codec.import(recovered ? { ...c, canonicalPath: recovered } : c, target);
          // Confirm the pinned native runtime can actually restore the generated
          // history before committing the switch. Standalone account execution
          // owns its own account registry and is verified on its CLI path.
          if (isAgentHarness(target)) {
            await this.verifyNative({ ...c, harness: target, bindings: { ...c.bindings, [target]: binding } });
          } else if (target === 'deepseek' || this.settings.value.zcode.authMode === 'api') {
            const candidate = { ...c, harness: target, bindings: { ...c.bindings, [target]: binding } };
            const rpc = await this.launch(candidate);
            rpc.on('request', frame => {
              if (frame.method === 'session/requestRuntimePreferences') rpc.respond(frame.id, { nativeSearchEnhancementsEnabled: true, toolSearchMode: 'off', memoryEnabled: false, subagentRuntimeConfigEnabled: false, askUserQuestionAutoResolutionEnabled: false });
              else rpc.rejectRequest(frame.id, '上下文验证阶段不执行交互请求');
            });
            try {
              if (target === 'deepseek') {
                const config = this.settings.value.deepseek;
                await rpc.request('initialize', { cwd: c.workspace, provider: config.authMode === 'api' ? 'deepseek-official' : config.provider, model: config.model });
                await rpc.request('session/resume', { sessionId: binding.sessionId });
              } else await rpc.request('session/resume', { sessionId: binding.sessionId, workspace: { workspacePath: c.workspace, workspaceKey: `entrotect:${c.id}` } });
            } finally { await rpc.close(); await this.settings.cleanupRuntime?.(this.codec.nativeRoot(c)); }
          }
          c.bindings[target] = binding;
          if (recovered) c.canonicalPath = recovered;
        }
      }
      c.harness = target; c.updatedAt = Date.now();
      await this.item(c, { id: randomUUID(), kind: 'notice', text: `已切换到 ${harnessNames[target]}，上下文已同步`, harness: target, time: Date.now() });
      await this.state(c, 'idle');
    } catch (error) { await this.state(c, 'error', (error as Error).message); throw error; }
    finally { await this.settings.cleanupRuntime?.(this.codec.nativeRoot(c)); }
  }
  private requestApproval(c: Conversation, rpc: RpcProcess, frame: any) {
    if (frame.method === 'session/requestRuntimePreferences') {
      rpc.respond(frame.id, { nativeSearchEnhancementsEnabled: true, toolSearchMode: 'off', subagentRuntimeConfigEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1' }); return;
    }
    const question = /question|UserInput/i.test(frame.method);
    const permission = /approval|Permission/i.test(frame.method);
    if (!question && !permission) { rpc.rejectRequest(frame.id, `EntroTect 尚未实现此宿主请求：${frame.method}`); return; }
    const id = randomUUID(); this.approvals.set(id, { rpc, frame, harness: c.harness, conversationId: c.id });
    const approval: Approval = { id, conversationId: c.id, kind: question ? 'question' : 'permission', title: question ? 'Agent 需要你的输入' : `允许执行 ${frame.params?.toolName ?? frame.params?.request?.toolName ?? '此操作'}？`, detail: JSON.stringify(frame.params, null, 2), raw: frame.params };
    void this.state(c, 'waiting'); this.emit({ type: 'approval', approval });
  }
  async answer(id: string, allow: boolean, answer?: string) {
    const pending = this.approvals.get(id); if (!pending) throw new Error('此请求已经结束');
    if (this.active.get(pending.conversationId)?.stopping) throw new Error('此请求已经结束');
    const { rpc, frame, harness } = pending;
    if (harness === 'codex') {
      if (/UserInput/i.test(frame.method)) rpc.respond(frame.id, { answers: allow ? Object.fromEntries((frame.params.questions ?? []).map((q: any) => [q.id, { answers: [answer ?? ''] }])) : {} });
      else if (frame.method === 'item/permissions/requestApproval') rpc.respond(frame.id, { permissions: allow ? frame.params.permissions ?? {} : {}, scope: 'turn' });
      else rpc.respond(frame.id, { decision: allow ? 'accept' : 'decline' });
    } else if (isAgentHarness(harness)) {
      const options = Array.isArray(frame.params?.options) ? frame.params.options : [];
      const option = options.find((item: any) => item.kind === (allow ? 'allow_once' : 'reject_once'));
      rpc.respond(frame.id, { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } });
    } else if (/question|UserInput/i.test(frame.method)) {
      if (harness === 'deepseek') rpc.respond(frame.id, allow ? { answers: (frame.params.questions ?? []).map((q: any) => ({ id: q.id, selected: [], custom: answer ?? '' })) } : { cancelled: true });
      else rpc.respond(frame.id, { action: allow ? 'accept' : 'cancel', ...(allow ? { content: { answer: answer ?? '', answers: Object.fromEntries((frame.params.questions ?? []).map((q: any) => [q.question, answer ?? ''])) } } : {}) });
    } else rpc.respond(frame.id, harness === 'deepseek' ? { outcome: allow ? 'allowed-once' : 'rejected' } : { decision: allow ? 'allow' : 'deny' });
    this.approvals.delete(id); this.emit({ type: 'approval-cleared', id }); await this.state(this.store.get(pending.conversationId), 'running');
  }
  async context(id: string) {
    const c = this.store.get(id); let nativeEvents = 0;
    try { nativeEvents = (await readFile(path.join(this.store.directory(id), 'native.jsonl'), 'utf8')).trimEnd().split('\n').filter(Boolean).length; } catch {}
    return { canonical: c.canonicalPath ? JSON.parse(await readFile(c.canonicalPath, 'utf8')) : null, path: c.canonicalPath ?? null, nativeEvents };
  }
  close() {
    this.shuttingDown = true;
    return this.shutdown ??= this.closeOnce();
  }
  private async closeOnce() {
    const runs = [...this.active.values()];
    const starting = [...this.operations].filter(id => this.store.get(id).state === 'starting');
    await Promise.allSettled([...new Set([...this.active.keys(), ...starting])].map(id => this.stop(id)));
    await Promise.allSettled([...this.pendingSends]);
    await Promise.allSettled([...this.exclusiveOperations]);
    await Promise.allSettled(runs.map(run => run.done ?? Promise.resolve()));
    await Promise.allSettled([...this.residents.keys()].map(id => this.releaseRuntime(id)));
    await this.prewarming;
    await this.reconfiguring?.catch(() => {});
    await Promise.allSettled([...this.drafts.values()].filter(c => !this.residents.has(c.id)).map(c => this.store.discardUnpublished(c.id)));
    if (this.lastSelection) await atomicJson(this.selectionFile, this.lastSelection);
  }
}
