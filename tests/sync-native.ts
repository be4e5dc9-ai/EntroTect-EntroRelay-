import assert from 'node:assert/strict';
import {copyFile,cp,mkdir,readFile,readdir,rmdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Store} from '../backend/store';
import {SettingsStore} from '../backend/settings';
import {Controller} from '../backend/controller';
import {HistoryService} from '../backend/history';
import {HistorySync} from '../backend/history-sync';
import {RpcProcess} from '../backend/rpc';
import {modelFixture} from './fixture-server';
import {modelReasoning} from '../shared/reasoning';
import {agentHarnesses} from '../shared/types';

const root=path.resolve('.local',`sync-native-${Date.now()}`),workspace=path.join(root,'project');await mkdir(workspace,{recursive:true});
const fixture=await modelFixture(),runtime=path.resolve('.runtime'),node=path.join(runtime,'node/node.exe');
async function profile(name:string){
 const store=new Store(path.join(root,name));await store.init();const settings=new SettingsStore(store.root,runtime,node,{protect:async s=>s,unprotect:async s=>s});await settings.init();
 await settings.save({...settings.value,defaultWorkspace:workspace,deepseek:{...settings.value.deepseek,home:path.join(root,`${name}-dsh`),provider:'deepseek-official',model:'deepseek-flash',authMode:'api',baseUrl:fixture.origin},zcode:{...settings.value.zcode,home:path.join(root,`${name}-zcode`),provider:'test-local',model:'glm-5.3',authMode:'api',baseUrl:fixture.origin+'/v1'}, agents:Object.fromEntries(agentHarnesses.map(harness=>[harness,{...settings.value.agents?.[harness],home:path.join(root,`${name}-${harness}`)}]))},{deepseek:'local-fixture',zcode:'local-fixture'});
 const controller=new Controller(store,settings,e=>{if(e.type==='conversation'&&e.conversation.error)console.log('RUN_ERROR',e.conversation.error);});const history=new HistoryService(controller),sync=new HistorySync(controller,history,()=>{},async()=>({}));await sync.init();return{store,settings,controller,history,sync};
}
async function idle(p:Awaited<ReturnType<typeof profile>>,id:string){const start=Date.now();while(Date.now()-start<100_000){const c=p.store.get(id);if(c.state==='error')throw Error(c.error);if(c.state==='idle')return;await new Promise(r=>setTimeout(r,70));}throw Error('运行超时');}
async function independent(home:string,id:string,text:string,hold=false){
 const env={...process.env,DSH_HOME:home,DEEPSEEK_API_KEY:'local-fixture',DEEPSEEK_BASE_URL:fixture.origin,NO_COLOR:'1'};delete env.ELECTRON_RUN_AS_NODE;
 const rpc=new RpcProcess({executable:node,args:[path.join(runtime,'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','sdk'],home,provider:'deepseek-official',model:'deepseek-flash',authMode:'api',baseUrl:fixture.origin},workspace,env,true);
 let engaged=false,resolve!:()=>void,reject!:(e:Error)=>void;const done=new Promise<void>((r,j)=>{resolve=r;reject=j;});void done.catch(()=>{});
 rpc.on('notification',f=>{if(f.params?.sessionId!==id)return;if(f.method==='session.event'){if(f.params.event.type==='turn/start')engaged=true;if(f.params.event.type==='turn/end'&&f.params.event.data.reason?.kind==='error')reject(Error('原生测试会话失败'));}if(f.method==='session.status'&&engaged&&f.params.status==='idle')resolve();});
 await rpc.request('initialize',{cwd:workspace,provider:'deepseek-official',model:'deepseek-flash'});await rpc.request('session/resume',{sessionId:id});await rpc.request('session/prompt',{sessionId:id,contentBlocks:[{type:'text',text}]});
 if(hold)return{rpc,done};
 try{let timer:ReturnType<typeof setTimeout>;await Promise.race([done,new Promise((_,j)=>{timer=setTimeout(()=>j(Error('独立续聊超时')),90_000);})]).finally(()=>clearTimeout(timer!));}finally{await rpc.close();}
 return{rpc,done};
}
const p=await profile('app'),seed=await profile('seed');
try{
 let probes=0;
 const idleSync=new HistorySync(p.controller,p.history,()=>{},async()=>{probes++;return {};});
 await idleSync.init();await idleSync.run();
 assert.equal(probes,0,'unselected history must not start native process discovery');
 let releaseFirst!:()=>void,releaseSecond!:()=>void;
 const firstAction=p.sync.userAction('overlapping',()=>new Promise<void>(resolve=>{releaseFirst=resolve;}));
 const secondAction=p.sync.userAction('overlapping',()=>new Promise<void>(resolve=>{releaseSecond=resolve;}));
 await Promise.resolve();
 releaseFirst();await firstAction;
 assert(p.sync['busy']('overlapping'),'another user action still owns the synchronization reservation');
 releaseSecond();await secondAction;
 assert(!p.sync['busy']('overlapping'));
 assert.deepEqual(modelReasoning('deepseek-flash','deepseek').levels.map(l=>l.id),['off','low','high','max']);
 assert.deepEqual(modelReasoning('glm-5.3','zcode').levels.map(l=>l.id),['low','high','max']);assert.equal(modelReasoning('unknown-custom-model','zcode').levels.length,0);
 const c=await seed.controller.create(workspace,'deepseek');await seed.controller.send(c.id,'请记住 ALPHA-731');await idle(seed,c.id);
 const home=p.settings.value.deepseek.home;await mkdir(path.join(home,'sessions'),{recursive:true});const receipt=await seed.history.export({conversationId:c.id,target:{harness:'deepseek',location:home}});
 const dbHolder=await seed.controller.create(workspace,'zcode');await seed.controller.initializeDatabase(dbHolder);const zdb=seed.controller.codec.database(dbHolder);
 p.settings.value.history={autoImport:true,autoExport:true,sources:{zcode:zdb}};
 const dsource={harness:'deepseek' as const,location:home};
 await p.sync.run(true);
 assert.equal(p.store.list().length,0,'a scan must leave unselected histories pending');
 assert.deepEqual((await p.sync.listHistory(dsource)).sessions[0].sync,{joined:false,allowed:false,session:undefined,project:undefined});
 await p.sync.setImportSelection({source:dsource,workspace,enabled:true});
 await p.sync.setImportSelection({source:dsource,sessionId:receipt.sessionId,enabled:false});
 await p.sync.run(true);
 assert.equal(p.store.list().length,0,'a conversation exception wins over an allowed import project');
 await p.sync.setImportSelection({source:dsource,sessionId:receipt.sessionId,enabled:null});
 await p.sync.run(true);
 assert.equal(p.store.list().length,1);
 const importedScope={kind:'conversation' as const,id:p.store.list()[0].id};
 const projectScope={kind:'project' as const,workspace};
 const zsource={harness:'zcode' as const,location:zdb};
 assert.equal((await p.history.list(zsource)).sessions.length,0,'export requires a selected target');
 await p.sync.setExportSelection(projectScope,{zcode:true});
 await p.sync.setExportSelection(importedScope,{zcode:false});
 assert.equal(p.sync.exportSelection(importedScope).inherited.zcode,true);
 await p.sync.run(true);
 assert.equal((await p.history.list(zsource)).sessions.length,0,'conversation rules override project export');
 await p.sync.setExportSelection(importedScope,{});
 const savedSelection=new HistorySync(p.controller,p.history,()=>{},async()=>({}));
 await savedSelection.init();
 assert.equal(savedSelection.exportSelection(importedScope).inherited.zcode,true);
 const before=fixture.requests.length;let status=await p.sync.run(true);assert.equal(status.issues.length,0,status.issues.join('\n'));assert.equal(fixture.requests.length,before,'后台导入/导出不应调用模型');
 assert.equal(p.store.list().length,1);const imported=p.store.list()[0];assert((await p.store.items(imported.id)).some(i=>i.text.includes('ALPHA-731')));
 assert.equal((await p.history.list(zsource)).sessions.length,1);await p.sync.run(true);assert.equal(p.store.list().length,1,'镜像被重复导入');
 p.settings.value.history={...p.settings.value.history,importScope:'all',exportScope:'all'};
 console.log('AUTOMATIC_IMPORT_DEDUP_AND_BOTH_HARNESSES_OK');
 // Automatic reads and writes must not require this application's API keys.
 const keylessRoot=path.join(root,'keyless'),keylessStore=new Store(keylessRoot);await keylessStore.init();const keylessSettings=new SettingsStore(keylessRoot,runtime,node,{protect:async s=>s,unprotect:async s=>s});await keylessSettings.init();keylessSettings.value={...p.settings.value};
 const keylessDsh=path.join(root,'keyless-native-dsh'),keylessDb=path.join(root,'keyless-native.sqlite');await cp(home,keylessDsh,{recursive:true});await copyFile(zdb,keylessDb);keylessSettings.value.history={autoImport:true,autoExport:true,importScope:'all',exportScope:'all',sources:{deepseek:keylessDsh,zcode:keylessDb}};
 const keylessController=new Controller(keylessStore,keylessSettings,()=>{}),keylessHistory=new HistoryService(keylessController),keylessSync=new HistorySync(keylessController,keylessHistory,()=>{},async()=>({}));await keylessSync.init();
 const keylessBefore=fixture.requests.length;const keylessStatus=await keylessSync.run(true);assert.deepEqual(keylessStatus.issues,[]);assert.equal(keylessStore.list().length,2);await keylessSync.run(true);assert.equal(fixture.requests.length,keylessBefore);
 const peer=await profile('peer');peer.settings.value.history={autoImport:true,autoExport:true,importScope:'all',exportScope:'all',sources:{deepseek:keylessDsh,zcode:keylessDb}};await peer.sync.run(true);await keylessSync.run(true);await peer.sync.run(true);
 const peerCount=peer.store.list().length,keylessCount=keylessStore.list().length;await keylessSync.run(true);await peer.sync.run(true);assert.equal(peer.store.list().length,peerCount);assert.equal(keylessStore.list().length,keylessCount);assert.equal(fixture.requests.length,keylessBefore);await peer.sync.stop();await peer.controller.close();await keylessSync.stop();await keylessController.close();
 console.log('FOREIGN_PROFILE_MIRRORS_DO_NOT_ECHO_FOREVER_OK');
 console.log('AUTOMATIC_SYNC_WITHOUT_MODEL_CREDENTIALS_OK');
 await p.controller.selectReasoning(imported.id,'low');fixture.reply('新增 BETA-842');await p.controller.send(imported.id,'请保留历史并记住 BETA-842');await idle(p,imported.id);
 assert.equal(fixture.requests.at(-1)!.body.output_config.effort,'low');
 status=await p.sync.run(true);assert.equal(status.issues.length,0,status.issues.join('\n'));
 const dsList=await p.history.list({harness:'deepseek',location:home});assert.equal(dsList.sessions.length,1);assert.equal(dsList.sessions[0].id,receipt.sessionId);
 fixture.reply('独立端新增 GAMMA-953');await independent(home,receipt.sessionId,'核对 BETA-842，追加 GAMMA-953');
 assert(JSON.stringify(fixture.requests.at(-1)!.body).includes('BETA-842'));
 status=await p.sync.run(true);assert.equal(status.issues.length,0,status.issues.join('\n'));assert.equal(p.store.list().length,1);assert((await p.store.items(imported.id)).some(i=>i.text.includes('GAMMA-953')));
 console.log('SAME_NATIVE_ID_CONTINUES_AND_PULLS_BACK_OK');
 // Read/write the same persisted mapping after restart; no new session is created.
 const recovered=new HistorySync(p.controller,p.history,()=>{},async()=>({}));await recovered.init();await recovered.run(true);assert.equal(p.store.list().length,1);
 await p.controller.selectReasoning(imported.id,'max');fixture.reply('本地新增 LOCAL-164');await p.controller.send(imported.id,'本地新增 LOCAL-164');await idle(p,imported.id);assert.equal(fixture.requests.at(-1)!.body.output_config.effort,'max');
 fixture.reply('独立端新增 REMOTE-275');await independent(home,receipt.sessionId,'独立端新增 REMOTE-275');await recovered.run(true);
 assert.equal(p.store.list().length,2,'两端更新应保留分支');assert(p.store.list().some(c=>c.title.includes('独立端分支')));
 await recovered.run(true);assert.equal(p.store.list().length,2,'冲突处理不应反复复制分支');
 const source={harness:'deepseek' as const,location:home},fingerprint=(await p.history.inspect(source,receipt.sessionId)).fingerprint;
 p.settings.value.history={...p.settings.value.history!,autoImport:false,autoExport:false};fixture.reply('关闭同步后的本地消息');await p.controller.send(imported.id,'关闭自动同步');await idle(p,imported.id);await recovered.run(true);
 assert.equal((await p.history.inspect(source,receipt.sessionId)).fingerprint,fingerprint);
 console.log('CONFLICT_BRANCH_RESTART_AND_OFF_SWITCHES_OK');
 await p.controller.selectModel(imported.id,'glm-5.3');await assert.rejects(()=>p.controller.selectReasoning(imported.id,'off'),/没有经过核实/);
 await p.controller.selectReasoning(imported.id,'low');fixture.reply('GLM 低强度');await p.controller.send(imported.id,'验证 GLM 低强度');await idle(p,imported.id);assert.equal(fixture.requests.at(-1)!.body.reasoning_effort,'low');
 await p.controller.selectReasoning(imported.id,'max');fixture.reply('GLM 最高强度');await p.controller.send(imported.id,'验证 GLM 最高强度');await idle(p,imported.id);assert.equal(fixture.requests.at(-1)!.body.reasoning_effort,'max');
 await p.controller.selectModel(imported.id,'deepseek-flash');await p.controller.selectReasoning(imported.id,'off');fixture.reply('关闭思考');await p.controller.send(imported.id,'验证关闭思考');await idle(p,imported.id);assert.equal(fixture.requests.at(-1)!.body.thinking.type,'disabled');assert(!fixture.requests.at(-1)!.body.output_config);
 console.log('NATIVE_REASONING_WIRE_LEVELS_OK');
 // The first native-login CLI turn must honor the chosen level, too.
 const nativeFile=path.join(p.settings.value.zcode.home,'.zcode/v2/provider_config.json');await mkdir(path.dirname(nativeFile),{recursive:true});
 await writeFile(nativeFile,JSON.stringify({schemaVersion:1,config:{providerConfigRules:{providerRules:[{providerId:'test-local',providerName:'Fixture',config:{group:'standard-personal',access:{type:'api-key',apiKey:'local-fixture'},api:{type:'openai-chat-completions',baseUrl:fixture.origin+'/v1'},personalModelIds:['glm-5.3']}}]},modelConfigRules:{providerModelRules:[],manualProviderModelRules:[]},defaultModelSelection:{providerId:'test-local',modelId:'glm-5.3',options:{reasoningLevel:'high'}}}}));
 p.settings.value.zcode.authMode='native';p.settings.value.zcode.provider='';p.settings.value.zcode.model='';const nativeDefaults=JSON.parse(await readFile(nativeFile,'utf8'));nativeDefaults.config.providerConfigRules.providerRules[0].config.personalModelIds=['GLM-5.3'];nativeDefaults.config.defaultModelSelection.modelId='GLM-5.3';await writeFile(nativeFile,JSON.stringify(nativeDefaults));const first=await p.controller.create(workspace,'zcode');await p.controller.selectModel(first.id,'glm-5.3');await p.controller.selectReasoning(first.id,'low');fixture.reply('原生 CLI 首轮低强度');await p.controller.send(first.id,'首轮原生 CLI');await idle(p,first.id);assert.equal(fixture.requests.at(-1)!.body.reasoning_effort,'low');
 console.log('NATIVE_LOGIN_CLI_FIRST_TURN_REASONING_OK');
 assert.deepEqual((await readdir(path.join(p.store.root,'conversations'))).filter(id=>!p.store.conversations.has(id)),[],'导出准备目录不应无限累积');
 p.settings.value.history={...p.settings.value.history!,autoImport:true,autoExport:true};
 const guarded=new HistorySync(p.controller,p.history,()=>{},async()=>({deepseek:true,zcode:true}));await guarded.init();
 const unchanged=(await p.history.inspect(source,receipt.sessionId)).fingerprint;const waiting=await guarded.run(true);assert(waiting.issues.some(i=>i.includes('仍在运行')));assert.equal((await p.history.inspect(source,receipt.sessionId)).fingerprint,unchanged);
 console.log('CACHED_NATIVE_CLIENT_DEFERRED_OK');
 const expired=path.join(root,'old-project');await mkdir(expired);const old=await seed.controller.create(expired,'deepseek');fixture.reply('旧项目历史 OLD-HISTORY-386');await seed.controller.send(old.id,'旧项目历史 OLD-HISTORY-386');await idle(seed,old.id);const oldExport=await seed.history.export({conversationId:old.id,target:source});await rmdir(expired);
 const offline=new HistorySync(p.controller,p.history,()=>{},async()=>({deepseek:true,zcode:true}));await offline.init();const requestsBefore=fixture.requests.length;await offline.run(true);assert.equal(fixture.requests.length,requestsBefore);
 const missing=p.store.list().find(c=>c.importedFrom?.sessionId===oldExport.sessionId)!;assert(missing?.workspaceMissing);assert((await p.store.items(missing.id)).some(i=>i.text.includes('OLD-HISTORY-386')));
 const recoveredWorkspace=path.join(root,'recovered-project');await mkdir(recoveredWorkspace);
 const relocated=await p.controller.exclusive(missing.id,()=>p.history.import({source:{harness:'deepseek',location:path.join(p.controller.codec.nativeRoot(missing),'deepseek')},sessionId:missing.bindings.deepseek!.sessionId,workspace:recoveredWorkspace},missing));assert.equal(relocated.workspaceMissing,false);
 console.log('MISSING_PROJECT_OFFLINE_IMPORT_AND_RELOCATION_OK');
 const paused=await profile('paused-app');
 try{
  await mkdir(path.join(paused.settings.value.deepseek.home,'sessions'),{recursive:true});const holder=await paused.controller.create(workspace,'zcode');await paused.controller.initializeDatabase(holder);const pausedZ={harness:'zcode' as const,location:paused.controller.codec.database(holder)};paused.settings.value.history={autoImport:true,autoExport:true,importScope:'all',exportScope:'all',sources:{zcode:pausedZ.location}};
  const interrupted=await paused.controller.create(workspace,'deepseek');fixture.hold(true);const beforePause=fixture.requests.length;await paused.controller.send(interrupted.id,'这轮将主动暂停 PAUSED-497');while(fixture.requests.length===beforePause)await new Promise(r=>setTimeout(r,50));await paused.controller.stop(interrupted.id);assert.equal(interrupted.state,'idle');fixture.hold(false);
  const firstPaused=await paused.sync.run(true);assert.deepEqual(firstPaused.issues,[]);const dsSource={harness:'deepseek' as const,location:paused.settings.value.deepseek.home};const dsId=(await paused.history.list(dsSource)).sessions[0].id,zId=(await paused.history.list(pausedZ)).sessions[0].id;
  fixture.reply('暂停后继续 PAUSE-RESUMED-508');await paused.controller.send(interrupted.id,'在暂停后继续');await idle(paused,interrupted.id);const resumed=await paused.sync.run(true);assert.deepEqual(resumed.issues,[]);assert.equal((await paused.history.list(dsSource)).sessions[0].id,dsId);assert.equal((await paused.history.list(pausedZ)).sessions[0].id,zId);
  console.log('PAUSE_AND_NEXT_ROUND_SYNC_SAME_NATIVE_IDS_OK');
 }finally{fixture.hold(false);await paused.sync.stop();await paused.controller.close();}
 await writeFile(path.join(root,'result.json'),JSON.stringify({passed:true,conversations:p.store.list().length,modelRequests:fixture.requests.length,status},null,2));console.log('SYNC_TEST_ROOT',root);
}finally{await p.sync.stop();await seed.sync.stop();await p.controller.close();await seed.controller.close();await fixture.close();}
