import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { atomicJson } from '../backend/store';

const root=path.resolve('.local',`atomic-store-${Date.now()}`);await mkdir(root,{recursive:true});
const file=path.join(root,'index.json');await atomicJson(file,{before:true});
async function lockFile(){
 const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$handle=[System.IO.File]::Open($env:ENTROTECT_TEST_INDEX,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite); [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null; $handle.Dispose()"],{env:{...process.env,ENTROTECT_TEST_INDEX:file},windowsHide:true,stdio:['pipe','pipe','pipe']});
 let diagnostic='';child.stderr.on('data',data=>diagnostic+=data);
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('文件锁启动超时')),10_000);child.stdout.on('data',data=>{if(String(data).includes('LOCKED')){clearTimeout(timer);resolve();}});child.once('exit',code=>{if(code){clearTimeout(timer);reject(Error(diagnostic));}});child.once('error',reject);});
 const finished=new Promise<void>(r=>child.once('exit',()=>r()));return {release(){child.stdin.end('release\n');},finished};
}
const lock=await lockFile();
try{
 const probe=path.join(root,'probe.json');await writeFile(probe,'probe');
 await assert.rejects(()=>rename(probe,file),(e:any)=>['EPERM','EACCES','EBUSY'].includes(e.code));
 const timer=setTimeout(()=>lock.release(),180);
 try{await atomicJson(file,{after:true});}finally{clearTimeout(timer);}
 assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{after:true});
}finally{lock.release();await lock.finished;}
// A concurrent vendor update during the retry must not be overwritten.
const conflict=await lockFile();
try{
 const before=await readFile(file,'utf8'),timer=setTimeout(()=>{void writeFile(file,JSON.stringify({vendorUpdate:true})).then(()=>conflict.release());},90);
 try{await assert.rejects(()=>atomicJson(file,{stale:true},before),/被其他程序更新/);}finally{clearTimeout(timer);}
 assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{vendorUpdate:true});
}finally{conflict.release();await conflict.finished;}
assert(!(await readdir(root)).some(name=>name.endsWith('.tmp')));
console.log('WINDOWS_ATOMIC_RETRY_AND_CONFLICT_OK');
