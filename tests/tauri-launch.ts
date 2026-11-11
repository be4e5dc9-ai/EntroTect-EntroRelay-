import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {atomicJson} from '../backend/store';
import {agentHarnesses,harnesses} from '../shared/types';
export async function launchTauri(env:NodeJS.ProcessEnv){
 // Every UI test uses its own data profile. Only synchronization tests opt in
 // to automatic discovery; other suites must not ingest the user's histories.
 if(env.ENTROTECT_DATA_DIR){
  const file=path.join(env.ENTROTECT_DATA_DIR,'settings.json');const saved=JSON.parse(await readFile(file,'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;return '{}';}));
  const native=path.join(env.ENTROTECT_DATA_DIR,'native-test-home');
  await atomicJson(file,{...saved,
   ...(env.ENTROTECT_TEST_SYSTEM_LANGUAGE==='1'?{}:{language:saved.language??'zh-CN'}),
   deepseek:{home:path.join(native,'deepseek'),...saved.deepseek},zcode:{home:path.join(native,'zcode'),...saved.zcode},
   agents:Object.fromEntries(agentHarnesses.map(harness=>[harness,{home:path.join(native,harness),...saved.agents?.[harness]}])),
   ...(env.ENTROTECT_TEST_SYNC==='1'?{}:{history:{...saved.history,autoImport:false,autoExport:false}}),
   ...(env.ENTROTECT_TEST_UPDATES==='1'?{}:{harnessUpdates:Object.fromEntries(harnesses.map(harness=>[harness,false]))})});
 }
 const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;await new Promise<void>(r=>server.close(()=>r()));
 const target=JSON.parse(execFileSync('cargo',['metadata','--manifest-path','src-tauri/Cargo.toml','--no-deps','--format-version','1'],{encoding:'utf8',windowsHide:true})).target_directory;
 const child=spawn(process.env.ENTROTECT_TEST_EXE||path.join(target,'release','entrotect.exe'),[],{env:{...env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},windowsHide:false,stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',data=>errors+=data);const exited=new Promise<void>(r=>child.once('exit',()=>r()));
 const origin=`http://127.0.0.1:${port}`;
 let ready=false;for(let i=0;i<200;i++){if(child.exitCode!==null)throw new Error(`Tauri exited ${child.exitCode}: ${errors}`);try{if((await fetch(origin+'/json/version')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 if(!ready){child.kill();throw new Error(`WebView2 debugging did not start: ${errors}`);}
 const browser=await chromium.connectOverCDP(origin);const context=browser.contexts()[0];let page=context.pages()[0];if(!page)page=await context.waitForEvent('page');
 await page.waitForFunction(()=>!!window.entrotect);
 return {pid:child.pid!,firstWindow:async()=>page,close:async()=>{try{await page.getByTitle(/^(关闭窗口|Close window)$/).click({timeout:5000});}catch{}await Promise.race([exited,new Promise(r=>setTimeout(r,15000))]);if(child.exitCode===null)child.kill();await browser.close().catch(()=>{});}};
}
