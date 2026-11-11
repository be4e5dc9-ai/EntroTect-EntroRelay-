import type { AgentHarness, LaunchConfig, NativeModel, ReasoningLevel } from '../shared/types';
import { slashCommand, type HarnessCommand } from '../shared/commands';
import { RpcProcess } from './rpc';

type AgentFrame = { method: string; id?: string | number; params?: any };
type ConfigChoice = { value?: string; name?: string; options?: ConfigChoice[] };
type ConfigOption = { id: string; category?: string; currentValue?: string; options?: ConfigChoice[] };
export type AgentSession = { id: string; cwd: string; configOptions?: ConfigOption[]; models?: any };
export type AgentHistoryRow = { id: string; cwd: string; title?: string; updatedAt?: string | number; createdAt?: number; path?: string; busy?: boolean };
type TurnResult = 'completed' | 'interrupted';

export function isCodexContextOverflow(error: { codexErrorInfo?: unknown; message?: unknown } | undefined) {
  return error?.codexErrorInfo === 'contextWindowExceeded' || typeof error?.message === 'string' &&
    /\bcontext_(?:length|window)_exceeded\b|Codex ran out of room in the model's context window/i.test(error.message);
}

const codexOverflowMessage = 'Codex 的上下文已满。可以输入 /compact 压缩，或在同一项目中新建对话继续。';
const clientInfo = { name: 'entrotect', title: 'EntroTect', version: '0.6.4' };
const openTimeout = 30_000;
const turnTimeout = 24 * 60 * 60 * 1_000;
const codexCommands: HarnessCommand[] = [
  { name: 'compact', description: '压缩当前 Codex 会话的上下文' },
  { name: 'review', description: '审查未提交的改动，或按指令审查', inputHint: '可选审查指令' },
];

function choices(options?: ConfigChoice[]): NativeModel[] {
  return (options ?? []).flatMap(option => Array.isArray(option.options) ? choices(option.options)
    : typeof option.value === 'string' && option.value.length ? [{ id: option.value, label: typeof option.name === 'string' ? option.name : option.value }] : []);
}

export class AgentClient {
  private capabilities: { loadSession?: boolean; sessionCapabilities?: { resume?: object; list?: object; delete?: object } } = {};
  private codexVersion?: string;
  private readonly commandsBySession = new Map<string, HarnessCommand[]>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly running = new Set<string>();
  private constructor(readonly harness: AgentHarness, readonly rpc: RpcProcess, readonly executable: string) {
    rpc.on('notification', (frame: AgentFrame) => {
      if (harness === 'codex' && frame.method === 'thread/closed') this.sessions.delete(frame.params?.threadId);
      if (frame.method !== 'session/update') return;
      const { sessionId, update } = frame.params ?? {};
      if (update?.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
        this.commandsBySession.set(sessionId, update.availableCommands.flatMap((command: any) => typeof command.name === 'string'
          ? [{ name: command.name, description: String(command.description ?? ''), inputHint: command.input?.hint }]
          : []));
      }
      const session = this.sessions.get(sessionId);
      if (session && update?.sessionUpdate === 'config_option_update') session.configOptions = update.configOptions;
    });
  }

  static async connect(harness: AgentHarness, config: Pick<LaunchConfig, 'executable' | 'args'>, cwd: string, env: NodeJS.ProcessEnv) {
    const acp = harness !== 'codex';
    const rpc = new RpcProcess(config, cwd, env, acp, false);
    const client = new AgentClient(harness, rpc, config.executable);
    try {
      const hello = await rpc.request('initialize', acp ? { protocolVersion: 1, clientInfo, clientCapabilities: {} } : { clientInfo }, openTimeout);
      if (acp) {
        if (hello?.protocolVersion !== 1) throw new Error('当前执行器使用不受支持的 ACP 协议版本');
        client.capabilities = hello.agentCapabilities ?? {};
      } else {
        client.codexVersion = typeof hello?.userAgent === 'string' ? /\/(\d+\.\d+\.\d+(?:-[\w.]+)?)(?=\s|$)/.exec(hello.userAgent)?.[1] : undefined;
        rpc.notify('initialized');
      }
      return client;
    } catch (error) {
      await rpc.close();
      throw error;
    }
  }

