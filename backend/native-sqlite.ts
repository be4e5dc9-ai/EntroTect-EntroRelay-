import { spawn } from 'node:child_process';

// SQLite stays in the bundled Node runtime (the worker can run inside a host
// without node:sqlite). Read connections never create a missing source DB.
const script = String.raw`
const {DatabaseSync,backup}=require('node:sqlite');
const {randomUUID,createHash}=require('node:crypto');
const {writeFileSync}=require('node:fs');
const tables=['session','message','part','session_entry'];
function readRows(db,id){return Object.fromEntries(tables.map(t=>[t,db.prepare('select * from "'+t+'" where '+(t==='session'?'id':'session_id')+'=? order by id').all(id)]));}
function fingerprint(rows){return createHash('sha256').update(JSON.stringify({...rows,session_entry:rows.session_entry.filter(r=>r.type!=='integration/entrotect')})).digest('hex');}
function busy(db,id,rows){let pending=false;try{pending=!!db.prepare("select 1 from session_input where session_id=? and status in ('pending','queued','running','promoted','processing') limit 1").get(id);}catch{}return pending||rows.part.some(r=>{try{const p=JSON.parse(r.data);return p.type==='tool'&&['pending','running'].includes(p.state?.status);}catch{return false;}});}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);
process.stdin.on('end',async()=>{try{
const p=JSON.parse(input);
if(p.action==='create'){
 const db=new DatabaseSync(p.target);try{db.exec('BEGIN IMMEDIATE');const now=Date.now(),project=('proj_'+p.workspace.toLowerCase().replace(/[:()]/g,'').replace(/[^a-z0-9.]/g,'-')).slice(0,85);
 db.prepare('insert into session(id,project_id,slug,directory,path,title,version,permission,time_created,time_updated,task_type,title_source) values(?,?,?,?,?,?,?,?,?,?,?,?)').run(p.sessionId,project,p.sessionId,p.workspace,p.workspace,p.title,'0.17.1',JSON.stringify({mode:'build'}),p.createdAt||now,now,'interactive','first_input');
 const insertEntry=db.prepare('insert into session_entry(id,session_id,type,time_created,time_updated,data) values(?,?,?,?,?,?)');
 insertEntry.run('entry_'+randomUUID(),p.sessionId,'runtime/execution_state',now,now,JSON.stringify({mode:'build',planEnabled:false}));
 if(p.modelSelection)insertEntry.run(p.sessionId+':entrotect-model',p.sessionId,'runtime/model_selection',now,now,JSON.stringify({modelSelection:p.modelSelection}));
 if(p.messages?.length){
  const insertMessage=db.prepare('insert into message(id,session_id,time_created,time_updated,data,sequence) values(?,?,?,?,?,?)');
  const insertPart=db.prepare('insert into part(id,message_id,session_id,time_created,time_updated,data,sequence) values(?,?,?,?,?,?,?)');
  const ids=p.messages.map(()=> 'msg_'+randomUUID());
  let partSequence=0;
  for(const [sequence,message] of p.messages.entries()){
   const id=ids[sequence],time=message.time||now;
   insertMessage.run(id,p.sessionId,time,time,JSON.stringify({...message.info,time:{created:time,completed:time},agent:'zcode-agent',path:{cwd:p.workspace,root:p.workspace},mode:'build',planEnabled:false}),sequence);
   for(const part of message.parts)insertPart.run('part_'+randomUUID(),id,p.sessionId,time,time,JSON.stringify(part),partSequence++);
   if(message.info.entrotectCheckpoint){
    const previous=ids[sequence-1];
    const part={type:'compaction',auto:false,trigger:'manual',phase:'standalone_turn',tail_start_id:previous,
      compactBoundary:{boundaryId:'compact_'+randomUUID(),trigger:'manual',phase:'standalone_turn',preCompactTokenCount:0,
      summarizedMessageCount:sequence,keptMessageCount:0,lastSummarizedMessageId:previous,summaryMessageIds:[id],traceId:randomUUID()}};
    insertPart.run('part_'+randomUUID(),id,p.sessionId,time,time,JSON.stringify(part),partSequence++);
   }
  }
 }
 db.exec('COMMIT');console.log(JSON.stringify({sessionId:p.sessionId}));
 }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}return;
}
if(p.action==='configureModel'){
 const db=new DatabaseSync(p.target);try{db.exec('BEGIN IMMEDIATE');const row=db.prepare('select max(time_updated) as t from session_entry where session_id=?').get(p.sessionId);const now=Math.max(Date.now(),(row.t||0)+1);
 db.prepare('insert into session_entry (id,session_id,type,time_created,time_updated,data) values (?,?,?,?,?,?) on conflict(id) do update set time_updated=excluded.time_updated,data=excluded.data').run(p.sessionId+':entrotect-model',p.sessionId,'runtime/model_selection',now,now,JSON.stringify({modelSelection:p.modelSelection}));
 db.exec('COMMIT');console.log('{}');}finally{db.close();}return;
}
const src=new DatabaseSync(p.source,{readOnly:true});
if(p.action==='readContext'){
 try{
  src.exec('BEGIN');
  if(!src.prepare('select 1 from session where id=? and time_deleted is null').get(p.sessionId))throw Error('ZCode 原生会话不存在');
  const messages=src.prepare('select id,time_created as time,data from message where session_id=? order by sequence,id').all(p.sessionId);
  const parts=src.prepare('select message_id as messageId,data from part where session_id=? order by sequence,id').all(p.sessionId);
  console.log(JSON.stringify({messages,parts}));
 }finally{src.close();}
 return;
}
if(p.action==='list'){
 src.exec('BEGIN');const rows=src.prepare('select id,title,directory as workspace,time_created as createdAt,time_updated as updatedAt from session where time_deleted is null order by time_updated desc').all();
 for(const row of rows){const data=readRows(src,row.id);row.version=fingerprint(data);row.busy=busy(src,row.id,data);}src.exec('COMMIT');src.close();console.log(JSON.stringify(rows));return;
}
src.exec('BEGIN');
const rows=readRows(src,p.sessionId);
if(rows.session.length!==1)throw Error('原生会话不存在');
if(p.action==='inspect'){const provenanceRow=rows.session_entry.find(r=>r.type==='integration/entrotect');const result={fingerprint:fingerprint(rows),busy:busy(src,p.sessionId,rows),provenance:provenanceRow?JSON.parse(provenanceRow.data):undefined};src.exec('COMMIT');src.close();console.log(JSON.stringify(result));return;}
src.exec('COMMIT');src.close();
const ids=new Map([[p.sessionId,p.newId]]);
for(const t of tables.slice(1))for(const r of rows[t])ids.set(r.id,(t==='message'?'msg_':t==='part'?'part_':'entry_')+randomUUID());
const remap=v=>typeof v==='string'?(ids.get(v)||v):Array.isArray(v)?v.map(remap):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[ids.get(k)||k,remap(x)])):v;
const dst=new DatabaseSync(p.target);dst.exec('PRAGMA busy_timeout=10000');
try{
 if(p.backup&&!p.recordBackup)await backup(dst,p.backup);
 dst.exec('BEGIN IMMEDIATE');
 if(p.expectedFingerprint!==undefined){
  const existing=readRows(dst,p.newId),current=existing.session.length?fingerprint(existing):null;
  if(current!==p.expectedFingerprint)throw Error('原生会话已在独立端更新，已停止覆盖');
  if(existing.session.length&&!p.allowInactivePending&&busy(dst,p.newId,existing))throw Error('独立 ZCode 会话仍在运行');
  if(p.backup&&p.recordBackup&&existing.session.length)writeFileSync(p.backup,JSON.stringify({format:'entrotect-zcode-session-backup',version:1,rows:existing}),{flag:'wx'});
  for(const t of ['part','message','session_entry'])dst.prepare('delete from "'+t+'" where session_id=?').run(p.newId);
 }
 let modelEntry=false;
 for(const t of tables){
  const columns=new Set(dst.prepare('pragma table_info("'+t+'")').all().map(c=>c.name));
  for(const original of rows[t]){
   if(t==='session_entry'&&original.type==='integration/entrotect')continue;
   const row=remap(original);
   for(const key of Object.keys(row))if(!columns.has(key))throw Error('目标 ZCode 数据库版本不兼容：'+t+'.'+key);
   if(typeof row.data==='string'){try{row.data=JSON.stringify(remap(JSON.parse(row.data)));}catch(e){if(!(e instanceof SyntaxError))throw e;}}
   if(t==='session_entry'&&row.type==='runtime/model_selection'&&p.targetModel){row.data=JSON.stringify({modelSelection:p.targetModel});modelEntry=true;}
   if(t==='session'){
    row.id=p.newId;row.title=p.title;row.directory=p.workspace;row.path=p.workspace;
    row.project_id=('proj_'+p.workspace.toLowerCase().replace(/[:()]/g,'').replace(/[^a-z0-9.]/g,'-')).slice(0,85);
    if('parent_id'in row)row.parent_id=null;
    row.time_updated=Date.now();
   }
   const keys=Object.keys(row),quote=k=>'"'+k.replaceAll('"','""')+'"';
   const update=t==='session'&&p.expectedFingerprint!==undefined?' on conflict(id) do update set '+keys.filter(k=>k!=='id').map(k=>quote(k)+'=excluded.'+quote(k)).join(','):'';
   dst.prepare('insert into '+quote(t)+' ('+keys.map(quote).join(',')+') values ('+keys.map(()=>'?').join(',')+')'+update).run(...keys.map(k=>row[k]));
  }
 }
 if(p.targetModel&&!modelEntry){const now=Date.now();dst.prepare('insert into session_entry(id,session_id,type,time_created,time_updated,data) values(?,?,?,?,?,?)').run('entry_'+randomUUID(),p.newId,'runtime/model_selection',now,now,JSON.stringify({modelSelection:p.targetModel}));}
 const published=fingerprint(readRows(dst,p.newId));
 if(p.provenance){const now=Date.now();dst.prepare('insert into session_entry(id,session_id,type,time_created,time_updated,data) values(?,?,?,?,?,?)').run('entry_'+randomUUID(),p.newId,'integration/entrotect',now,now,JSON.stringify({...p.provenance,fingerprint:published}));}
 dst.exec('COMMIT');
 console.log(JSON.stringify({id:p.newId,messages:rows.message.length,parts:rows.part.length,fingerprint:published}));
}catch(e){try{dst.exec('ROLLBACK');}catch{}throw e;}finally{dst.close();}
}catch(e){process.stderr.write(e.message);process.exitCode=1;}});
`;

export function nativeSqlite<T = any>(node: string, request: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(node, ['--no-warnings', '-e', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('原生数据库操作超时')); }, 60_000);
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr || '原生数据库操作失败'));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('原生数据库结果无效')); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request));
  });
}
