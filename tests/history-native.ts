import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../backend/store';
import { SettingsStore } from '../backend/settings';
import { Controller } from '../backend/controller';
import { HistoryService } from '../backend/history';
import { RpcProcess } from '../backend/rpc';
import { modelFixture } from './fixture-server';

const root=path.resolve('.local',`history-native-${Date.now()}`),workspace=path.join(root,'project_中文');
await mkdir(workspace,{recursive:true});
const fixture=await modelFixture(),runtime=path.resolve('.runtime'),node=path.join(runtime,'node','node.exe');
async function profile(name:string){
 const store=new Store(path.join(root,name));await store.init();
 const settings=new SettingsStore(store.root,runtime,node,{protect:async s=>s,unprotect:async s=>s});await settings.init();
 await settings.save({...settings.value,defaultWorkspace:workspace,deepseek:{...settings.value.deepseek,home:path.join(root,`${name}-dsh-home`),authMode:'api',provider:'deepseek-official',model:'deepseek-flash',baseUrl:fixture.origin},zcode:{...settings.value.zcode,home:path.join(root,`${name}-zcode-home`),authMode:'api',provider:'entrotect-glm',model:'glm-5.3',baseUrl:fixture.origin+'/v1'}},{deepseek:'local-fixture-only',zcode:'local-fixture-only'});
 const controller=new Controller(store,settings,e=>{if(e.type==='conversation'&&e.conversation.error)console.log('NATIVE_ERROR',e.conversation.error);});
 return {store,settings,controller,history:new HistoryService(controller)};
}
async function idle(p:Awaited<ReturnType<typeof profile>>,id:string){
 const start=Date.now();while(Date.now()-start<90_000){const c=p.store.get(id);if(c.state==='error')throw Error(c.error);if(c.state==='idle')return;await new Promise(r=>setTimeout(r,100));}throw Error('等待本轮结束超时');
}
const p=await profile('app'),q=await profile('other-app');
try{
 const c=await p.controller.create(workspace,'deepseek');await p.controller.send(c.id,'请记住导出测试标记 ALPHA-731');await idle(p,c.id);
 const external=path.join(root,'standalone-dsh');await mkdir(external);
 const source={harness:'deepseek' as const,location:external};
 const first=await p.history.export({conversationId:c.id,target:source});
 const registryFile=path.join(external,'storages/workspace.json'),firstRegistry=JSON.parse(await readFile(registryFile,'utf8'));
 const [exportedProject]=Object.keys(firstRegistry.tables.workspaces);
 assert.deepEqual(firstRegistry.global.workspaceIds,[exportedProject]);
 // Older exports wrote the new project row but omitted its ID from the
 // display order, which causes the native desktop to reject the registry.
 const previousProject='a64bb4d9-c0ab-45ed-a8a6-f23345077265';
 firstRegistry.tables.workspaces[previousProject]={...firstRegistry.tables.workspaces[exportedProject],path:root,title:'Existing project',sessionIds:[]};
 firstRegistry.global.initialized=true;
 firstRegistry.global.workspaceIds=[previousProject];
 firstRegistry.global.unrelated={preserve:true};await writeFile(registryFile,JSON.stringify(firstRegistry));
 const second=await p.history.export({conversationId:c.id,target:source});
 assert.notEqual(first.sessionId,second.sessionId);assert(first.verified);assert(second.backup);
 const list=await q.history.list(source);assert.equal(list.sessions.length,2);assert.equal(list.sessions[0].workspace,workspace);
 const registry=JSON.parse(await readFile(path.join(external,'storages/workspace.json'),'utf8'));
 assert.equal(registry.tables.workspaces[exportedProject].sessionIds.length,2);
 assert.deepEqual(registry.global.workspaceIds,[previousProject,exportedProject]);
 assert.deepEqual(registry.tables.workspaces[previousProject],firstRegistry.tables.workspaces[previousProject]);
 assert.deepEqual(registry.global.unrelated,{preserve:true});
 assert.deepEqual(JSON.parse(await readFile(second.backup!,'utf8')),firstRegistry);
 const invalid=path.join(root,'unsupported-dsh');await mkdir(path.join(invalid,'storages'),{recursive:true});
 const invalidRegistry=path.join(invalid,'storages/workspace.json');await writeFile(invalidRegistry,'{"unit":{"version":999},"tables":{}}');
 await assert.rejects(()=>p.history.export({conversationId:c.id,target:{harness:'deepseek',location:invalid}}),/索引格式/);
 assert.equal(await readFile(invalidRegistry,'utf8'),'{"unit":{"version":999},"tables":{}}');
 await writeFile(invalidRegistry,'');
 await assert.rejects(()=>p.history.export({conversationId:c.id,target:{harness:'deepseek',location:invalid}}));
 assert.equal(await readFile(invalidRegistry,'utf8'),'','已有空索引不能被当作不存在的索引覆盖');
 const countBeforeFailure=q.store.list().length;
 await assert.rejects(()=>q.history.import({source,sessionId:first.sessionId,workspace:path.join(root,'missing-project')}),/目录不存在/);
 assert.equal(q.store.list().length,countBeforeFailure,'失败的导入不应发布会话');
 const original=await readFile(first.location),before=createHash('sha256').update(original).digest('hex');
 const imported=await q.history.import({source,sessionId:first.sessionId});
 assert((await q.store.items(imported.id)).some(i=>i.kind==='user'&&i.text.includes('ALPHA-731')));
 assert((await q.store.items(imported.id)).some(i=>i.kind==='assistant'&&i.text.includes('ALPHA-731')));
 fixture.reply('恢复后记住 BETA-842');await q.controller.send(imported.id,'历史标记是什么？再记住 BETA-842。');await idle(q,imported.id);
 assert(JSON.stringify(fixture.requests.at(-1)!.body).includes('ALPHA-731'));
 assert.equal(createHash('sha256').update(await readFile(first.location)).digest('hex'),before,'导入修改了源日志');
 console.log('DEEPSEEK_IMPORT_EXPORT_CONTINUE_OK');
 // Restore the exported copy with the user's separately installed official CLI.
 const installed='D:\\dsh\\DeepSeek Harness.exe';
 try{await readFile(installed);const env={...process.env,DSH_HOME:external,DEEPSEEK_API_KEY:'local-fixture-only',DEEPSEEK_BASE_URL:fixture.origin,ELECTRON_RUN_AS_NODE:'1',NO_COLOR:'1'};
 const rpc=new RpcProcess({...p.settings.value.deepseek,executable:installed,args:['--expose-internals','D:\\dsh\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js','--profile','sdk']},workspace,env,true);
 try{await rpc.request('initialize',{cwd:workspace,provider:'deepseek-official',model:'deepseek-flash'});await rpc.request('session/resume',{sessionId:first.sessionId});console.log('INDEPENDENT_DEEPSEEK_COLD_RESTORE_OK');}finally{await rpc.close();}
 }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')console.log('INDEPENDENT_INSTALL_NOT_PRESENT');else throw e;}
 // An independently initialized ZCode DB is the real destination, not a JSON export.
 const independent=await q.controller.create(workspace,'zcode');await q.controller.initializeDatabase(independent);
 const zsource={harness:'zcode' as const,location:q.controller.codec.database(independent)};
 const zfirst=await p.history.export({conversationId:c.id,target:zsource});
 assert(zfirst.backup);assert.equal((await p.history.list(zsource)).sessions.length,1);
 const zenv=await q.settings.environment('zcode',q.controller.codec.nativeRoot(independent));
 const zcli=new RpcProcess({...q.settings.value.zcode,args:[q.settings.value.zcode.args[0],'--prompt','核对原对话标记 ALPHA-731，追加独立续聊 DELTA-164。','--cwd',workspace,'--mode','build','--output-format','stream-json','--resume',zfirst.sessionId]},workspace,zenv,false);
 fixture.reply('独立 ZCode 已恢复 ALPHA-731，记住 DELTA-164');
 try {
  let response='';zcli.on('frame',f=>{if(f.type==='result')response=f.response||'';});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('独立 ZCode 续聊超时')),90_000);zcli.once('closed',()=>{clearTimeout(timer);response.includes('DELTA-164')?resolve():reject(Error('独立 ZCode 未正常完成续聊'));});});
  assert(JSON.stringify(fixture.requests.at(-1)!.body).includes('ALPHA-731'));
 }finally{await zcli.close();await q.settings.cleanupRuntime(q.controller.codec.nativeRoot(independent));}
 console.log('INDEPENDENT_ZCODE_CLI_CONTINUATION_OK');
 const zin=await p.history.import({source:zsource,sessionId:zfirst.sessionId});
 fixture.reply('ZCode 续聊完成 GAMMA-953');await p.controller.send(zin.id,'核对历史 ALPHA-731，追加 GAMMA-953');await idle(p,zin.id);
 assert(JSON.stringify(fixture.requests.at(-1)!.body).includes('ALPHA-731'));
 assert(JSON.stringify(fixture.requests.at(-1)!.body).includes('DELTA-164'));
 const zsecond=await p.history.export({conversationId:zin.id,target:zsource});assert.notEqual(zfirst.sessionId,zsecond.sessionId);
 assert.equal((await p.history.list(zsource)).sessions.length,2);
 const dsCross=await p.history.export({conversationId:zin.id,target:source});
 const cross=await q.history.import({source,sessionId:dsCross.sessionId});
 fixture.reply('跨 Harness 往返完成');await q.controller.send(cross.id,'核对历史 GAMMA-953');await idle(q,cross.id);
 assert(JSON.stringify(fixture.requests.at(-1)!.body).includes('GAMMA-953'));
 console.log('ZCODE_BIDIRECTIONAL_AND_CROSS_HARNESS_OK');
 const nativeConfig=path.join(p.settings.value.zcode.home,'.zcode/v2/provider_config.json');await mkdir(path.dirname(nativeConfig),{recursive:true});
 await writeFile(nativeConfig,JSON.stringify({config:{defaultModelSelection:{providerId:'native-account-default',modelId:'native-model',options:{reasoningLevel:'high'}}}}));
 const routed=await p.history.export({conversationId:zin.id,target:zsource});
 const db=new DatabaseSync(zsource.location,{readOnly:true});
 try{const row=db.prepare("select data from session_entry where session_id=? and type='runtime/model_selection' order by time_updated desc limit 1").get(routed.sessionId)!;assert.equal(JSON.parse(String(row.data)).modelSelection.providerId,'native-account-default');}finally{db.close();}
 console.log('ZCODE_NATIVE_PROVIDER_SELECTION_PRESERVED_OK');
 // Read one existing user conversation locally; never send its contents to a model.
 if(process.env.ENTROTECT_TEST_EXISTING_HISTORY==='1'){
 const nativeSource={harness:'deepseek' as const,location:path.join(os.homedir(),'.dsh')};
 const existing=await p.history.list(nativeSource),entry=existing.sessions.find(s=>s.id==='session-17320229-75ba-44d9-9107-a57db92a7938');
 assert(entry,'预期的已有测试会话不存在');
 const requestsBeforeImport=fixture.requests.length;
 const actual=await p.history.import({source:nativeSource,sessionId:entry.id,workspace});
 assert.equal(fixture.requests.length,requestsBeforeImport,'离线导入不应发送模型请求');
 const items=await p.store.items(actual.id);assert(items.some(i=>i.kind==='user'));assert(items.some(i=>i.kind==='assistant'));assert(items.some(i=>i.kind==='tool'));
 await writeFile(path.join(root,'existing-history-evidence.json'),JSON.stringify({sourceSessions:existing.sessions.length,displayItems:items.length,users:items.filter(i=>i.kind==='user').length,assistants:items.filter(i=>i.kind==='assistant').length,tools:items.filter(i=>i.kind==='tool').length,requestsSent:fixture.requests.length-requestsBeforeImport},null,2));
 console.log('EXISTING_LOCAL_HISTORY_IMPORT_COLD_RESTORE_OK',items.length);
 }
 await writeFile(path.join(root,'result.json'),JSON.stringify({passed:true,first,second,zfirst,zsecond,dsCross,modelRequests:fixture.requests.length},null,2));
 console.log('HISTORY_TEST_ROOT',root);
}finally{await p.controller.close();await q.controller.close();await fixture.close();}
