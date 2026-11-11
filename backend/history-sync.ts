import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { harnesses, type Conversation, type DesktopEvent, type HistoryExportRules, type HistoryExportScope, type HistoryExportSelection, type HistoryImportRule, type HistorySyncStatus, type HistoryImport, type NativeHistory, type NativeHistorySource } from '../shared/types';
import { Controller } from './controller';
import { HistoryService } from './history';
import { atomicJson } from './store';
import {nativeActivity} from './native-activity';
import { harnessNames, isAgentHarness } from '../shared/harnesses';
import { HistorySelection, historySourceKey as sourceKey } from './history-selection';

type Link = { source: NativeHistorySource; sessionId: string; appId: string; revision: number; fingerprint: string | null; version?: string; pendingRevision?: number; detached?: boolean };
const key = (s: NativeHistorySource,id:string) => `${sourceKey(s)}:${id}`;
export class HistorySync {
  status: HistorySyncStatus = {running:false,imported:0,exported:0,issues:[]};
  private links = new Map<string,Link>();
  private timer?: NodeJS.Timeout; private scheduled?: NodeJS.Timeout; private work?: Promise<HistorySyncStatus>; private stopped=false;
  private connectionChanges = 0;
  private manualImport: Promise<unknown> = Promise.resolve();
  private jobs = new Map<string,Promise<unknown>>(); private reserved=new Map<string,number>();
  private readonly profile: string; private readonly file:string;
  private readonly selection: HistorySelection;
  constructor(private controller:Controller,private history:HistoryService,private emit:(e:DesktopEvent)=>void,private activity=nativeActivity){this.profile=createHash('sha256').update(path.resolve(controller.store.root).toLowerCase()).digest('hex');this.file=path.join(controller.store.root,'history-sync.json');this.selection=new HistorySelection(controller.store.root);}
  async init(){
    await this.selection.init();
    try{const saved=JSON.parse(await readFile(this.file,'utf8'));if(saved.version!==1)throw Error('历史同步索引版本不受支持');for(const link of saved.links)this.links.set(key(link.source,link.sessionId),link);}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }
  private save(){return atomicJson(this.file,{version:1,links:[...this.links.values()]});}
  private imported(source: NativeHistorySource, id: string) {
    const link=this.links.get(key(source,id));
    const linked=link&&this.controller.store.conversations.get(link.appId);
    if(linked)return linked;
    for(const c of this.controller.store.conversations.values()){
      if(source.harness==='codex'&&this.sharedBinding(source,c,id))return c;
      if(c.importedFrom&&key(c.importedFrom,c.importedFrom.sessionId)===key(source,id))return c;
    }
  }
  private importStatus(source: NativeHistorySource, entry: NativeHistory) {
    const rules=this.selection.importRules(source,entry.id,entry.workspace);
    const joined=!!this.imported(source,entry.id);
    return { joined, allowed:rules.session??rules.project??(joined||this.controller.settings.value.history?.importScope==='all'), ...rules };
  }
  async listHistory(source: NativeHistorySource) {
    const list=await this.history.list(source);
    return {...list,sessions:list.sessions.map(entry=>({...entry,sync:this.importStatus(source,entry)}))};
  }
  async setImportSelection(rule: HistoryImportRule) {
    await this.selection.setImport(rule);
    this.schedule();
  }
  importManually(request: HistoryImport) {
    const task=this.manualImport.catch(()=>{}).then(async()=>{
      this.connectionChanges++;
      try {
        await this.work;
        const existing=this.imported(request.source,request.sessionId);
        if(existing&&(!request.workspace||path.resolve(existing.workspace).toLowerCase()===path.resolve(request.workspace).toLowerCase()&&!existing.workspaceMissing))return existing;
        const c=await this.history.import(request);
        this.emit({type:'conversation',conversation:c});
        return c;
      } finally { this.connectionChanges--; this.schedule(); }
    });
    this.manualImport=task;
    return task;
  }
  exportSelection(scope: HistoryExportScope): HistoryExportSelection {
    const workspace=scope?.kind==='conversation'?this.controller.store.get(scope.id).workspace:scope?.kind==='project'?scope.workspace:undefined;
    if(typeof workspace!=='string'||!path.isAbsolute(workspace))throw Error('同步范围无效');
    const project=scope.kind==='conversation'?this.selection.exportRules({kind:'project',workspace}):{};
    const history=this.controller.settings.value.history;
    const inherited=Object.fromEntries(harnesses.map(harness=>[harness,project[harness]??(history?.exportScope==='all')])) as HistoryExportSelection['inherited'];
    return {rules:this.selection.exportRules(scope),inherited,enabled:history?.autoExport!==false};
  }
  async setExportSelection(scope: HistoryExportScope, rules: HistoryExportRules) {
    this.exportSelection(scope);
    await this.selection.setExport(scope,rules);
    this.schedule();
    return this.exportSelection(scope);
  }
  start(){this.stopped=false;this.schedule();this.timer=setInterval(()=>this.schedule(),15_000);this.timer.unref();}
  schedule(){if(this.stopped||this.connectionChanges||this.scheduled||(this.controller.settings.value.history?.autoImport===false&&this.controller.settings.value.history?.autoExport===false))return;this.scheduled=setTimeout(()=>{this.scheduled=undefined;void this.run().catch(e=>{this.status.issues=[String(e.message||e)];this.emit({type:'history-sync',status:{...this.status}});});},250);this.scheduled.unref();}
  async stop(){this.stopped=true;clearInterval(this.timer);clearTimeout(this.scheduled);this.scheduled=undefined;await this.work;}
  async updateConnections<T>(change: () => Promise<T>) {
    this.connectionChanges++;
    try {
      await this.work?.catch(() => {});
      return await this.controller.updateConnections(change);
    } finally { this.connectionChanges--; this.schedule(); }
  }
  async userAction<T>(id:string,action:()=>Promise<T>):Promise<T>{
    this.reserved.set(id,(this.reserved.get(id)??0)+1);
    try{await this.jobs.get(id);return await action();}
    finally{const remaining=(this.reserved.get(id)??1)-1;if(remaining)this.reserved.set(id,remaining);else this.reserved.delete(id);}
  }
  private busy(id:string){return this.reserved.has(id)||this.controller.isBusy(id);}
  private async job<T>(id:string,action:()=>Promise<T>):Promise<T>{const promise=action();this.jobs.set(id,promise);try{return await promise;}finally{this.jobs.delete(id);}}
  private sharedBinding(source:NativeHistorySource,c:Conversation,id?:string){
    if(!isAgentHarness(source.harness))return;
    const binding=c.bindings[source.harness];
    if(binding?.location&&(!id||binding.sessionId===id)&&sourceKey({...source,location:binding.location})===sourceKey(source))return binding;
  }
  private async checkpointShared(link:Link,c:Conversation,entry:NativeHistory,native:Awaited<ReturnType<HistoryService['inspect']>>){
    const binding=this.sharedBinding(link.source,c,entry.id);
    const checkpoint=binding?.nativeCheckpoint;
    if(!checkpoint||link.detached||binding.revision<link.revision||native.busy||
      (checkpoint.version!==native.fingerprint&&checkpoint.content!==native.contentFingerprint))return false;
    link.revision=binding.revision;link.fingerprint=native.fingerprint;link.version=entry.version;
    delete link.pendingRevision;
    this.links.set(key(link.source,link.sessionId),link);
    await this.save();
    return true;
  }
  async run(force=false):Promise<HistorySyncStatus>{
    if(this.stopped||this.connectionChanges)return this.status;
    if(this.work){const result=await this.work;if(force&&!this.stopped)return this.run(true);return result;}
    this.work=this.cycle(force).finally(()=>{this.work=undefined;});return this.work;
  }
  private async cycle(force:boolean){
    const issues=new Set<string>();const preferences=()=>({autoImport:true,autoExport:true,...this.controller.settings.value.history});
    const options=preferences();
    const conversations=this.controller.store.list();
    const imports=options.autoImport&&(options.importScope==='all'||this.selection.importSources().length>0||this.links.size>0
      ||conversations.some(c=>c.importedFrom||c.bindings.codex));
    const exports=options.autoExport&&conversations.some(c=>c.revision>0&&!c.workspaceMissing&&!c.externalMirror
      &&harnesses.some(harness=>this.selection.exportAllowed(c,harness,options.exportScope==='all')));
    if(!imports&&!exports)return this.status;
    this.status={...this.status,running:true,issues:[]};this.emit({type:'history-sync',status:{...this.status}});
    let clients:Awaited<ReturnType<typeof nativeActivity>>={};
    try{
      if(preferences().autoImport||preferences().autoExport){try{clients=await this.activity();}catch(e){clients=Object.fromEntries(harnesses.map(harness=>[harness,true]));issues.add((e as Error).message);}}
      const targets=new Map(Object.values(this.history.defaults()).map(source=>[sourceKey(source),source]));
      const sources=new Map(targets);
      if(preferences().autoImport){
        for(const source of this.selection.importSources())sources.set(sourceKey(source),source);
        for(const link of this.links.values())if(this.controller.store.conversations.has(link.appId))sources.set(sourceKey(link.source),link.source);
        for(const c of this.controller.store.conversations.values())if(c.importedFrom){
          const {harness,location}=c.importedFrom;
          const source={harness,location};
          sources.set(sourceKey(source),source);
        }
      }
      for(const source of (preferences().autoImport||preferences().autoExport)?sources.values():[]){
        if(this.stopped||this.connectionChanges)break;
        if(!await this.history.available(source))continue;
        if(this.stopped)break;
        const agent = isAgentHarness(source.harness);
        let entries:NativeHistory[];
        try{const listed=await this.history.list(source);entries=listed.sessions;for(const warning of listed.warnings)issues.add(`${source.harness}：${warning}`);}
        catch(e){issues.add(`${source.harness}：${(e as Error).message}`);continue;}
        if(preferences().autoImport)for(const entry of entries){
          if(this.stopped||this.connectionChanges||!preferences().autoImport)break;
          if(!this.importStatus(source,entry).allowed||entry.busy&&clients[source.harness]||(!force&&Date.now()-entry.updatedAt<1_200))continue;
          let link=this.links.get(key(source,entry.id));
          if(link&&(this.busy(link.appId)||entry.version!==undefined&&link.version===entry.version&&!link.pendingRevision))continue;
          if(!link&&agent){
            const local=this.controller.store.list().find(chat=>this.sharedBinding(source,chat,entry.id));
            if(local){
              const binding=this.sharedBinding(source,local,entry.id)!;
              if(this.busy(local.id)||!binding.nativeCheckpoint)continue;
              // The live runtime already wrote this session. Use its last
              // checkpoint as the baseline even if an external turn followed.
              link={source,sessionId:entry.id,appId:local.id,revision:binding.revision,fingerprint:binding.nativeCheckpoint.version};
              this.links.set(key(source,entry.id),link);
            }
          }
          try{
            const native=await this.history.inspect(source,entry.id,entry);if(this.stopped)break;if(!preferences().autoImport||!this.importStatus(source,entry).allowed||native.busy&&clients[source.harness])continue;
            const owner=native.provenance;
            // Recover a committed export even if the app closed before writing
            // its sync index. Vendor-side provenance is committed with the data.
            if(!link&&owner?.profile===this.profile&&this.controller.store.conversations.has(owner.appId)){
              link={source,sessionId:entry.id,appId:owner.appId,revision:owner.revision,fingerprint:owner.fingerprint??null};this.links.set(key(source,entry.id),link);
            }
            if(!link){
              const prior=this.controller.store.list().find(c=>c.importedFrom&&key(c.importedFrom,c.importedFrom.sessionId)===key(source,entry.id));
              if(prior&&this.busy(prior.id))continue;
              if(prior&&entry.updatedAt<=prior.importedFrom!.importedAt){
                link={source,sessionId:entry.id,appId:prior.id,revision:1,fingerprint:native.fingerprint,version:entry.version};this.links.set(key(source,entry.id),link);await this.save();continue;
              }
              const reusable=prior&&prior.revision===1?prior:undefined;
              const c=await this.pull(source,entry,reusable,false,!!owner&&owner.profile!==this.profile);
              link={source,sessionId:entry.id,appId:c.id,revision:c.revision,fingerprint:native.fingerprint,version:entry.version};this.links.set(key(source,entry.id),link);await this.save();continue;
            }
            const c=this.controller.store.conversations.get(link.appId);if(!c)continue;
            if(agent&&await this.checkpointShared(link,c,entry,native))continue;
            if(link.pendingRevision&&owner?.profile===this.profile&&owner.appId===c.id&&owner.revision===link.pendingRevision&&owner.fingerprint===native.fingerprint){
              // Leave it pending so a DSH registry update interrupted by shutdown
              // is completed by the outbound pass before the link is committed.
              link.fingerprint=native.fingerprint;link.version=entry.version;await this.save();continue;
            }
            if(native.fingerprint===link.fingerprint){link.version=entry.version;await this.save();continue;}
            const conflict=link.detached||c.revision!==link.revision;
            const imported=await this.pull(source,entry,conflict?undefined:c,conflict,!!owner&&owner.profile!==this.profile);
            link={source,sessionId:entry.id,appId:imported.id,revision:imported.revision,fingerprint:native.fingerprint,version:entry.version};this.links.set(key(source,entry.id),link);await this.save();
          }catch(e){issues.add(`${entry.title}：${(e as Error).message}`);}
        }
        if(!preferences().autoExport||!targets.has(sourceKey(source)))continue;
        for(const c of this.controller.store.list()){
          if(this.stopped||this.connectionChanges||!preferences().autoExport)break;
          if(!this.selection.exportAllowed(c,source.harness,preferences().exportScope==='all')||!c.revision||c.workspaceMissing||c.externalMirror||this.busy(c.id)||c.state!=='idle'||(!c.bindings[c.harness]&&!c.canonicalPath))continue;
          let link=[...this.links.values()].find(l=>l.appId===c.id&&sourceKey(l.source)===sourceKey(source)&&!l.detached);
          const entry=link?entries.find(e=>e.id===link!.sessionId):undefined;
          if(link&&entry&&path.resolve(entry.workspace).toLowerCase()!==path.resolve(c.workspace).toLowerCase()){link.detached=true;await this.save();link=undefined;}
          if(link&&link.revision===c.revision&&!link.pendingRevision)continue;
          if(agent && link && !entry)continue;
          const shared=agent&&this.sharedBinding(source,c,link?.sessionId);
          const sharedEntry=shared&&entries.find(e=>e.id===shared.sessionId);
          if(sharedEntry&&shared.nativeCheckpoint&&shared.revision===c.revision){
            try{
              const native=await this.history.inspect(source,sharedEntry.id,sharedEntry);
              const candidate=link??{source,sessionId:sharedEntry.id,appId:c.id,revision:0,fingerprint:null};
              if(await this.checkpointShared(candidate,c,sharedEntry,native))continue;
              // A later external update owns this shared file. An outbound
              // pass cannot append the desktop snapshot over it.
              continue;
            }catch(e){issues.add(`${sharedEntry.title}：${(e as Error).message}`);continue;}
          }
          const waitForClient = !agent;
          if(waitForClient&&clients[source.harness]){issues.add(`独立 ${harnessNames[source.harness]} 仍在运行，退出后将自动写回`);continue;}
          try{
            if(!link){link={source,sessionId:agent?'':source.harness==='deepseek'?`session-${randomUUID()}`:`sess_${randomUUID()}`,appId:c.id,revision:0,fingerprint:null,pendingRevision:c.revision};if(link.sessionId){this.links.set(key(source,link.sessionId),link);await this.save();}}
            if(entry){const native=await this.history.inspect(source,entry.id,entry);if(link.pendingRevision&&native.provenance?.profile===this.profile&&native.provenance.appId===c.id&&native.provenance.revision===link.pendingRevision&&native.provenance.fingerprint===native.fingerprint)link.fingerprint=native.fingerprint;if(native.fingerprint!==link.fingerprint)continue;}
            const publishingRevision=c.revision;link.pendingRevision=publishingRevision;if(link.sessionId)await this.save();const active=link;
            if(this.stopped||this.busy(c.id))continue;
            const receipt=await this.job(c.id,()=>this.history.export({conversationId:c.id,target:source},{
              sessionId:active.sessionId,expectedFingerprint:active.fingerprint,provenance:{profile:this.profile,appId:c.id,revision:publishingRevision},
              canCommit:async()=>{
                const checked=waitForClient||source.harness==='opencode'||source.harness==='codex'&&!!active.sessionId ? await this.activity() : {};
                const externalOpen=checked[source.harness]===true;
                if(waitForClient&&externalOpen)throw Error('独立客户端仍在运行，退出后将自动写回');
                if(!preferences().autoExport)throw Error('自动导出已关闭');
                if(!this.selection.exportAllowed(c,source.harness,preferences().exportScope==='all'))throw Error('已取消向此 Harness 同步');
                return {externalOpen,codexWriters:checked.codexWriters};
              },
            }));
            link.sessionId=receipt.sessionId;
            this.links.set(key(source,link.sessionId),link);
            const actual=await this.history.inspect(source,link.sessionId,agent?{ id:link.sessionId, title:c.title, workspace:c.workspace, createdAt:c.createdAt, updatedAt:c.updatedAt }:undefined);
            if(actual.provenance?.fingerprint!==actual.fingerprint)continue;
            link.fingerprint=actual.fingerprint;link.revision=publishingRevision;delete link.pendingRevision;link.version=undefined;await this.save();this.status.exported++;
          }catch(e){issues.add(`${c.title} → ${source.harness}：${(e as Error).message}`);}
        }
      }
    }finally{this.status={...this.status,running:false,lastSyncAt:Date.now(),issues:[...issues].slice(0,30)};this.emit({type:'history-sync',status:{...this.status}});}
    return this.status;
  }
  private async pull(source:NativeHistorySource,entry:NativeHistory,existing?:Conversation,branch=false,externalMirror=false){
    const action=()=>this.history.import({source,sessionId:entry.id},existing,true,entry);
    const c=existing?await this.job(existing.id,()=>this.controller.exclusive(existing.id,action)):await action();
    c.externalMirror=externalMirror;if(branch)c.title+='（独立端分支）';await this.controller.store.save(c);
    this.status.imported++;this.emit({type:'conversation',conversation:{...c}});this.emit({type:'history-updated',conversation:{...c}});return {...c};
  }
}
