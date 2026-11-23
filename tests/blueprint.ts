import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { BlueprintStore } from '../backend/blueprint';
import { atomicJson, Store } from '../backend/store';
import type { HistoryService } from '../backend/history';
import { harnesses, type Conversation, type Harness, type NativeHistory, type NativeHistorySource } from '../shared/types';
import { projectKey } from '../shared/project-path';
import { blueprintScopeKey, harnessScope } from '../shared/blueprint';

async function profile(t:TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(),'entrotect-blueprint-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:3}));
  const workspace = path.join(root,'project');
  await mkdir(workspace);
  const store = new Store(root);
  await store.init();
  const sources = Object.fromEntries(harnesses.map(h=>[h,{harness:h,location:path.join(root,h)}])) as Record<Harness,NativeHistorySource>;
  const rows = new Map<Harness,NativeHistory[]>();
  const scans: Harness[] = [];
  const history = {
    defaults:()=>sources, available:async()=>true,
    list:async(source:NativeHistorySource)=>{ scans.push(source.harness); return {source,sessions:rows.get(source.harness) ?? [],warnings:[]}; }
  } as unknown as HistoryService;
  return {store,root,sources,workspace,history,rows,scans};
}
test('catalog is lazy, groups native origins, excludes replicas and persists explicit rules',async t=>{
  const p = await profile(t);
  const book = new BlueprintStore(p.store,p.history);
  await book.init();
  await book.dismiss();
  assert.deepEqual(p.scans,[]);
  assert.deepEqual(book.activeSources(),[]);
  const source = p.sources.codex;
  await p.store.addProject(p.workspace,'codex');
  const chat:Conversation = {id:randomUUID(),title:'same title',workspace:p.workspace,harness:'kimi',origin:{source},
    createdAt:1,updatedAt:3,revision:1,state:'idle',bindings:{}};
  await p.store.save(chat);
  const base = {title:chat.title,workspace:p.workspace,createdAt:Date.now()+1,updatedAt:1};
  p.rows.set('codex',[
    {...base,id:'native'}, {...base,id:'pending',createdAt:1},
    {...base,id:'remote-copy',provenance:{appId:'another',profile:'elsewhere',revision:2}},
    {...base,id:'published'},
  ]);
  const linked = (_:NativeHistorySource,id:string)=>id==='published'?chat.id:undefined;
  const listed = await book.catalog('codex',linked);
  assert.deepEqual(p.scans,['codex']);
  assert.deepEqual(listed.projects[0].chats.map(c=>c.scope.sessionId).sort(),['app:'+chat.id,'native'].sort());
  assert.deepEqual(listed.pending.map(c=>c.scope.sessionId),['pending']);
  const project = {source,workspace:p.workspace};
  const session = {...project,sessionId:'native'};
  await book.setRule(harnessScope(source),'workbench',true);
  assert.deepEqual(book.activeSources(),[source]);
  assert.deepEqual(book.targets({...project,sessionId:'future'}),['workbench']);
  await book.setRule(project,'workbench',false);
  assert.deepEqual(book.targets({...project,sessionId:'future'}),[]);
  await Promise.all([book.setRule(project,'kimi',true),book.setRule(session,'kimi',false),book.setRule(session,'workbench',true)]);
  assert.deepEqual(book.targets(session),['workbench']);
  assert.deepEqual(book.targets({...project,sessionId:'future'}),['kimi']);
  assert.deepEqual(book.targets({...project,source:p.sources.opencode,sessionId:'future'}),[]);
  await book.confirm(listed.pending.map(c=>c.scope),'native');
  const after = new BlueprintStore(p.store,p.history);
  await after.init();
  assert.equal(after.onboarded,true);
  assert.equal((await after.catalog('codex',linked)).pending.length,0);
  assert.deepEqual(after.targets(session),['workbench']);
  await after.setRule(session,'kimi',null);
  assert.deepEqual(after.targets(session),['workbench','kimi']);
  await after.setRule(project,'workbench',null);
  assert.deepEqual(after.targets({...project,sessionId:'future'}),['workbench','kimi']);
  p.sources.codex={harness:'codex',location:path.join(p.root,'other-codex-profile')};
  const switched=await after.catalog('codex',()=>undefined);
  assert(switched.projects.some(project=>project.source?.location===source.location && project.chats.some(c=>c.appId===chat.id)));
  assert(switched.projects.some(project=>project.source?.location===p.sources.codex.location));
});
test('migration restores only explicit selections and keeps old source identities',async t=>{
  const p = await profile(t);
  const source = p.sources.zcode;
  const native: Conversation = {id:randomUUID(),title:'legacy',workspace:p.workspace,harness:'codex',state:'idle',
    createdAt:1,updatedAt:2,revision:1,bindings:{codex:{sessionId:'original-codex',location:p.sources.codex.location,revision:1,nativeCheckpoint:{version:'version',content:'checkpoint'}}}};
  await p.store.save(native);
  const empty = path.join(p.root,'empty-project');
  await atomicJson(path.join(p.root,'history-selection.json'),{imports:[{source,sessionId:'selected',enabled:true}],exports:{['project:'+projectKey(empty)]:{kimi:true}}});
  await atomicJson(path.join(p.root,'settings.json'),{history:{autoImport:true,autoExport:true,importScope:'all',exportScope:'all'}});
  const book = new BlueprintStore(p.store,p.history);
  await book.init();
  assert.deepEqual(p.scans,[]);
  assert.equal(book.scope(native)?.sessionId,'original-codex');
  const restarted = new Store(p.root);
  await restarted.init();
  assert.deepEqual(restarted.get(native.id).origin?.source,p.sources.codex);
  assert.equal(book.rules.length,1);
  const row = {id:'selected',workspace:p.workspace,title:'',createdAt:1,updatedAt:1};
  assert.equal(book.classify(source,row),'native');
  assert.equal(book.classify(source,{...row,id:'unselected'}),'pending');
  assert.equal(book.classify(source,{...row,provenance:{profile:'other',appId:'uuid',revision:1}}),'copy');
  assert.deepEqual(book.targets({source,workspace:p.workspace,sessionId:'selected'}),['workbench']);
  assert.deepEqual(book.targets({source,workspace:empty,sessionId:'first'}),[]);
  await book.claimLegacyProject(source,empty);
  assert.deepEqual(book.targets({source,workspace:empty,sessionId:'first'}),['kimi']);
  const priorOrigin=blueprintScopeKey({source,workspace:p.workspace,sessionId:'prior'});
  const file=path.join(p.root,'blueprint.json');
  const saved=JSON.parse(await readFile(file,'utf8'));
  await atomicJson(file,{...saved,recordedOrigins:{[priorOrigin]:'old-app-id'}});
  const reloaded=new BlueprintStore(p.store,p.history);
  await reloaded.init();
  const original={...row,id:'prior',provenance:{profile:'old-app',appId:'old-app-id',revision:4}};
  assert.equal(reloaded.classify(source,original),'native');
  assert.equal(reloaded.classify(source,{...original,provenance:{...original.provenance,appId:'different'}}),'copy');
});
