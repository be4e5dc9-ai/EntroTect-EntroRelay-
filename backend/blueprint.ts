import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isHarness } from '../shared/harnesses';
import { projectKey } from '../shared/project-path';
import { blueprintParents, blueprintScopeKey } from '../shared/blueprint';
import { harnesses, type BlueprintCatalog, type BlueprintChat, type BlueprintRule, type BlueprintScope, type BlueprintTarget, type Conversation, type Harness, type HistoryExportRules, type HistoryImportRule, type NativeHistory, type NativeHistorySource } from '../shared/types';
import type { HistoryService } from './history';
import { Store, atomicJson } from './store';

type Classification = 'native' | 'copy';
type SavedBlueprint = {
  version: 1; since: number; onboarded: boolean; rules: BlueprintRule[];
  confirmations: Record<string, Classification>;
  recordedOrigins?: Record<string,string>;
  unassignedProjects?: Record<string,HistoryExportRules>;
};
type LegacySelection = { imports: HistoryImportRule[]; exports: Record<string,HistoryExportRules> };
const targets: BlueprintTarget[] = ['workbench', ...harnesses];
export const historySourceKey = (source: NativeHistorySource) => source.harness + ':' + projectKey(path.resolve(source.location));
const scopeKey = (s: BlueprintScope) => blueprintScopeKey({...s,source:{...s.source,location:path.resolve(s.source.location)}});
const projectOf = (s: BlueprintScope): BlueprintScope => ({source:s.source,workspace:s.workspace});
const isSameSource = (a: NativeHistorySource,b: NativeHistorySource) => historySourceKey(a) === historySourceKey(b);
function validated(scope: BlueprintScope) {
  if (!scope || !isHarness(scope.source?.harness) || typeof scope.source.location !== 'string' || !path.isAbsolute(scope.source.location) ||
      typeof scope.workspace !== 'string' || (scope.wholeHarness === true
        ? scope.sessionId !== undefined || scope.workspace !== ''
        : scope.wholeHarness !== undefined || (scope.sessionId === undefined ? !path.isAbsolute(scope.workspace) : !scope.sessionId || typeof scope.sessionId !== 'string'))) {
    throw new Error('同步来源无效');
  }
  return scope;
}
async function optional<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file,'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export class BlueprintStore {
  private readonly file: string;
  private state: SavedBlueprint = {version:1,since:Date.now(),onboarded:false,rules:[],confirmations:{}};
  private queue: Promise<unknown> = Promise.resolve();
  private indexed = new Map<string,Map<BlueprintTarget,boolean>>();
  constructor(private readonly store: Store, private readonly history: HistoryService) {
    this.file = path.join(store.root,'blueprint.json');
  }
  get rules() { return this.state.rules; }
  get onboarded() { return this.state.onboarded; }
  private async restoreLegacyOrigins(defaults:Record<Harness,NativeHistorySource>) {
    // Legacy native-account runs can already have a public native ID. A
    // single unseeded, checkpointed binding identifies the original session.
    // Converted or multi-Harness records still require an explicit choice.
    const restored = new Map<string,NonNullable<Conversation['origin']>>();
    for (const c of this.store.conversations.values()) {
      if (c.origin || c.importedFrom || c.externalMirror) continue;
      const bindings = Object.entries(c.bindings);
      if (bindings.length !== 1) continue;
      const [h,binding] = bindings[0];
      if (!isHarness(h) || !binding.location || !binding.nativeCheckpoint || binding.seed || binding.translated) continue;
      const source = defaults[h];
      const shared = projectKey(source.location) === projectKey(binding.location);
      restored.set(c.id,{source,workspace:c.workspace,...(shared && {sessionId:binding.sessionId})});
    }
    if (restored.size) await this.store.restoreOrigins(restored);
  }
  async init() {
    const saved = await optional<SavedBlueprint>(this.file);
    if (saved) {
      if (saved.version !== 1) throw new Error('同步蓝图版本不受支持');
      this.install(saved);
      return;
    }
    const old = await optional<LegacySelection>(path.join(this.store.root,'history-selection.json'));
    const rules: BlueprintRule[] = [];
    const confirmations: Record<string,Classification> = {};
    const unassignedProjects: Record<string,HistoryExportRules> = {};
    const defaults = this.history.defaults();
    await this.restoreLegacyOrigins(defaults);
    for (const rule of old?.imports ?? []) {
      if (rule.enabled === null) continue;
      const chat = 'sessionId' in rule ? this.store.list().find(c=>c.importedFrom?.sessionId === rule.sessionId && isSameSource(c.importedFrom,rule.source)) : undefined;
      const scope = {source:rule.source,workspace:'workspace' in rule ? rule.workspace : chat?.workspace ?? '',sessionId:'sessionId' in rule ? rule.sessionId : undefined};
      rules.push({scope,target:'workbench',enabled:rule.enabled});
      if ('sessionId' in rule && rule.enabled) confirmations[scopeKey(scope)] = 'native';
    }
    for (const [key,selection] of Object.entries(old?.exports ?? {})) {
      const byProject = key.startsWith('project:');
      const members = this.store.list().filter(c=>byProject ? projectKey(c.workspace) === key.slice(8) : key === 'conversation:'+c.id);
      const scopes = new Map<string,BlueprintScope>();
      for (const c of members) {
        // Keep explicit choices for unclassified local chats dormant until their origin is confirmed.
        const known = this.scope(c);
        if (byProject && !known) continue;
        const s = known ?? {source:defaults[c.harness],workspace:c.workspace,sessionId:'app:'+c.id};
        const scope = byProject ? projectOf(s) : s;
        scopes.set(scopeKey(scope),scope);
      }
      if (byProject && !scopes.size) {
        const workspace = key.slice(8), h = this.store.projectOrigins[projectKey(workspace)];
        if (h) scopes.set(key,{source:defaults[h],workspace});
        else unassignedProjects[projectKey(workspace)] = selection;
      }
      for (const scope of scopes.values()) for (const target of harnesses) {
        if (typeof selection[target] === 'boolean') rules.push({scope,target,enabled:selection[target]!});
      }
    }
    this.install({...this.state,rules,confirmations,unassignedProjects});
    await atomicJson(this.file,this.state);
  }
  private install(state: SavedBlueprint) {
    this.state = state;
    this.indexed.clear();
    for (const rule of state.rules) {
      const key = scopeKey(rule.scope);
      let group = this.indexed.get(key);
      if (!group) this.indexed.set(key,group = new Map());
      group.set(rule.target,rule.enabled);
    }
  }
  private change(edit:(current:SavedBlueprint)=>SavedBlueprint) {
    const task = this.queue.catch(()=>{}).then(async()=>{
      const next = edit(this.state);
      await atomicJson(this.file,next);
      this.install(next);
    });
    this.queue = task;
    return task;
  }
  dismiss() { return this.change(s=>({...s,onboarded:true})); }
  async claimLegacyProject(source:NativeHistorySource,workspace:string) {
    const key = projectKey(workspace);
    if (!this.state.unassignedProjects?.[key]) return;
    await this.change(s=>{
      const pending = {...s.unassignedProjects}, choices = pending[key];
      if (!choices) return s;
      delete pending[key];
      const scope = {source,workspace}, rules = [...s.rules];
      for (const target of harnesses) if (typeof choices[target] === 'boolean' && !rules.some(r=>r.target === target && scopeKey(r.scope) === scopeKey(scope))) {
        rules.push({scope,target,enabled:choices[target]!});
      }
      return {...s,unassignedProjects:pending,rules};
    });
  }
  setRule(scope: BlueprintScope,target:BlueprintTarget,enabled:boolean|null) {
    validated(scope);
    if (!targets.includes(target) || (enabled !== null && typeof enabled !== 'boolean')) throw new Error('同步目标无效');
    const key = scopeKey(scope);
    return this.change(s=>{
      const rules = s.rules.filter(r=>r.target !== target || scopeKey(r.scope) !== key);
      if (enabled !== null) rules.push({scope,target,enabled});
      return {...s,rules};
    });
  }
  activeSources() {
    const sources = new Map<string,NativeHistorySource>();
    const defaults = this.history.defaults();
    for (const rule of this.rules) {
      if (!rule.enabled || rule.scope.sessionId?.startsWith('app:')) continue;
      const source = rule.scope.wholeHarness ? defaults[rule.scope.source.harness] : rule.scope.source;
      sources.set(historySourceKey(source),source);
    }
    return [...sources.values()];
  }
  targets(scope: BlueprintScope) {
    const rules = [scope,...blueprintParents(scope)].map(s=>this.indexed.get(scopeKey(s)));
    return targets.filter(target=>rules.find(rule=>rule?.has(target))?.get(target) === true);
  }
  scope(c: Conversation): BlueprintScope | undefined {
    if (c.externalMirror) return;
    const origin = c.origin ?? (c.importedFrom && {source:c.importedFrom,sessionId:c.importedFrom.sessionId,workspace:c.workspace});
    if (!origin) {
      const local = {source:this.history.defaults()[c.harness],workspace:c.workspace,sessionId:'app:'+c.id};
      return this.state.confirmations[scopeKey(local)] === 'native' ? local : undefined;
    }
    return {source:origin.source,workspace:origin.workspace ?? c.workspace,sessionId:origin.sessionId ?? 'app:'+c.id};
  }
  classify(source: NativeHistorySource,entry: NativeHistory,linkedAppId?:string,marker = !!entry.provenance): Classification | 'pending' {
    const scope = {source,workspace:entry.workspace,sessionId:entry.id};
    const key = scopeKey(scope);
    const explicit = this.state.confirmations[key];
    const recordedOwner = this.state.recordedOrigins?.[key];
    const archivedOriginal = !!recordedOwner && (!marker || entry.provenance?.appId === recordedOwner);
    const chat = linkedAppId ? this.store.conversations.get(linkedAppId) : undefined;
    if (chat) {
      const origin = this.scope(chat);
      if (origin && origin.sessionId === entry.id && isSameSource(origin.source,source) && !chat.externalMirror &&
        (!marker || entry.provenance?.appId === chat.id || archivedOriginal)) return 'native';
      if (origin || marker || chat.externalMirror) return 'copy';
    }
    if (marker && !archivedOriginal) return 'copy';
    if (explicit) return explicit;
    if (archivedOriginal) return 'native';
    if (entry.createdAt >= this.state.since) return 'native';
    return 'pending';
  }
  async confirm(scopes:BlueprintScope[],classification:Classification) {
    if (!Array.isArray(scopes) || !['native','copy'].includes(classification)) throw new Error('无效的来源确认');
    const origins = new Map<string,NonNullable<Conversation['origin']>>();
    const updates = scopes.map(scope=>{
      validated(scope);
      if (!scope.sessionId) throw new Error('请选择需要确认的对话');
      if (classification === 'native' && scope.sessionId.startsWith('app:')) {
        const chat = this.store.get(scope.sessionId.slice(4));
        if (!chat.origin) origins.set(chat.id,{source:scope.source,workspace:scope.workspace});
      }
      return [scopeKey(scope),classification];
    });
    await this.change(s=>({...s,confirmations:{...s.confirmations,...Object.fromEntries(updates)}}));
    if (origins.size) await this.store.restoreOrigins(origins);
    if (classification === 'native') for (const scope of scopes) {
      if (this.state.unassignedProjects?.[projectKey(scope.workspace)]) await this.claimLegacyProject(scope.source,scope.workspace);
    }
  }
  async catalog(harness:Harness,linked:(s:NativeHistorySource,id:string)=>string|undefined):Promise<BlueprintCatalog> {
    const source = this.history.defaults()[harness];
    const projects = new Map<string,BlueprintCatalog['projects'][number]>();
    const pending: BlueprintChat[] = [], warnings: string[] = [];
    const group = (workspace:string,home=source)=>{
      const key = scopeKey({source:home,workspace});
      if (!projects.has(key)) projects.set(key,{source:home,workspace,chats:[]});
      return projects.get(key)!;
    };
    for (const workspace of this.store.projects()) if (this.store.projectOrigins[projectKey(workspace)] === harness) {
      group(workspace,{harness,location:this.store.projectLocations[projectKey(workspace)] ?? source.location});
    }
    const seen = new Set<string>();
    const nativeOrigins = new Map<string, string>();
    for (const c of this.store.conversations.values()) {
      const scope = this.scope(c);
      if(scope?.source.harness===harness && scope.sessionId) nativeOrigins.set(scopeKey(scope),c.id);
    }
    if (await this.history.available(source)) {
      try {
        const listed = await this.history.list(source);
        warnings.push(...listed.warnings);
        for (const row of listed.sessions) {
          const scope = {source,workspace:row.workspace,sessionId:row.id};
          const appId = linked(source,row.id) ?? nativeOrigins.get(scopeKey(scope));
          const type = this.classify(source,row,appId);
          seen.add(scopeKey(scope));
          if (type === 'copy') continue;
          (type === 'native' ? group(row.workspace).chats : pending).push({scope,appId,title:row.title,updatedAt:row.updatedAt});
        }
      } catch (e) { warnings.push((e as Error).message); }
    }
    for (const c of this.store.conversations.values()) {
      if (c.externalMirror) continue;
      const known = this.scope(c);
      const scope = known ?? {source:this.history.defaults()[c.harness],workspace:c.workspace,sessionId:'app:'+c.id};
      if (scope.source.harness !== harness || seen.has(scopeKey(scope)) || this.state.confirmations[scopeKey(scope)] === 'copy') continue;
      (known ? group(scope.workspace,scope.source).chats : pending).push({scope,appId:c.id,title:c.title,updatedAt:c.updatedAt});
    }
    for (const p of projects.values()) p.chats.sort((a,b)=>b.updatedAt-a.updatedAt);
    return {source,projects:[...projects.values()],pending,warnings};
  }
}
