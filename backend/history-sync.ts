import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { harnesses, type BlueprintConflict, type BlueprintScope, type Conversation, type DesktopEvent, type ExportReceipt, type HistoryExport, type HistoryExportRules, type HistoryExportScope, type HistoryExportSelection, type HistoryImportRule, type HistorySyncStatus, type HistoryImport, type NativeHistory, type NativeHistorySource } from '../shared/types';
import { projectKey } from '../shared/project-path';
import { blueprintParents, blueprintScopeKey } from '../shared/blueprint';
import { Controller } from './controller';
import { HistoryService } from './history';
import { atomicJson } from './store';
import { nativeActivity } from './native-activity';
import { harnessNames, isAgentHarness } from '../shared/harnesses';
import { BlueprintStore, historySourceKey as sourceKey } from './blueprint';
import { bridgeEntries, type BridgeHistory, type PortableEntry } from './portable-history';

type Link = { source: NativeHistorySource; sessionId: string; appId: string; revision: number; fingerprint: string | null; version?: string; pendingRevision?: number; pendingContent?: string; detached?: boolean; replace?: boolean };
type Conflict = BlueprintConflict & {sessionId:string; revision:number; fingerprint:string; branchId?:string};
type Listing = { source: NativeHistorySource; entries: NativeHistory[] };
const key = (s:NativeHistorySource,id:string) => JSON.stringify([sourceKey(s),id]);
const sameSource = (a:NativeHistorySource,b:NativeHistorySource) => sourceKey(a) === sourceKey(b);
const describe = (e:unknown) => e instanceof Error ? e.message : String(e);
const sameWorkspace = (a:string,b:string) => projectKey(a) === projectKey(b);
const meaningful = (archive:BridgeHistory) => bridgeEntries(archive,'archive').filter(e=>'role' in e || e.kind === 'tool');
const content = (entry:PortableEntry) => 'role' in entry ? entry.role+' '+entry.text : entry.kind==='tool' ? entry.name+' '+entry.arguments+' '+(entry.output??'') : entry.text;