  close() { return this.rpc.close(); }

  get hasVerifiedCodexWriterLock() { return this.codexVersion === '0.167.0'; }

  async open(cwd: string, sessionId?: string, model?: string): Promise<AgentSession> {
    const loaded = sessionId && this.sessions.get(sessionId);
    if (loaded) return loaded;
    const params = { cwd, ...(model ? { model } : {}) };
    if (this.harness === 'codex') {
      const result = sessionId
        ? await this.rpc.request('thread/resume', { ...params, threadId: sessionId, excludeTurns: true }, openTimeout)
        : await this.rpc.request('thread/start', params, openTimeout);
      if (typeof result?.thread?.id !== 'string') throw new Error('Codex 未返回会话 ID');
      const session = { id: result.thread.id, cwd };
      this.sessions.set(session.id, session);
      return session;
    }
    if (sessionId && !this.capabilities.sessionCapabilities?.resume && !this.capabilities.loadSession) throw new Error('当前 ACP 运行时没有续聊接口');
    const method = sessionId ? (this.capabilities.sessionCapabilities?.resume ? 'session/resume' : 'session/load') : 'session/new';
    const result = await this.rpc.request(method, { cwd, mcpServers: [], ...(sessionId ? { sessionId } : {}) }, openTimeout);
    const id = sessionId ?? result?.sessionId;
    if (typeof id !== 'string') throw new Error('ACP 运行时未返回会话 ID');
    const session = { id, cwd, configOptions: result?.configOptions, models: result?.models };
    this.sessions.set(id, session);
    return session;
  }

