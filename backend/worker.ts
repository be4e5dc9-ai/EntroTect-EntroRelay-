import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { Store } from './store';
import { SettingsStore } from './settings';
import { Controller } from './controller';
import path from 'node:path';
import { WorkspaceService } from './workspace';
import { HistoryService } from './history';
import { HistorySync } from './history-sync';
import { reasoningCatalog } from '../shared/reasoning';
import { AccountUsageService } from './account-usage';
import { TokenActivity } from './token-activity';
import { RuntimeUpdates } from './runtime-updates';
import { harnesses } from '../shared/types';
import { isAgentHarness, isHarness, supportsIsolatedLogin } from '../shared/harnesses';

const write=(value: unknown)=>process.stdout.write(JSON.stringify(value)+'\n');
let next=0;
const pending=new Map<number,{resolve(value:string):void;reject(error:Error):void}>();
const host=(method:string,value:string)=>new Promise<string>((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});write({hostRequest:{id,method,value}});});
async function main(){
const root=process.env.ENTROTECT_DATA_DIR!;
const runtime=process.env.ENTROTECT_RUNTIME_DIR!;
const store=new Store(root);await store.init();
const settings=new SettingsStore(root,runtime,path.join(runtime,'node','node.exe'),{protect:value=>host('protect',value),unprotect:value=>host('unprotect',value)});await settings.init();
let synchronization:HistorySync|undefined;
const emit=(event:import('../shared/types').DesktopEvent)=>{write({event});if(event.type==='conversation'&&event.conversation.state==='idle')synchronization?.schedule();};
const updates=new RuntimeUpdates(settings,status=>emit({type:'harness-updates',status}));await updates.init();
const controller=new Controller(store,settings,emit);await controller.initStartup();
const accountUsage=new AccountUsageService(settings,()=>controller.deepseekBalance(),()=>controller.agents.codexRateLimits(),()=>controller.agents.kimiUsage());
const tokenActivity=new TokenActivity(store);
const project=new WorkspaceService();
const history=new HistoryService(controller);
const sync=new HistorySync(controller,history,emit);await sync.init();synchronization=sync;
const harness=(value:unknown)=>{if(!isHarness(value))throw new Error('不支持的 Harness');return value;};
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
let shutdown: Promise<boolean> | undefined;
async function closeBackend() {
  const results = await Promise.allSettled([sync.stop(), updates.stop(), controller.close()]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return true;
}
async function call(method:string,p:any={}) {
  if(shutdown && method!=='shutdown')throw new Error('应用正在退出');
  switch(method){
    case 'app:updatePreference':return settings.value.autoAppUpdate!==false;
    case 'app:shutdownForUpdate':
      if(controller.hasForegroundWork())throw new Error('请等待当前任务结束，再重启更新');
      return shutdown ??= closeBackend();
    case 'runtime:updateStatus':return updates.status;
    case 'runtime:checkUpdates':return updates.check();
    case 'history:sync':return sync.run(true);
    case 'history:status':return sync.status;
    case 'history:defaults':return history.defaults();
    case 'history:list':return sync.listHistory(p.source);
    case 'history:import':return sync.importManually(p.request);
    case 'history:import-selection':return sync.setImportSelection(p.rule);
    case 'history:export-selection':return sync.exportSelection(p.scope);
    case 'history:save-export-selection':return sync.setExportSelection(p.scope,p.rules);
    case 'history:export':return history.export(p.request);
    case 'agent:login':{
      const engine=harness(p.harness);
      if(!supportsIsolatedLogin(engine))throw new Error('当前 Harness 不使用独立登录');
      return controller.agents.loginCommand(engine);
    }
    case 'bootstrap':{
      const health=await settings.health();
      return {conversations:store.list(),projects:store.projects(),settings:settings.view(),health,dataDir:root,reasoning:reasoningCatalog(settings.value),historySync:sync.status,startupRoute:controller.startupRoute};
    }
    case 'runtime:selection':return controller.rememberRuntime(harness(p.harness),typeof p.conversationId==='string'?p.conversationId:undefined);
    case 'project:add':return store.addProject(p.workspace);
    case 'project:create':return store.createProject(p.parent,p.name);
    case 'account:usage':return accountUsage.read(harness(p.harness),p.refresh===true);
    case 'account:activity':return tokenActivity.read();
    case 'conversation:create':return controller.create(p.workspace,harness(p.harness));
    case 'commands:list':return controller.listCommands(harness(p.harness),p.workspace,p.modelId,p.id);
    case 'models:native': {
      const engine = harness(p.harness);
      if (!isAgentHarness(engine)) throw new Error('当前 Harness 不使用原生模型目录');
      return controller.nativeModels(engine, p.workspace, p.modelId);
    }
    case 'conversation:load':return {conversation:store.get(p.id),items:await store.items(p.id)};
    case 'conversation:send':return sync.userAction(p.id,()=>controller.send(p.id,p.text));
    case 'conversation:stop':return controller.stop(p.id);
    case 'conversation:switch':return controller.switchHarness(p.id,harness(p.harness));
    case 'conversation:selection':return sync.userAction(p.id,()=>controller.selectModel(p.id,p.modelId,p.harness === undefined ? undefined : harness(p.harness)));
    case 'conversation:reasoning':return sync.userAction(p.id,()=>controller.selectReasoning(p.id,p.level));
    case 'conversation:workspace':return sync.userAction(p.id,()=>controller.exclusive(p.id,async c=>{
      const binding=c.bindings[c.harness];
      const original=c.workspaceMissing?c.importedFrom:undefined;
      const location=isAgentHarness(c.harness)?binding?.location??controller.agents.location(c.harness):c.harness==='deepseek'?path.join(controller.codec.nativeRoot(c),'deepseek'):controller.codec.database(c);
      const sessionId=original?.sessionId??binding?.sessionId;
      if(!sessionId)throw new Error('没有可以迁移到新目录的会话');
      const changed=await history.import({source:original??{harness:c.harness,location},sessionId,workspace:p.workspace},c);
      emit({type:'history-updated',conversation:changed});emit({type:'conversation',conversation:changed});return changed;
    }));
    case 'conversation:context':return controller.context(p.id);
    case 'settings:save': {
      const changed = (['deepseek','zcode','agents','defaultWorkspace'] as const).some(k => !isDeepStrictEqual(p.settings?.[k], settings.value[k]))
        || harnesses.some(name => typeof p.keys?.[name] === 'string' && p.keys[name].trim());
      const save = () => settings.save(p.settings, p.keys);
      const saved = changed ? await sync.updateConnections(save) : await save();
      updates.preferencesChanged();
      sync.schedule();
      return saved;
    }
    case 'approval:answer':return controller.answer(p.id,p.allow===true,p.answer);
    case 'context:path':return store.get(p.id).canonicalPath ?? null;
    case 'workspace:files':return project.files(p.workspace,p.path);
    case 'workspace:read':return project.read(p.workspace,p.path);
    case 'workspace:read-reference':return project.readReference(p.workspace,p.reference);
    case 'workspace:git':return project.status(p.workspace);
    case 'workspace:diff':return project.diff(p.workspace,p.path);
    case 'shutdown':return shutdown ??= closeBackend();
    default:throw new Error(`未知请求：${method}`);
  }
}
lines.on('line',line=>{
  try {
    const frame=JSON.parse(line);
    if(frame.hostReply){const reply=frame.hostReply;const p=pending.get(reply.id);pending.delete(reply.id);if(p)reply.error?p.reject(new Error(reply.error)):p.resolve(reply.result);return;}
    void call(frame.method,frame.params).then(result=>write({id:frame.id,result:result??null}),error=>write({id:frame.id,error:String(error.message??error)}));
  } catch(error){process.stderr.write(String(error)+'\n');}
});
controller.startPrewarming();
updates.start();
sync.start();
lines.on('close', () => {
  for (const request of pending.values()) request.reject(new Error('桌面宿主已关闭'));
  pending.clear();
  void (shutdown ??= closeBackend()).finally(() => process.exit());
});
}
void main().catch(error=>{process.stderr.write(String(error)+'\n');process.exit(1);});
