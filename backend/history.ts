import { access, copyFile, mkdir, open, readFile, readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { harnesses, type Conversation, type DisplayItem, type ExportReceipt, type Harness, type HistoryExport, type HistoryImport, type NativeHistory, type NativeHistoryList, type NativeHistorySource } from '../shared/types';
import { isAgentHarness, isHarness } from '../shared/harnesses';
import { bridgeEntries, contextSuffix, messagesToBridge, nativeContentFingerprint, portableHistoryFingerprint } from './portable-history';
import { atomicFile, atomicJson } from './store';
import { Controller } from './controller';
import { nativeSqlite } from './native-sqlite';
import { textBlocks } from './projection';
import { deepSeekHeader, deepSeekLog, deepSeekTranscript as transcript, dshProjectKey } from './dsh-files';
import { deepSeekArchive } from './dsh-context';
import { RpcError } from './rpc';

type DshSession = NativeHistory & { file: string; header: any };
export interface SyncProvenance { profile: string; appId: string; revision: number; fingerprint?: string; }
type AgentMarker = SyncProvenance & { pending?: SyncProvenance & { content: string; structured?: true } };
export interface NativeCommitState { externalOpen: boolean; codexWriters?: (string | null)[]; }
export interface SyncPublish { sessionId: string; expectedFingerprint: string | null; provenance: SyncProvenance; canCommit?():Promise<NativeCommitState | void>; }
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
async function json(file: string) { return JSON.parse(await readFile(file, 'utf8')); }
async function optionalJson(file: string, fallback: any) { try { return await json(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw e; } }
async function scanDsh(home: string): Promise<{ sessions: DshSession[]; warnings: string[] }> {
  const root = path.join(home, 'sessions'), sessions: DshSession[] = [], warnings: string[] = [];
  let projects;
  try { projects = await readdir(root, { withFileTypes: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('此目录下没有 sessions，请选择独立 DeepSeek Harness 的数据目录（通常为用户目录下的 .dsh）'); throw e; }
  for (const project of projects.filter(p => p.isDirectory() && !p.isSymbolicLink())) {
    const entries = await readdir(path.join(root, project.name), { withFileTypes: true });
    for (const entry of entries.filter(p => p.isDirectory() && !p.isSymbolicLink())) {
      const directory = path.join(root, project.name, entry.name);
      const file = await deepSeekLog(directory);
      if (!file) continue;
      try {
        const header = await deepSeekHeader(file);
        if (header.type !== 'session' || !header.id) throw new Error('不支持的原生日志头');
        if (header.origin === 'subagent' || header.isSeeded) continue;
        const cache = await optionalJson(path.join(home, 'storages', 'session_projcache', 'sessions', `${header.id}.json`), null);
        const info = await stat(file);
        const title = cache?.record?.rows?.title?.val;
        sessions.push({ id: header.id, title: typeof title === 'string' && title.trim() ? title : '未命名对话', workspace: header.cwd || '', createdAt: header.createdAt || info.birthtimeMs, updatedAt: info.mtimeMs, version:`${info.size}:${info.mtimeMs}:${title??''}`, file, header });
      } catch (e) { warnings.push(`${entry.name}：${(e as Error).message}`); }
    }
  }
  return { sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt), warnings };
}

function dshDisplay(rows: any[], harness: Harness): DisplayItem[] {
  const items = new Map<string, DisplayItem>();
  for (const e of deepSeekArchive(rows.slice(1))) {
    const d = e.data ?? {}, m = d.message ?? {}, key = `import:${e.seq}`;
    const base = { harness, time: e.time || rows[0].createdAt || Date.now() };
    if (e.type === 'user/message') {
      const source = m.source?.kind ?? d.source?.kind;
      if (['system-prompt', 'system_reminder', 'runtime-context', 'time-context', 'skill-catalog', 'compact-checkpoint', 'context-import'].includes(source)) continue;
      const text = textBlocks(m.content ?? d.content);
      if (text) items.set(key, { ...base, id: key, kind: 'user', text });
    } else if (e.type === 'assistant/message') {
      const text = textBlocks(m.content), thought = (m.content ?? []).filter((b: any) => b.type === 'reasoning').map((b: any) => b.text ?? '').join('\n');
      if (thought) items.set(key + ':thought', { ...base, id: key + ':thought', kind: 'reasoning', text: thought, status: 'done' });
      if (text) items.set(key, { ...base, id: key, kind: 'assistant', text });
    } else if (e.type === 'tool/call') {
      const id = `import:tool:${d.callId}`;
      items.set(id, { ...base, id, kind: 'tool', text: '', toolName: d.name, input: typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments), status: 'done' });
    } else if (e.type === 'tool/result') {
      const id = `import:tool:${m.toolCallId ?? m.callId}`;
      items.set(id, { ...base, ...items.get(id), id, kind: 'tool', text: textBlocks(m.content), status: m.isError ? 'error' : 'done' });
    } else if (e.type === 'command/run') {
      const id = `import:command:${d.commandId}`;
      items.set(id, { ...base, id, kind: 'command', commandName: d.name, input: d.args, text: '命令未完成', status: 'error' });
    } else if (e.type === 'command/done') {
      const id = `import:command:${d.commandId}`;
      items.set(id, { ...base, ...items.get(id), id, kind: 'command', text: d.text ?? '', status: d.kind === 'error' ? 'error' : 'done' });
    }
  }
  return [...items.values()];
}
function bundleDisplay(bundle: any, harness: Harness): DisplayItem[] {
  const session = bundle.payload.sessions.find((s: any) => s.id === bundle.payload.root_session_id) ?? bundle.payload.sessions[0];
  const out = new Map<string, DisplayItem>();
  for (const [i, e] of session.events.entries()) {
    const k = e.kind, id = `import:${i}`, base = { harness, time: e.time_ms || session.created_ms || Date.now() };
    if (k.Message && ['User', 'Assistant'].includes(k.Message.role) && !['system_reminder', 'time-context', 'system-prompt', 'runtime-context', 'skill-catalog', 'timeline_event', 'compact_summary'].includes(k.Message.source_kind)) out.set(id, { ...base, id, kind: k.Message.role === 'User' ? 'user' : 'assistant', text: k.Message.text });
    else if (k.Reasoning) out.set(id, { ...base, id, kind: 'reasoning', text: k.Reasoning.text, status: 'done' });
    else if (k.ToolCall) { const t = k.ToolCall, key = `import:tool:${t.call_id}`; out.set(key, { ...base, id: key, kind: 'tool', text: '', input: t.arguments, toolName: t.name, status: 'error' }); }
    else if (k.ToolResult) { const key = `import:tool:${k.ToolResult.call_id}`; out.set(key, { ...base, ...out.get(key), id: key, kind: 'tool', text: k.ToolResult.text, status: 'done' }); }
  }
  return [...out.values()];
}

export class HistoryService {
  private destinations = new Set<string>();
  constructor(private controller: Controller) {}
  private async backupLocation(source:NativeHistorySource,id:string,suffix:string){
    const folder=path.join(this.controller.store.root,'history-backups',createHash('sha256').update(`${source.harness}:${path.resolve(source.location).toLowerCase()}:${id}`).digest('hex'));
    await mkdir(folder,{recursive:true});return path.join(folder,`${Date.now()}-${randomUUID()}.${suffix}`);
  }
  private async trimBackups(source:NativeHistorySource,id:string){
    const base=path.resolve(this.controller.store.root,'history-backups');const folder=path.resolve(base,createHash('sha256').update(`${source.harness}:${path.resolve(source.location).toLowerCase()}:${id}`).digest('hex'));
    if(!folder.startsWith(base+path.sep))throw Error('备份路径无效');
    const files=(await readdir(folder).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;})).filter(name=>/^\d{13}-[a-f0-9-]{36}\.(?:json|log\.bak)$/.test(name)).sort().reverse();
    for(const file of files.slice(5))await unlink(path.join(folder,file));
  }
  defaults(): Record<Harness, NativeHistorySource> {
    const settings = this.controller.settings.value;
    const location = (harness: Harness) => settings.history?.sources?.[harness] || (isAgentHarness(harness)
      ? this.controller.agents.config(harness).home
      : harness === 'deepseek' ? settings.deepseek.home : path.join(settings.zcode.home, '.zcode', 'cli', 'db', 'db.sqlite'));
    return Object.fromEntries(harnesses.map(harness => [harness, { harness, location: location(harness) }])) as Record<Harness, NativeHistorySource>;
  }
  async available(source: NativeHistorySource) {
    if (isAgentHarness(source.harness)) {
      return !!(await stat(source.location).catch(() => null))?.isDirectory() && !!await this.controller.settings.agentExecutable(source.harness);
    }
    return !!await stat(source.harness==='deepseek'?path.join(source.location,'sessions'):source.location).catch(()=>null);
  }
  async inspect(source: NativeHistorySource, sessionId: string, entry?: NativeHistory): Promise<{fingerprint:string;contentFingerprint?:string;busy:boolean;provenance?:SyncProvenance}> {
    if (isAgentHarness(source.harness)) {
      const row = entry ?? (await this.list(source)).sessions.find(session => session.id === sessionId);
      if (!row) throw new Error('来源会话不存在');
      const native = await this.controller.agents.read(source.harness, source.location, row.workspace, sessionId);
      const marker: AgentMarker | undefined = await optionalJson(this.agentMarker(source, sessionId), undefined);
      const pending = marker?.pending;
      const provenance = pending && pending.content === (pending.structured ? portableHistoryFingerprint(native.history) : portableFingerprint(native.archived)) ? { ...pending, fingerprint: native.version } : marker?.fingerprint ? marker : undefined;
      return { fingerprint: native.version, contentFingerprint: nativeContentFingerprint(native),
        busy: native.busy === true || ('openTurn' in native && native.openTurn === true), provenance };
    }
    if (source.harness==='zcode') return nativeSqlite(this.controller.settings.node,{action:'inspect',source:source.location,sessionId});
    const found=(await scanDsh(source.location)).sessions.find(s=>s.id===sessionId); if(!found)throw new Error('来源会话不存在');
    const rows=await transcript(found.file); let start=-1,end=-1; rows.forEach((r,i)=>{if(r.type==='turn/start')start=i;if(r.type==='turn/end')end=i;});
    return {fingerprint:digest(await readFile(found.file)),busy:start>end,provenance:await optionalJson(path.join(path.dirname(found.file),'entrotect-sync.json'),undefined)};
  }
  private agentMarker(source: NativeHistorySource, sessionId: string) {
    const name = createHash('sha256').update(sessionId).digest('hex');
    return path.join(source.location, '.entrotect-history', `${name}.json`);
  }
  private source(value: NativeHistorySource) {
    if (!value || !isHarness(value.harness) || typeof value.location !== 'string' || !path.isAbsolute(value.location)) throw new Error('请选择原生 Harness 的绝对数据路径');
    return { harness: value.harness, location: path.resolve(value.location) };
  }
  async list(value: NativeHistorySource): Promise<NativeHistoryList> {
    const source = this.source(value);
    if (isAgentHarness(source.harness)) {
      if (!(await stat(source.location).catch(() => undefined))?.isDirectory()) throw new Error('原生历史目录不存在');
      return { source, sessions: await this.controller.agents.list(source.harness, source.location), warnings: [] };
    }
    if (source.harness === 'deepseek') {
      const found = await scanDsh(source.location);
      return { source, sessions: found.sessions.map(({ file, header, ...s }) => s), warnings: found.warnings };
    }
    await access(source.location).catch(() => { throw new Error('没有找到 ZCode 数据库，请先启动独立 ZCode，或选择已有的 db.sqlite'); });
    return { source, sessions: await nativeSqlite(this.controller.settings.node, { action: 'list', source: source.location }), warnings: [] };
  }
  private async copyDsh(sourceFile: string, root: string, id: string, workspace: string, compressed = false) {
    const rows = await transcript(sourceFile);
    if (rows[0].version !== 4) throw new Error('目前仅支持 DeepSeek v4 原生日志，请先用新版独立 Harness 打开此对话');
    const oldId = rows[0].id;
    // Delivery checkpoints bind to the native ID as well as the header. Keep
    // sequence numbers and all content intact while rebinding those markers.
    for (const row of rows.slice(1)) if (row.data?.sessionId === oldId) row.data.sessionId = id;
    rows[0] = { ...rows[0], id, cwd: workspace, isSeeded: false, delegationDepth: 0 };
    delete rows[0].parentSession; delete rows[0].origin;
    const directory = path.join(root, 'sessions', dshProjectKey(workspace), id);
    await mkdir(path.dirname(directory), { recursive: true }); await mkdir(directory);
    const file = path.join(directory, `session.v4.jsonl${compressed ? '.zstd' : ''}`);
    const text = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
    const encoded = compressed ? Buffer.concat([zstdCompressSync(JSON.stringify(rows[0]) + '\n'), ...(rows.length > 1 ? [zstdCompressSync(rows.slice(1).map(r => JSON.stringify(r)).join('\n') + '\n')] : [])]) : text;
    await (await import('node:fs/promises')).writeFile(file, encoded, { flag: 'wx' });
    return { rows, file };
  }
  async import(request: HistoryImport, existing?: Conversation, automatic=false, knownEntry?: NativeHistory) {
    const source = this.source(request.source), entry = knownEntry ?? (await this.list(source)).sessions.find(s => s.id === request.sessionId);
    if (!entry) throw new Error('来源会话已不存在，请刷新列表');
    const originalWorkspace = request.workspace?.trim() || entry.workspace;
    const workspace = originalWorkspace&&path.isAbsolute(originalWorkspace)?originalWorkspace:os.homedir();
    const valid=!!originalWorkspace&&path.isAbsolute(originalWorkspace)&&!!(await stat(originalWorkspace).catch(()=>null))?.isDirectory();
    if (!valid&&!automatic) throw new Error('原项目目录不存在，请为此对话选择工作目录');
    const now = Date.now(), c: Conversation = { ...existing, id: existing?.id||randomUUID(), title: entry.title, workspace, workspaceMissing:!valid, harness: source.harness, modelId:existing?.harness===source.harness?existing.modelId:undefined, createdAt: existing?.createdAt||entry.createdAt||now, updatedAt: automatic?entry.updatedAt:now, revision: (existing?.revision||0)+1, state: 'idle', bindings: {...existing?.bindings}, importedFrom: existing?.importedFrom??{ ...source, sessionId: entry.id, importedAt: now } };
    let items: DisplayItem[];
    try {
    // A retained process may hold the previous version of this native session.
    if (existing) await this.controller.releaseRuntime(existing.id);
    if (isAgentHarness(source.harness)) {
      const native = await this.controller.agents.read(source.harness, source.location, entry.workspace, entry.id);
      if (!native.archived.length) throw new Error('这条原生会话没有可导入的对话内容');
      const bundle = messagesToBridge(native.history, { id: entry.id, title: c.title, cwd: workspace, createdAt: c.createdAt, updatedAt: c.updatedAt, source: source.harness }, 'retained' in native ? native.retained : undefined);
      c.canonicalPath = path.join(this.controller.store.directory(c.id), 'context', `revision-${c.revision}-${randomUUID()}${contextSuffix}`);
      await atomicJson(c.canonicalPath, bundle);
      c.lastSyncAt = now;
      const previous = existing?.bindings[source.harness];
      const runtimeLocation = this.controller.agents.location(source.harness);
      const sameProfile = valid && samePath(source.location, runtimeLocation) && samePath(entry.workspace, workspace);
      const sameBinding = previous?.sessionId === entry.id && previous.location && samePath(previous.location, source.location);
      const codexOriginal = source.harness === 'codex' && !existing && sameProfile && !this.controller.store.list().some(chat => {
        const binding = chat.bindings.codex;
        return binding?.sessionId === entry.id && binding.location && samePath(binding.location, source.location);
      });
      if (sameProfile && (automatic && sameBinding || codexOriginal)) {
        // A same-profile Codex import can resume the original native thread.
        if (codexOriginal && native.busy) throw new Error('请等待 Codex 原会话结束后再导入');
        c.bindings[source.harness] = { ...(sameBinding ? previous : undefined), sessionId: entry.id, location: runtimeLocation,
          revision: c.revision, nativeCheckpoint: { version: native.version, content: nativeContentFingerprint(native) } };
      } else if (valid && !automatic) {
        c.bindings[source.harness] = await this.controller.agents.import(c, source.harness, c.canonicalPath);
        await this.controller.verifyNative(c);
      } else delete c.bindings[source.harness];
      items = bundleDisplay(bundle, source.harness);
    } else if (source.harness === 'deepseek') {
      const original = (await scanDsh(source.location)).sessions.find(s => s.id === entry.id)!;
      const id = randomUUID(), copied = await this.copyDsh(original.file, path.join(this.controller.codec.nativeRoot(c), 'deepseek'), id, workspace);
      c.bindings.deepseek = { sessionId: id, revision: c.revision }; items = dshDisplay(copied.rows, 'deepseek');
    } else {
      await this.controller.initializeDatabase(valid?c:{...c,workspace:os.homedir()});
      const id = `sess_${randomUUID()}`;
      await nativeSqlite(this.controller.settings.node, { action: 'copy', source: source.location, target: this.controller.codec.database(c), sessionId: entry.id, newId: id, workspace, title: c.title });
      c.bindings.zcode = { sessionId: id, revision: c.revision }; items = [];
    }
    if (!isAgentHarness(source.harness)) {
      if(!automatic)await this.controller.verifyNative(c);
      await this.controller.codec.snapshot(c, false);
    }
    if (source.harness === 'zcode') items = bundleDisplay(await json(c.canonicalPath!), 'zcode');
    await this.controller.store.replaceItems(c.id,items);
    await this.controller.store.save(c); return c;
    } finally {if(!existing)await this.controller.store.discardUnpublished(c.id).catch(()=>{});}
  }
  async export(request: HistoryExport, sync?: SyncPublish): Promise<ExportReceipt> {
    const target = this.source(request.target), key = target.location.toLowerCase();
    if (this.destinations.has(key)) throw new Error('此原生目录正在导出其他对话，请稍后重试');
    this.destinations.add(key);
    let stagingId:string|undefined;
    try { const receipt=await this.controller.exclusive<ExportReceipt>(request.conversationId, async c => {
      const binding = c.bindings[c.harness];
      if (!binding && !c.canonicalPath) throw new Error('请先完成一轮对话，或导入已有历史');
      const codex = c.bindings.codex;
      if (!sync && target.harness === 'codex' && codex?.location && codex.revision === c.revision && samePath(codex.location, target.location)) {
        const native = await this.controller.agents.read('codex', target.location, c.workspace, codex.sessionId).catch(error => {
          if (error?.code === 'ENOENT' || error instanceof RpcError && error.code === -32600 && error.message === `thread not loaded: ${codex.sessionId}`) return;
          throw error;
        });
        if (native && 'listed' in native && native.listed && native.archived.length) {
          // Let the standalone client take the native writer lock at handoff.
          if (c.harness === 'codex') await this.controller.releaseRuntime(c.id);
          return { ...target, sessionId: codex.sessionId, workspace: c.workspace, verified: true, reused: true };
        }
      }
      if (!c.canonicalPath || binding && binding.revision !== c.revision) await this.controller.codec.snapshot(c);
      if (isAgentHarness(target.harness)) {
        const agents = this.controller.agents, harness = target.harness;
        const current = c.bindings[harness];
        let sessionId = sync?.sessionId;
        const shared = !!(sync && !sessionId && current?.location && samePath(current.location, target.location) && current.revision === c.revision);
        const messages = bridgeEntries(await json(c.canonicalPath!), sync ? 'archive' : 'resume');
        let expectedHistory = messages;
        if (!messages.length) throw new Error('没有可导出的对话消息');
        if (sync?.expectedFingerprint && sessionId) {
          const markerFile = this.agentMarker(target, sessionId);
          const previous = await optionalJson(markerFile, undefined);
          expectedHistory = await agents.append(c, harness, target.location, sessionId, sync.expectedFingerprint, messages, async result => {
            const activity = await sync.canCommit?.();
            await atomicJson(markerFile, { ...previous, pending: { ...sync.provenance, content: portableHistoryFingerprint(result), structured: true } });
            return activity;
          });
        } else if (shared) {
          sessionId = current!.sessionId;
        } else {
          await sync?.canCommit?.();
          const binding = await agents.import({ ...c, modelId: target.harness === c.harness ? c.modelId : undefined }, harness, c.canonicalPath!, target.location, sync ? 'archive' : 'resume', true);
          sessionId = binding.sessionId;
        }
        const native = await agents.read(harness, target.location, c.workspace, sessionId);
        if (!native.archived.length) throw new Error('目标 Harness 未能读回已导出的对话');
        if (portableHistoryFingerprint(expectedHistory) !== portableHistoryFingerprint(native.history)) throw new Error('原生会话的内容与导出检查点不一致');
        if (sync) {
          await atomicJson(this.agentMarker(target, sessionId), { ...sync.provenance, fingerprint: native.version });
        }
        return { ...target, sessionId, workspace: c.workspace, verified: true };
      }
      // A temporary app profile holds conversion results and is cold-restored
      // before any external database or desktop registry is changed.
      const candidate: Conversation = { ...c, id: randomUUID(), harness: target.harness, modelId: target.harness === c.harness ? c.modelId : undefined, bindings: {} };
      stagingId=candidate.id;
      if (target.harness === 'zcode') await this.controller.initializeDatabase(candidate);
      let dshFile = '', stagedId = '';
      if (target.harness === c.harness) {
        if (target.harness === 'deepseek') {
          const found = await scanDsh(path.join(this.controller.codec.nativeRoot(c), 'deepseek'));
          const original = found.sessions.find(s => s.id === c.bindings.deepseek!.sessionId);
          if (!original) throw new Error('找不到当前 DeepSeek 原生日志');
          stagedId = randomUUID(); dshFile = (await this.copyDsh(original.file, path.join(this.controller.codec.nativeRoot(candidate), 'deepseek'), stagedId, c.workspace)).file;
        } else {
          stagedId = `sess_${randomUUID()}`;
          await nativeSqlite(this.controller.settings.node, { action: 'copy', source: this.controller.codec.database(c), target: this.controller.codec.database(candidate), sessionId: c.bindings.zcode!.sessionId, newId: stagedId, workspace: c.workspace, title: c.title });
        }
        candidate.bindings[target.harness] = { sessionId: stagedId, revision: c.revision };
      } else {
        candidate.bindings[target.harness] = await this.controller.codec.import(candidate, target.harness);
        stagedId = candidate.bindings[target.harness]!.sessionId;
        if (target.harness === 'deepseek') dshFile = (await scanDsh(path.join(this.controller.codec.nativeRoot(candidate), 'deepseek'))).sessions.find(s => s.id === stagedId)!.file;
      }
      // Automatic synchronization is storage-only. Starting an agent to restore
      // a snapshot can run user plugins and would require otherwise-unused API
      // credentials. Pinned format compatibility is exercised by native tests.
      if(!sync)await this.controller.verifyNative(candidate);
      if (target.harness === 'deepseek') return this.exportDsh(candidate, dshFile, target.location, sync);
      await access(target.location).catch(() => { throw new Error('目标 ZCode 数据库不存在，请先启动独立 ZCode 或选择已有数据库'); });
      if (samePath(target.location, this.controller.codec.database(c))) throw new Error('请选择独立 ZCode 的数据库');
      const id = sync?.sessionId||`sess_${randomUUID()}`, backup = sync?(sync.expectedFingerprint?await this.backupLocation(target,id,'json'):undefined):`${target.location}.entrotect-${Date.now()}-${randomUUID()}.bak`;
      const inferredHome = path.dirname(path.dirname(path.dirname(target.location)));
      const configFiles = [...(path.basename(inferredHome).toLowerCase() === '.zcode' ? [path.join(inferredHome, 'v2', 'provider_config.json')] : []), path.join(this.controller.settings.value.zcode.home, '.zcode', 'v2', 'provider_config.json')];
      let targetModel: unknown;
      for (const file of configFiles) { const config = await optionalJson(file, null); const selection = config?.config?.defaultModelSelection; if (typeof selection?.providerId === 'string' && selection.providerId.trim() && typeof selection?.modelId === 'string' && selection.modelId.trim()) { targetModel = selection; break; } }
      await sync?.canCommit?.();
      await nativeSqlite(this.controller.settings.node, { action: 'copy', source: this.controller.codec.database(candidate), target: target.location, sessionId: stagedId, newId: id, workspace: c.workspace, title: c.title, backup, targetModel,...(sync?{expectedFingerprint:sync.expectedFingerprint,provenance:sync.provenance,recordBackup:true,allowInactivePending:!!sync.canCommit}:{}) });
      return { harness: 'zcode' as const, sessionId: id, location: target.location, workspace: c.workspace, backup, verified: true };
    });if(sync && !isAgentHarness(target.harness))await this.trimBackups(target,sync.sessionId);return receipt; } finally { this.destinations.delete(key);if(stagingId)await this.controller.store.discardUnpublished(stagingId).catch(()=>{}); }
  }
  private async exportDsh(c: Conversation, sourceFile: string, home: string, sync?: SyncPublish): Promise<ExportReceipt> {
    await access(home).catch(() => { throw new Error('目标 DeepSeek 数据目录不存在，请先启动独立 Harness 或选择已有的 .dsh 目录'); });
    const id = sync?.sessionId || `session-${randomUUID()}`;
    const original = sync ? (await scanDsh(home)).sessions.find(s=>s.id===id) : undefined;
    const priorBytes = original ? await readFile(original.file) : null;
    if (sync && (priorBytes ? digest(priorBytes) : null) !== sync.expectedFingerprint) throw new Error('原生会话已在独立端更新，已停止覆盖');
    if (original && !sync?.canCommit && (await this.inspect({harness:'deepseek',location:home},id)).busy) throw new Error('独立 DeepSeek 会话仍在运行');
    const storage = path.join(home, 'storages'), registry = path.join(storage, 'workspace.json');
    await mkdir(storage, { recursive: true });
    const lockPath = `${registry}.entrotect.lock`, lock = await open(lockPath, 'wx').catch(() => { throw new Error('另一次导出正在更新 DeepSeek 项目索引，请稍后重试'); });
    let backup: string | undefined, createdFile = '', committed = false, publishedHash = '';
    const cacheFile = path.join(storage, 'session_projcache', 'sessions', `${id}.json`);
    try {
      const before = await readFile(registry, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
      const data = before === null ? { unit: { name: 'workspace', version: 2 }, global: { initialized: false, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } } : JSON.parse(before);
      if (data.unit?.version !== 2 || !data.tables?.workspaces || typeof data.tables.workspaces !== 'object' || Array.isArray(data.tables.workspaces)) throw new Error('DeepSeek 项目索引格式不受支持，未修改索引');
      const workspaces = data.tables.workspaces;
      const order: unknown = data.global?.workspaceIds ?? [];
      if (!Array.isArray(order) || new Set(order).size !== order.length || order.some(id => typeof id !== 'string' || !Object.hasOwn(workspaces, id))) {
        throw new Error('DeepSeek 项目显示顺序异常，未修改索引');
      }
      // A workspace row and its ordered ID form one native registry entry.
      // Older exports could leave the row unlisted. Preserve the existing
      // order and recover those rows before publishing a new registry.
      const workspaceIds = [...order, ...Object.keys(workspaces).filter(id => !order.includes(id))];
      data.global = { initialized: false, ...data.global, workspaceIds };
      const entries = Object.values(workspaces) as any[];
      let workspace = entries.find(w => typeof w.path === 'string' && samePath(w.path, c.workspace));
      const now = new Date().toISOString();
      if (!workspace) {
        const workspaceId = randomUUID();
        workspace = { path: c.workspace, title: path.basename(c.workspace), sessionIds: [], createdAt: now, updatedAt: now };
        workspaces[workspaceId] = workspace;
        workspaceIds.unshift(workspaceId);
      }
      if (!Array.isArray(workspace.sessionIds)) throw new Error('DeepSeek 项目会话索引格式异常');
      if (!workspace.sessionIds.includes(id)) workspace.sessionIds.push(id); workspace.updatedAt = now;
      const compressed = original ? original.file.endsWith('.zstd') : true;
      const prepared = await this.copyDsh(sourceFile, path.join(this.controller.store.directory(c.id),'publish'), id, c.workspace, compressed);
      const bytes=await readFile(prepared.file); publishedHash=digest(bytes);
      const file=original?.file || path.join(home,'sessions',dshProjectKey(c.workspace),id,path.basename(prepared.file));
      if(priorBytes){backup=sync?await this.backupLocation({harness:'deepseek',location:home},id,'log.bak'):`${file}.entrotect-${Date.now()}-${randomUUID()}.bak`;await copyFile(file,backup);}
      else if(before!==null){backup=sync?await this.backupLocation({harness:'deepseek',location:home},id,'json'):`${registry}.entrotect-${Date.now()}-${randomUUID()}.bak`;await copyFile(registry,backup);}
      await sync?.canCommit?.();
      if(sync) await atomicJson(path.join(path.dirname(file),'entrotect-sync.json'),{...sync.provenance,fingerprint:publishedHash});
      await atomicFile(file,bytes,priorBytes); if(!original)createdFile=file;
      const rows=prepared.rows,header=rows[0],seq=rows.at(-1)?.seq??0;
      await atomicJson(cacheFile,{version:7,record:{identity:{formatVersion:4,createdAt:header.createdAt,cwd:c.workspace,isSeeded:false,inheritedEventCount:0},rows:{title:{ver:1,seq,val:c.title}}}});
      await atomicJson(registry,data,before); committed=true;
      return {harness:'deepseek',sessionId:id,location:file,workspace:c.workspace,backup,verified:true};
    } finally {
      if(!committed&&createdFile){
        const current=await readFile(createdFile).catch(()=>null);
        if(current&&digest(current)===publishedHash){await unlink(createdFile).catch(()=>{});await unlink(cacheFile).catch(()=>{});await unlink(path.join(path.dirname(createdFile),'entrotect-sync.json')).catch(()=>{});await rmdir(path.dirname(createdFile)).catch(()=>{});}
      }
      await lock.close(); await unlink(lockPath);
    }
  }
}

function portableFingerprint(messages: readonly { role: string; text: string }[]) {
  return createHash('sha256').update(JSON.stringify(messages.map(({ role, text }) => [role, text]))).digest('hex');
}