  async list(cwd?: string): Promise<AgentHistoryRow[]> {
    const codex = this.harness === 'codex';
    if (!codex && !this.capabilities.sessionCapabilities?.list) throw new Error('当前 ACP 运行时没有会话列表接口');
    const rows: AgentHistoryRow[] = [];
    const visited = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.rpc.request(codex ? 'thread/list' : 'session/list', {
        ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}),
        ...(codex ? { sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'], modelProviders: [] } : {}),
      }, openTimeout);
      const data = codex ? page?.data : page?.sessions;
      if (!Array.isArray(data)) throw new Error('原生会话列表响应无效');
      for (const row of data) {
        const id = codex ? row?.id : row?.sessionId;
        if (typeof id !== 'string' || typeof row.cwd !== 'string') continue;
        rows.push({ id, cwd: row.cwd, title: codex ? row.name ?? row.preview : row.title, updatedAt: row.updatedAt, createdAt: row.createdAt,
          ...(codex ? { path: row.path, busy: row.status?.type === 'active' } : {}) });
      }
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
      if (cursor && visited.has(cursor)) throw new Error('原生会话列表重复返回分页游标');
      if (cursor) visited.add(cursor);
    } while (cursor);
    return rows;
  }

  async probe<T>(cwd: string, read: (session: AgentSession) => Promise<T>) {
    if (this.harness === 'kimi' && !this.capabilities.sessionCapabilities?.delete) throw new Error('此 Kimi Code 版本无法安全清理探测会话');
    const session = await this.open(cwd);
    try { return await read(session); }
    finally {
      if (this.harness === 'kimi') await this.rpc.request('session/delete', { sessionId: session.id }, openTimeout);
      this.sessions.delete(session.id);
      this.commandsBySession.delete(session.id);
    }
  }

  async commands(sessionId?: string): Promise<HarnessCommand[]> {
    if (this.harness === 'codex') return codexCommands;
    if (!sessionId) return [];
    const cached = this.commandsBySession.get(sessionId);
    if (cached) return cached;
    // ACP sends this notification after the session/new or session/resume reply.
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        this.rpc.off('notification', onUpdate);
        this.rpc.off('closed', finish);
        resolve(this.commandsBySession.get(sessionId) ?? []);
      };
      const onUpdate = () => { if (this.commandsBySession.has(sessionId)) finish(); };
      const timer = setTimeout(finish, 1_000);
      this.rpc.on('notification', onUpdate);
      this.rpc.once('closed', finish);
    });
  }

  private option(session: AgentSession, category: 'model' | 'thought_level') {
    return session.configOptions?.find(item => item.category === category || (category === 'model' ? item.id === 'model' : ['effort', 'thinking'].includes(item.id)));
  }

  sessionModels(session: AgentSession) {
    const option = this.option(session, 'model');
    const legacy = session.models?.availableModels;
    const models = option ? choices(option.options) : Array.isArray(legacy) ? legacy.flatMap((model: any) => typeof model.modelId === 'string' ? [{ id: model.modelId, label: model.name || model.modelId }] : []) : [];
    return { models: models as NativeModel[], currentModel: option?.currentValue ?? session.models?.currentModelId as string | undefined };
  }

  sessionReasoning(session: AgentSession) {
    const option = this.option(session, 'thought_level');
    const levels: ReasoningLevel[] = choices(option?.options).filter(value => value.id !== 'default')
      .map(value => ({ id: value.id, label: value.id, nativeValue: value.id }));
    return { levels, defaultLevel: this.harness === 'opencode' && choices(option?.options).some(value => value.id === 'default') ? 'default' : option?.currentValue };
  }

  private async configure(session: AgentSession, option: ConfigOption, value: string) {
    if (option.currentValue === value) return;
    const result = await this.rpc.request('session/set_config_option', { sessionId: session.id, configId: option.id, value }, openTimeout);
    if (Array.isArray(result?.configOptions)) session.configOptions = result.configOptions;
  }

  async configureModel(session: AgentSession, model?: string) {
    if (!model || this.harness === 'codex') return;
    const option = this.option(session, 'model');
    if (option) await this.configure(session, option, model);
    else if (session.models?.currentModelId !== model && session.models?.availableModels) {
      await this.rpc.request('session/set_model', { sessionId: session.id, modelId: model }, openTimeout);
      session.models.currentModelId = model;
    }
  }

  async modelCatalog() {
    if (this.harness !== 'codex') throw new Error('ACP 模型配置由具体会话提供');
    const models: any[] = [];
    const visited = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.rpc.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) }, openTimeout);
      if (!Array.isArray(page?.data)) throw new Error('Codex 模型目录响应无效');
      models.push(...page.data);
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
      if (cursor && visited.has(cursor)) throw new Error('Codex 模型目录重复返回分页游标');
      if (cursor) visited.add(cursor);
    } while (cursor);
    return models;
  }

  async inject(sessionId: string, items: readonly unknown[]) {
    if (this.harness !== 'codex') throw new Error('只有 Codex 提供此上下文写入接口');
    await this.rpc.request('thread/inject_items', { threadId: sessionId, items }, openTimeout);
  }

  async turn(session: AgentSession, text: string, options: { model?: string; effort?: string; defaultEffort?: string; signal: AbortSignal }): Promise<TurnResult> {
    if (this.running.has(session.id)) throw new Error('这个原生会话已有任务在运行');
    options.signal.throwIfAborted();
    this.running.add(session.id);
    try {
      return await (this.harness === 'codex' ? this.codexTurn(session.id, text, options) : this.acpTurn(session, text, options));
    } finally { this.running.delete(session.id); }
  }

  private async acpTurn(session: AgentSession, text: string, { model, effort, defaultEffort, signal }: { model?: string; effort?: string; defaultEffort?: string; signal: AbortSignal }): Promise<TurnResult> {
    await this.configureModel(session, model);
    const value = effort ?? defaultEffort;
    if (value !== undefined) {
      const option = this.option(session, 'thought_level');
      if (option && choices(option.options).some(choice => choice.id === value)) await this.configure(session, option, value);
      else if (effort) throw new Error('原生运行时当前未提供所选思考档位');
    }
    signal.throwIfAborted();
    const cancel = () => { if (this.rpc.available) this.rpc.notify('session/cancel', { sessionId: session.id }); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await this.rpc.request('session/prompt', { sessionId: session.id, prompt: [{ type: 'text', text }] }, turnTimeout);
      return result?.stopReason === 'cancelled' ? 'interrupted' : 'completed';
    } finally { signal.removeEventListener('abort', cancel); }
  }

  private async codexTurn(threadId: string, text: string, { model, effort, defaultEffort, signal }: { model?: string; effort?: string; defaultEffort?: string; signal: AbortSignal }): Promise<TurnResult> {
    const command = slashCommand(text);
    if (command && !codexCommands.some(item => item.name === command[1])) throw new Error(`Codex 当前不支持 /${command[1]}`);
    const args = command?.[2]?.trim() ?? '';
    if (command?.[1] === 'compact' && args) throw new Error('Codex 的 /compact 不接收参数');
    let turnId: string | undefined;
    let interrupted = false;
    let startTimer: NodeJS.Timeout | undefined;
    let resolve!: (value: TurnResult) => void, reject!: (error: Error) => void;
    const completion = new Promise<TurnResult>((ok, fail) => { resolve = ok; reject = fail; });
    void completion.catch(() => {});
    const interrupt = () => {
      if (!signal.aborted || !turnId || interrupted || !this.rpc.available) return;
      interrupted = true;
      void this.rpc.request('turn/interrupt', { threadId, turnId }, openTimeout).catch(reject);
    };
    const notice = ({ method, params }: AgentFrame) => {
      if (params?.threadId !== threadId || typeof params.turn?.id !== 'string') return;
      if (method === 'turn/started' && !turnId) { clearTimeout(startTimer); turnId = params.turn.id; interrupt(); }
      if (method !== 'turn/completed' || params.turn.id !== turnId) return;
      if (params.turn.status === 'failed') {
        const error = params.turn.error;
        reject(new Error(isCodexContextOverflow(error) ? codexOverflowMessage : error?.message ?? 'Codex 本轮执行失败'));
      }
      else resolve(params.turn.status === 'interrupted' ? 'interrupted' : 'completed');
    };
    this.rpc.on('notification', notice);
    this.rpc.once('closed', reject);
    signal.addEventListener('abort', interrupt, { once: true });
    const timer = setTimeout(() => reject(new Error('Codex 本轮等待完成超时')), turnTimeout);
    try {
      const method = command?.[1] === 'compact' ? 'thread/compact/start' : command?.[1] === 'review' ? 'review/start' : 'turn/start';
      const selectedEffort = effort ?? defaultEffort;
      const params = method === 'thread/compact/start' ? { threadId } : method === 'review/start'
        ? { threadId, delivery: 'inline', target: args ? { type: 'custom', instructions: args } : { type: 'uncommittedChanges' } }
        : { threadId, input: [{ type: 'text', text }], ...(model ? { model } : {}), ...(selectedEffort ? { effort: selectedEffort } : {}) };
      const result = await this.rpc.request(method, params, openTimeout);
      if (method !== 'thread/compact/start' && typeof result?.turn?.id !== 'string') throw new Error('Codex 未返回运行回合 ID');
      turnId = result?.turn?.id ?? turnId;
      if (!turnId) startTimer = setTimeout(() => reject(new Error('Codex 尚未确认压缩任务已开始')), openTimeout);
      interrupt();
      return await completion;
    } catch (error) {
      if (error instanceof Error && isCodexContextOverflow(error)) throw new Error(codexOverflowMessage);
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(startTimer);
      this.rpc.off('notification', notice);
      this.rpc.off('closed', reject);
      signal.removeEventListener('abort', interrupt);
    }
  }
}
