import { strict as assert } from 'node:assert';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Controller } from '../backend/controller';
import { lockDeepSeekRegistry } from '../backend/dsh-files';
import { HistoryService } from '../backend/history';
import { HistorySync } from '../backend/history-sync';
import { appendKimiHistory, readKimiHistory } from '../backend/kimi-history';
import { bridgeEntries, messagesToBridge, portableMessages, type PortableEntry } from '../backend/portable-history';
import { SettingsStore, defaultAgentConnection } from '../backend/settings';
import { Store, atomicJson } from '../backend/store';
import type { Conversation, NativeHistorySource } from '../shared/types';
import { harnessScope } from '../shared/blueprint';

if (process.argv[2] === '--hold-deepseek-registry') {
  await lockDeepSeekRegistry(process.argv[3]);
  process.send!('locked');
  process.on('message', () => {});
} else test('blueprint routes isolate first launch, share changes and resolve divergent native turns', {timeout:180_000}, async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'entrotect-blueprint-'));
  const store=new Store(path.join(root,'app'));await store.init();
  const runtime=path.resolve('.runtime'),workspace=path.join(root,'project');
  const settings=new SettingsStore(store.root,runtime,path.join(runtime,'node','node.exe'),{protect:async s=>s,unprotect:async s=>s});
  await settings.init();
  const source:NativeHistorySource={harness:'deepseek',location:path.join(root,'deepseek')};
  const kimi:NativeHistorySource={harness:'kimi',location:path.join(root,'kimi')};
  await Promise.all([mkdir(workspace),mkdir(path.join(source.location,'sessions'),{recursive:true}),mkdir(kimi.location)]);
  settings.value={...settings.value,defaultWorkspace:workspace,history:{autoImport:true,autoExport:true,importScope:'all',exportScope:'all'},
    deepseek:{...settings.value.deepseek,home:source.location}, agents:{...settings.value.agents,kimi:{...defaultAgentConnection('kimi'),home:kimi.location}}};
  const controller=new Controller(store,settings,()=>{}), history=new HistoryService(controller);
  let scanned=0;
  const oldList=history.list.bind(history);
  history.list=async(source)=>{scanned++;return oldList(source);};
  let sync=new HistorySync(controller,history,()=>{},async()=>({}));
  async function restart() {
    await sync.stop();
    sync=new HistorySync(controller,history,()=>{},async()=>({}));
    await sync.init();
  }
  const add=(text:string):PortableEntry=>({role:'user',text,time:Date.now()});
  async function persist(c:Conversation,entries:PortableEntry[]) {
    const file=path.join(store.directory(c.id),'context','test-'+(c.revision+1)+'.entrotect.json');
    await atomicJson(file,messagesToBridge(entries,{id:c.id,title:c.title,cwd:workspace,createdAt:c.createdAt,updatedAt:Date.now()}));
    c.revision++;c.canonicalPath=file;c.bindings={};await store.save(c);
  }
  const archive=async(c:Conversation)=>bridgeEntries(JSON.parse(await readFile(c.canonicalPath!,'utf8')),'archive');
  try {
    await sync.init();
    const c=await controller.create(workspace,'deepseek',source);
    c.title='Relay test';await persist(c,[add('shared round')]);
    await sync.run(true);assert.equal(scanned,0);
    const scope=sync.blueprint.scope(c)!;
    await sync.blueprint.setRule(harnessScope(source),'kimi',true);
    await sync.blueprint.setRule(scope,'deepseek',true);
    const run=async()=>{const state=await sync.run(true);assert.deepEqual(state.issues,[]);};
    await run();
    const ex=await sync.exportManually({conversationId:c.id,target:kimi});
    assert(ex.reused);
    const id=ex.sessionId;
    assert.equal((await history.list(kimi)).sessions.length,1);
    await restart();
    const same=await sync.exportManually({conversationId:c.id,target:kimi});assert.equal(same.sessionId,id);
    let native=await readKimiHistory(kimi.location,workspace,id);
    await appendKimiHistory(kimi.location,workspace,id,native.version,[add('kimi continuation')]);
    await run();
    const main=store.get(c.id);
    assert.equal(main.origin?.source.harness,'deepseek');
    assert((await archive(main)).some(e=>'text' in e&&e.text==='kimi continuation'));
    const ds=(await history.list(source)).sessions;
    assert.equal(ds.length,1);
    assert(portableMessages(bridgeEntries(await history.archive(source,ds[0]),'archive')).some(e=>e.text==='kimi continuation'));

    await persist(main,[...await archive(main),add('desktop variant')]);
    native=await readKimiHistory(kimi.location,workspace,id);
    await appendKimiHistory(kimi.location,workspace,id,native.version,[add('independent variant')]);
    await run();
    assert.equal(sync.conflicts().length,1);
    const conflict=sync.conflicts()[0];
    assert.deepEqual(conflict.local,['user desktop variant']);
    assert.deepEqual(conflict.remote,['user independent variant']);
    await sync.resolveConflict(conflict.id,'both');
    const publish=history.export.bind(history);
    let kimiWrites=0;
    history.export=async(request,options)=>{
      const receipt=await publish(request,options);
      if(request.target.harness==='kimi' && ++kimiWrites===1)throw Error('simulated stop after Kimi commit');
      return receipt;
    };
    assert((await sync.run(true)).issues.some(issue=>issue.includes('simulated stop after Kimi commit')));
    await restart();
    await run();
    assert.equal(kimiWrites,1);
    history.export=publish;
    assert.equal(sync.conflicts().length,0);
    assert.equal(store.list().length,2);
    const branch=store.list().find(chat=>chat.id!==main.id)!;
    assert.deepEqual(sync.blueprint.scope(branch)?.source,scope.source);
    assert((await archive(branch)).some(e=>'text' in e&&e.text==='independent variant'));
    native=await readKimiHistory(kimi.location,workspace,id);
    assert(native.archived.some(e=>e.text==='desktop variant'));
    assert(!native.archived.some(e=>e.text==='independent variant'));
    assert.equal((await history.list(kimi)).sessions.length,1);
    await persist(main,[...await archive(main),add('local second conflict')]);
    await appendKimiHistory(kimi.location,workspace,id,native.version,[add('remote winner')]);
    await run();
    await sync.resolveConflict(sync.conflicts()[0].id,'remote');await run();
    assert((await archive(store.get(main.id))).some(e=>'text' in e&&e.text==='remote winner'));
    const resolved=portableMessages(bridgeEntries(await history.archive(source,ds[0]),'archive'));
    assert(resolved.some(e=>e.text==='remote winner'));
    assert(!resolved.some(e=>e.text==='local second conflict'));
    const cacheFile=path.join(source.location,'storages','session_projcache','sessions',`${ds[0].id}.json`);
    const savedCache=cacheFile+'.saved';
    await rename(cacheFile,savedCache);
    await mkdir(cacheFile);
    const current=store.get(main.id);
    await persist(current,[...await archive(current),add('interrupted DeepSeek publication')]);
    assert((await sync.run(true)).issues.length>0);
    await rm(cacheFile,{recursive:true,force:true});
    await rename(savedCache,cacheFile);

    const registry=path.join(source.location,'storages','workspace.json');
    const marker=`${registry}.entrotect.lock`;
    await writeFile(marker,'',{flag:'wx'});
    await assert.rejects(lockDeepSeekRegistry(registry),/另一次导出/);
    assert.equal(await readFile(marker,'utf8'),'');
    await unlink(marker);
    const child=fork(fileURLToPath(import.meta.url),['--hold-deepseek-registry',registry],{execArgv:[],stdio:['ignore','ignore','inherit','ipc']});
    try {
      const [message]=await Promise.race([
        once(child,'message'),
        once(child,'exit').then(()=>{throw Error('DeepSeek lock child exited before acquiring the lock');}),
      ]);
      assert.equal(message,'locked');
      await assert.rejects(lockDeepSeekRegistry(registry),/另一次导出/);
      await assert.rejects(writeFile(marker,'',{flag:'wx'}),{code:'EEXIST'});
    } finally {
      if(child.exitCode===null&&child.signalCode===null){
        const exited=once(child,'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
    assert((await stat(marker)).isDirectory());
    await restart();
    await run();
    await assert.rejects(stat(marker),{code:'ENOENT'});
    const recovered=(await history.list(source)).sessions;
    assert.deepEqual(recovered.map(session=>session.id),[ds[0].id]);
    assert(portableMessages(bridgeEntries(await history.archive(source,recovered[0]),'archive')).some(e=>e.text==='interrupted DeepSeek publication'));

    const latest=store.get(main.id), baseline=await archive(latest);
    const peer=await controller.create(workspace,'deepseek',source);
    await persist(peer,[...baseline,add('standalone DeepSeek variant')]);
    const checked=await history.inspect(source,ds[0].id,recovered[0]);
    await history.export({conversationId:peer.id,target:source},{sessionId:ds[0].id,expectedFingerprint:checked.fingerprint,provenance:{profile:'standalone-fixture',appId:peer.id,revision:peer.revision}});
    await persist(latest,[...baseline,add('desktop DeepSeek variant')]);
    await run();
    const [deepseekConflict]=sync.conflicts();
    assert.equal(deepseekConflict.source.harness,'deepseek');
    assert.deepEqual(deepseekConflict.local,['user desktop DeepSeek variant']);
    assert.deepEqual(deepseekConflict.remote,['user standalone DeepSeek variant']);
    await sync.resolveConflict(deepseekConflict.id,'local');
    await run();
    const [deepseekSession]=(await history.list(source)).sessions;
    assert.equal(deepseekSession.id,ds[0].id);
    const deepseekMessages=portableMessages(bridgeEntries(await history.archive(source,deepseekSession),'archive'));
    assert(deepseekMessages.some(e=>e.text==='desktop DeepSeek variant'));
    assert(!deepseekMessages.some(e=>e.text==='standalone DeepSeek variant'));

    await sync.blueprint.setRule(harnessScope(source),'kimi',null);
    native=await readKimiHistory(kimi.location,workspace,id);
    await appendKimiHistory(kimi.location,workspace,id,native.version,[add('disconnected')]);
    await run();
    assert(!(await archive(store.get(main.id))).some(e=>'text' in e&&e.text==='disconnected'));
  } finally {
    await sync.stop();await controller.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