export class HistorySync {
  status: HistorySyncStatus = {running:false,imported:0,exported:0,issues:[]};
  readonly blueprint: BlueprintStore;
  private links = new Map<string,Link>();
  private originals = new Map<string,string>();
  private unresolved = new Map<string,Conflict>();
  private timer?: NodeJS.Timeout;
  private scheduled?: NodeJS.Timeout;
  private work?: Promise<HistorySyncStatus>;
  private stopped=false;
  private connectionChanges=0;
  private manual: Promise<unknown> = Promise.resolve();
  private jobs = new Map<string,Promise<unknown>>();
  private reserved = new Map<string,number>();
  private writes:Promise<unknown> = Promise.resolve();
  private readonly profile: string;
  private readonly file: string;
  constructor(private controller:Controller,private history:HistoryService,private emit:(e:DesktopEvent)=>void,private activity=nativeActivity) {
    this.profile=createHash('sha256').update(path.resolve(controller.store.root).toLowerCase()).digest('hex');
    this.file=path.join(controller.store.root,'history-sync.json');
    this.blueprint=new BlueprintStore(controller.store,history);
  }
  async init() {
    await this.blueprint.init();
    for (const c of this.controller.store.conversations.values()) {
      const original=this.blueprint.scope(c);
      if (original?.sessionId && !original.sessionId.startsWith('app:')) this.originals.set(key(original.source,original.sessionId),c.id);
    }
    try {
      const saved=JSON.parse(await readFile(this.file,'utf8'));
      if(saved.version!==1 && saved.version!==2)throw Error('历史同步索引版本不受支持');
      for(const l of saved.links)this.links.set(key(l.source,l.sessionId),l);
      for(const c of saved.conflicts??[])this.unresolved.set(c.id,c);
    } catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }
  private save() {
    const task=this.writes.catch(()=>{}).then(()=>atomicJson(this.file,{version:2,links:[...this.links.values()],conflicts:[...this.unresolved.values()]}));
    this.writes=task;
    return task;
  }
  linkedApp(source:NativeHistorySource,id:string) {
    const link=this.links.get(key(source,id));
    if(link && this.controller.store.conversations.has(link.appId))return link.appId;
    return this.originals.get(key(source,id));
  }
  conflicts():BlueprintConflict[] {
    return [...this.unresolved.values()].map(({id,appId,source,title,local,remote})=>({id,appId,source,title,local,remote}));
  }
  private endpoints(c:Conversation) {
    const result=new Map<string,NativeHistorySource>(), scope=this.blueprint.scope(c);
    if (!scope)return result;
    const targets=this.blueprint.targets(scope);
    if (targets.length && scope.sessionId && !scope.sessionId.startsWith('app:')) result.set(sourceKey(scope.source),scope.source);
    const defaults=this.history.defaults();
    for (const target of targets) if(target!=='workbench') result.set(sourceKey(defaults[target]),defaults[target]);
    return result;
  }
  private connected(c:Conversation,source:NativeHistorySource) { return this.endpoints(c).has(sourceKey(source)); }
  private entryScope(source:NativeHistorySource,row:NativeHistory):BlueprintScope {return {source,workspace:row.workspace,sessionId:row.id};}
  private chosen(source:NativeHistorySource,row:NativeHistory) {
    const id=this.linkedApp(source,row.id);
    const c=id?this.controller.store.conversations.get(id):undefined;
    if(this.links.get(key(source,row.id))?.detached)return false;
    if(c)return this.connected(c,source);
    return this.blueprint.classify(source,row,id)==='native' && this.blueprint.targets(this.entryScope(source,row)).length>0;
  }
  private matches(a:BlueprintScope,b:BlueprintScope) {
    return sameSource(a.source,b.source) && (a.sessionId ? a.sessionId===b.sessionId : !b.sessionId && sameWorkspace(a.workspace,b.workspace));
  }
  async listHistory(source:NativeHistorySource) {
    const list=await this.history.list(source);
    return {...list,sessions:list.sessions.map(entry=>{
      const scope=this.entryScope(source,entry);
      const rule=(s:BlueprintScope)=>this.blueprint.rules.find(r=>r.target==='workbench'&&this.matches(r.scope,s))?.enabled;
      return {...entry,sync:{joined:!!this.linkedApp(source,entry.id),allowed:this.chosen(source,entry),session:rule(scope),project:rule({...scope,sessionId:undefined})}};
    })};
  }
  async setImportSelection(rule:HistoryImportRule) {
    const scope:BlueprintScope={source:rule.source,workspace:'workspace' in rule?rule.workspace:'',sessionId:'sessionId' in rule?rule.sessionId:undefined};
    if(scope.sessionId && rule.enabled===true){
      const row=(await this.history.list(rule.source)).sessions.find(entry=>entry.id===scope.sessionId);
      if(!row || this.blueprint.classify(rule.source,row,this.linkedApp(rule.source,row.id))==='copy')throw Error('同步副本不能作为独立来源');
      scope.workspace=row.workspace;
      await this.blueprint.confirm([scope],'native');
    }
    await this.blueprint.setRule(scope,'workbench',rule.enabled);
    this.schedule();
  }
  private legacyScopes(scope:HistoryExportScope):BlueprintScope[] {
    if(scope.kind==='conversation') {
      const s=this.blueprint.scope(this.controller.store.get(scope.id));
      if(!s)throw Error('请先确认这条对话的原生归属');
      return [s];
    }
    const projects=new Map<string,BlueprintScope>();
    for(const c of this.controller.store.list()) {
      const s=this.blueprint.scope(c);
      if(s && sameWorkspace(c.workspace,scope.workspace))projects.set(sourceKey(s.source),{...s,sessionId:undefined});
    }
    const owner=this.controller.store.projectOrigins[projectKey(scope.workspace)];
    if(owner){const source=this.history.defaults()[owner];projects.set(sourceKey(source),{source,workspace:scope.workspace});}
    return [...projects.values()];
  }
  exportSelection(scope:HistoryExportScope):HistoryExportSelection {
    const scopes=this.legacyScopes(scope);
    const rules:HistoryExportRules={},inherited=Object.fromEntries(harnesses.map(h=>[h,false])) as Record<typeof harnesses[number],boolean>;
    for(const s of scopes)for(const rule of this.blueprint.rules){
      if(rule.target==='workbench'||rule.scope.wholeHarness)continue;
      if(this.matches(rule.scope,s))rules[rule.target]=rule.enabled;
    }
    for(const h of harnesses)for(const s of scopes) {
      const inheritedRule=blueprintParents(s)
        .map(parent=>this.blueprint.rules.find(r=>r.target===h&&blueprintScopeKey(r.scope)===blueprintScopeKey(parent)))
        .find(rule=>rule!==undefined);
      if(inheritedRule)inherited[h]=inheritedRule.enabled;
    }
    return {rules,inherited,enabled:this.controller.settings.value.history?.autoExport!==false};
  }
  async setExportSelection(scope:HistoryExportScope, rules:HistoryExportRules) {
    for(const s of this.legacyScopes(scope))for(const h of harnesses)await this.blueprint.setRule(s,h,rules[h]??null);
    this.schedule();
    return this.exportSelection(scope);
  }
  private serialized<T>(action:()=>Promise<T>) {
    const task=this.manual.catch(()=>{}).then(async()=>{
      this.connectionChanges++;
      try {await this.work;return await action();}
      finally {this.connectionChanges--;this.schedule();}
    });
    this.manual=task;
    return task;
  }
  importManually(request:HistoryImport) {
    return this.serialized(async()=>{
      const source=request.source,row=(await this.history.list(source)).sessions.find(e=>e.id===request.sessionId);
      if(!row)throw Error('来源会话不存在');
      const appId=this.linkedApp(source,row.id),existing=appId?this.controller.store.conversations.get(appId):undefined;
      if(this.blueprint.classify(source,row,appId)==='copy') {
        if(existing)return existing;
        throw Error('同步副本不能作为独立来源');
      }
      const scope=this.entryScope(source,row);
      await this.blueprint.confirm([scope],'native');
      if(existing&&(!request.workspace||sameWorkspace(existing.workspace,request.workspace)&&!existing.workspaceMissing)){
        await this.blueprint.setRule(scope,'workbench',true);return existing;
      }
      const baseline=await this.history.inspect(source,row.id,row);
      const c=await this.history.import(request,existing,false,row);
      const link={source,sessionId:row.id,appId:c.id,revision:c.revision,fingerprint:baseline.fingerprint,version:row.version};
      this.links.set(key(source,row.id),link);await this.save();
      await this.blueprint.setRule(scope,'workbench',true);
      this.emit({type:'conversation',conversation:c});
      return c;
    });
  }
  exportManually(request:HistoryExport) {
    return this.serialized(async()=>{
      const c=this.controller.store.get(request.conversationId),source=request.target;
      const entries=(await this.history.list(source)).sessions;
      return this.publish(c,source,entries,true,true);
    });
  }
  start(){this.stopped=false;this.schedule();this.timer=setInterval(()=>this.schedule(),15_000);this.timer.unref();}
  schedule(){
    const prefs=this.controller.settings.value.history;
    if(this.stopped||this.connectionChanges||this.scheduled||!this.blueprint.rules.some(r=>r.enabled)||prefs?.autoImport===false&&prefs.autoExport===false)return;
    this.scheduled=setTimeout(()=>{this.scheduled=undefined;void this.run().catch(e=>{this.status.issues=[describe(e)];this.emit({type:'history-sync',status:{...this.status}});});},250);
    this.scheduled.unref();
  }
  async stop(){this.stopped=true;clearInterval(this.timer);clearTimeout(this.scheduled);this.scheduled=undefined;await Promise.allSettled([this.work,this.manual,this.writes]);}
  async updateConnections<T>(change:()=>Promise<T>) {return this.serialized(()=>this.controller.updateConnections(change));}
  async userAction<T>(id:string,action:()=>Promise<T>):Promise<T>{
    this.reserved.set(id,(this.reserved.get(id)??0)+1);
    try{await this.jobs.get(id);return await action();}
    finally{const remaining=(this.reserved.get(id)??1)-1;if(remaining)this.reserved.set(id,remaining);else this.reserved.delete(id);}
  }
  private busy(id:string){return this.reserved.has(id)||this.controller.isBusy(id);}
  private async job<T>(id:string,action:()=>Promise<T>){const promise=action();this.jobs.set(id,promise);try{return await promise;}finally{this.jobs.delete(id);}}
  async run(force=false):Promise<HistorySyncStatus>{
    if(this.stopped||this.connectionChanges)return this.status;
    if(this.work){const result=await this.work;if(force&&!this.stopped)return this.run(true);return result;}
    this.work=this.cycle(force).finally(()=>{this.work=undefined;});return this.work;
  }
  private async cycle(force:boolean) {
    const imports=()=>force||this.controller.settings.value.history?.autoImport!==false;
    const exports=()=>force||this.controller.settings.value.history?.autoExport!==false;
    const sources=new Map<string,NativeHistorySource>();
    if(imports())for(const source of this.blueprint.activeSources())sources.set(sourceKey(source),source);
    for(const c of this.controller.store.conversations.values())if((imports()||exports())&&c.revision)for(const [k,s] of this.endpoints(c))sources.set(k,s);
    if(!sources.size)return this.status;
    const listings=new Map<string,Listing>(),issues=new Set<string>();
    const list=async(source:NativeHistorySource)=>{
      const k=sourceKey(source);
      const cached=listings.get(k);if(cached)return cached;
      if(!await this.history.available(source))return;
      const found=await this.history.list(source);
      for(const warning of found.warnings)issues.add(harnessNames[source.harness]+' · '+warning);
      const listing={source,entries:found.sessions};listings.set(k,listing);return listing;
    };
    this.status={...this.status,running:true,issues:[]};this.emit({type:'history-sync',status:{...this.status}});
    let clients:Awaited<ReturnType<typeof nativeActivity>>={};
    try {
      try{clients=await this.activity();}catch(e){clients=Object.fromEntries(harnesses.map(h=>[h,true]));issues.add(describe(e));}
      for(const source of sources.values()) {
        if(this.stopped||this.connectionChanges)break;
        if(!imports())continue;
        try {
          const listing=await list(source);
          for(const entry of listing?.entries??[]) {
            if(this.stopped||this.connectionChanges||!imports())break;
            if(!this.chosen(source,entry)||entry.busy&&clients[source.harness]||!force&&Date.now()-entry.updatedAt<1200)continue;
            try{await this.receive(source,entry,!!clients[source.harness]);}catch(e){issues.add(entry.title+' · '+describe(e));}
          }
        }catch(e){issues.add(harnessNames[source.harness]+' · '+describe(e));}
      }
      // Read all selected endpoints before writing any. Simultaneous independent
      // turns must be observed as a conflict before either side can be published.
      for(const c of this.controller.store.list()) {
        if(this.stopped||this.connectionChanges||!exports())break;
        if(!c.revision||c.workspaceMissing||c.state!=='idle'||this.busy(c.id)||(!c.canonicalPath&&!c.bindings[c.harness]))continue;
        for(const source of this.endpoints(c).values()){
          if(this.stopped||this.connectionChanges||!exports())break;
          try {
            const listing=await list(source);if(!listing){issues.add(harnessNames[source.harness]+' · 请先在独立端初始化历史或在设置中选择原生数据路径');continue;}
            if([...this.unresolved.values()].some(x=>x.appId===c.id&&sameSource(x.source,source)))continue;
            await this.publish(c,source,listing.entries,force,false);
          }catch(e){issues.add(c.title+' → '+harnessNames[source.harness]+' · '+describe(e));}
        }
      }
    }finally{this.status={...this.status,running:false,lastSyncAt:Date.now(),issues:[...issues].slice(0,30)};this.emit({type:'history-sync',status:{...this.status}});}
    return this.status;
  }
  private async receive(source:NativeHistorySource,entry:NativeHistory,clientOpen:boolean) {
    const k=key(source,entry.id), owner=entry.provenance;
    let link=this.links.get(k);
    if(!link && owner?.profile===this.profile && this.controller.store.conversations.has(owner.appId)){
      link={source,sessionId:entry.id,appId:owner.appId,revision:owner.revision,fingerprint:owner.fingerprint??null};
      this.links.set(k,link);
    }
    const id=link?.appId??this.linkedApp(source,entry.id),c=id?this.controller.store.conversations.get(id):undefined;
    if(link?.detached||c&&this.busy(c.id)||link&&entry.version!==undefined&&link.version===entry.version&&!link.pendingRevision)return;
    if(link && [...this.unresolved.values()].some(x=>x.appId===link!.appId && sameSource(x.source,source)))return;
    const checked=await this.history.inspect(source,entry.id,entry);
    if(!this.chosen(source,entry)||this.stopped||checked.busy&&clientOpen)return;
    if(link && this.recoverPublication(link, checked)){
      link.version=entry.version;await this.save();return;
    }
    if(link&&checked.fingerprint===link.fingerprint){link.version=entry.version;await this.save();return;}
    if(c && link && c.revision!==link.revision && c.canonicalPath) {
      const remote=await this.history.archive(source,entry);
      const local=JSON.parse(await readFile(c.canonicalPath,'utf8')) as BridgeHistory;
      const a=meaningful(local),b=meaningful(remote);
      let common=0;
      while(common<a.length&&common<b.length&&content(a[common])===content(b[common]))common++;
      if(common===b.length){link.fingerprint=checked.fingerprint;link.version=entry.version;if(common===a.length)link.revision=c.revision;await this.save();return;}
      if(common<a.length){await this.recordConflict(c,source,entry,checked.fingerprint,local,remote,common);return;}
    }
    const imported = await this.pull(source,entry,c);
    this.links.set(k,{source,sessionId:entry.id,appId:imported.id,revision:imported.revision,fingerprint:checked.fingerprint,version:entry.version});
    await this.save();
  }
  private recoverPublication(link: Link, checked: Awaited<ReturnType<HistoryService['inspect']>>) {
    const {provenance, fingerprint} = checked;
    if (link.pendingRevision === undefined || provenance?.profile !== this.profile || provenance.appId !== link.appId || provenance.revision !== link.pendingRevision || provenance.fingerprint !== fingerprint) return false;
    link.fingerprint = fingerprint;
    // DeepSeek may still need to publish its project registry after the log.
    if (link.source.harness !== 'deepseek') {
      link.revision = link.pendingRevision;
      delete link.pendingRevision;
      delete link.pendingContent;
      delete link.replace;
    }
    return true;
  }
  private async pull(source:NativeHistorySource,entry:NativeHistory,c?:Conversation,branch?:Pick<Conversation,'id'|'origin'>){
    const action=()=>this.history.import({source,sessionId:entry.id},c,true,entry,branch);
    const chat=c?await this.job(c.id,()=>this.controller.exclusive(c.id,action)):await action();
    this.status.imported++;
    this.emit({type:'conversation',conversation:{...chat}});this.emit({type:'history-updated',conversation:{...chat}});
    return chat;
  }
  private async publish(c:Conversation,source:NativeHistorySource,entries:NativeHistory[],force:boolean,manual:boolean):Promise<ExportReceipt>{
    if(this.busy(c.id))throw Error('请等待本轮对话结束');
    if([...this.unresolved.values()].some(x=>x.appId===c.id&&sameSource(x.source,source)))throw Error('请先在蓝图中解决这条连线的分歧');
    let link=[...this.links.values()].find(l=>l.appId===c.id&&sameSource(l.source,source)&&!l.detached);
    const original=this.blueprint.scope(c);
    const exact=original&&sameSource(original.source,source)&&!original.sessionId?.startsWith('app:')?original.sessionId:undefined;
    const binding=c.bindings[source.harness];
    const shared=binding?.location&&sameSource({harness:source.harness,location:binding.location},source)?binding:undefined;
    const known=link?.sessionId??exact??shared?.sessionId;
    const row=entries.find(e=>e.id===known)??(!known?entries.find(e=>e.provenance?.profile===this.profile&&e.provenance.appId===c.id):undefined);
    if(!link && row) {
      const n=await this.history.inspect(source,row.id,row);
      const revision=shared?.sessionId===row.id&&shared.nativeCheckpoint?.version===n.fingerprint?shared.revision:
        n.provenance?.profile===this.profile&&n.provenance.appId===c.id?n.provenance.revision:exact===row.id&&c.revision===1?1:0;
      link={source,sessionId:row.id,appId:c.id,revision,fingerprint:n.provenance?.fingerprint??n.fingerprint};
      this.links.set(key(source,row.id),link);await this.save();
    }
    if(link?.revision===c.revision&&!link.pendingRevision && !link.replace && row)
      return {...source,sessionId:link.sessionId,workspace:c.workspace,verified:true,reused:true};
    if((known||link)&&!row&&!link?.pendingRevision)throw Error('原生会话已移动或删除，请检查原数据目录');
    const canCommit=async()=>{
      if(this.stopped||!manual&&(!this.connected(c,source)||!force&&this.controller.settings.value.history?.autoExport===false))throw Error('此同步已取消');
      const activity=await this.activity();
      if(!isAgentHarness(source.harness)&&activity[source.harness])throw Error('独立 '+harnessNames[source.harness]+' 仍在运行，退出后将自动写回');
      return {externalOpen:!!activity[source.harness],codexWriters:activity.codexWriters};
    };
    await canCommit();
    if(link&&row) {
      const n=await this.history.inspect(source,row.id,row);
      if(this.recoverPublication(link,n))await this.save();
      if(n.fingerprint!==link.fingerprint)throw Error('独立端有新内容，请先同步并确认分歧');
      if(link.revision===c.revision&&!link.pendingRevision&&!link.replace)return {...source,sessionId:link.sessionId,workspace:c.workspace,verified:true,reused:true};
    }
    const active:Link=link??{source,sessionId:isAgentHarness(source.harness)?'':source.harness==='deepseek'?'session-'+randomUUID():'sess_'+randomUUID(),appId:c.id,revision:0,fingerprint:null};
    active.pendingRevision=c.revision;
    active.pendingContent=c.canonicalPath;
    if(active.sessionId){this.links.set(key(source,active.sessionId),active);await this.save();}
    const receipt=await this.job(c.id,()=>this.history.export({conversationId:c.id,target:source},{
      sessionId:active.sessionId,expectedFingerprint:active.fingerprint,provenance:{profile:this.profile,appId:c.id,revision:c.revision},
      canCommit,replace:active.replace,allocated:async id=>{
        if(active.sessionId&&active.sessionId!==id)this.links.delete(key(source,active.sessionId));
        active.sessionId=id;this.links.set(key(source,id),active);await this.save();
      },
    }));
    const checked=await this.history.inspect(source,receipt.sessionId,{id:receipt.sessionId,title:c.title,workspace:c.workspace,createdAt:c.createdAt,updatedAt:c.updatedAt});
    active.sessionId=receipt.sessionId;active.fingerprint=checked.fingerprint;active.revision=c.revision;
    delete active.pendingRevision;delete active.pendingContent;delete active.replace;delete active.version;
    this.links.set(key(source,active.sessionId),active);await this.save();this.status.exported++;
    return receipt;
  }
  private async recordConflict(c:Conversation,source:NativeHistorySource,entry:NativeHistory,fingerprint:string,local:BridgeHistory,remote:BridgeHistory,common:number){
    const id=randomUUID(),directory=path.join(this.controller.store.root,'history-conflicts',id);
    await Promise.all([atomicJson(path.join(directory,'local.json'),local),atomicJson(path.join(directory,'remote.json'),remote)]);
    this.unresolved.set(id,{id,appId:c.id,source,title:c.title,sessionId:entry.id,fingerprint,revision:c.revision,
      local:meaningful(local).slice(common).map(content),remote:meaningful(remote).slice(common).map(content)});
    await this.save();
  }
  resolveConflict(id:string,choice:'local'|'remote'|'both'){
    return this.serialized(async()=>{
      const conflict=this.unresolved.get(id);
      if(!conflict||!['local','remote','both'].includes(choice))throw Error('请选择当前连线的分支');
      const c=this.controller.store.get(conflict.appId),source=conflict.source;
      if(this.busy(c.id))throw Error('请先结束本轮工作');
      const entry=(await this.history.list(source)).sessions.find(e=>e.id===conflict.sessionId);
      if(!entry)throw Error('独立端原会话不存在');
      const checked=await this.history.inspect(source,entry.id,entry);
      if(checked.busy)throw Error('请等待独立端本轮结束');
      const link=this.links.get(key(source,entry.id));
      if(!link)throw Error('未找到冲突连线');
      if(c.revision!==conflict.revision||checked.fingerprint!==conflict.fingerprint){
        this.unresolved.delete(id);await this.save();await this.receive(source,entry,false);
        throw Error('其中一端已继续对话，请查看最新分歧');
      }
      if(choice==='remote'){
        const changed=await this.pull(source,entry,c);
        for(const other of this.links.values())if(other.appId===c.id&&other!==link&&!other.detached)other.replace=true;
        link.revision=changed.revision;link.fingerprint=checked.fingerprint;link.version=entry.version;
      }else{
        if(choice==='both'){
          conflict.branchId??=randomUUID();await this.save();
          const origin={source:this.blueprint.scope(c)?.source??source,workspace:c.workspace};
          const scope={...origin,sessionId:'app:'+conflict.branchId};
          for(const target of this.blueprint.targets(scope))await this.blueprint.setRule(scope,target,false);
          if(!this.controller.store.conversations.has(conflict.branchId))await this.pull(source,entry,undefined,{id:conflict.branchId,origin});
        }
        link.fingerprint=checked.fingerprint;link.replace=true;
      }
      this.unresolved.delete(id);await this.save();
    });
  }
}
