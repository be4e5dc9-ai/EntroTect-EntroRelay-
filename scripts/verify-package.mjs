import {readFile,access,stat,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync,spawn} from 'node:child_process';
import path from 'node:path';
import { cargoTarget } from './cargo-target.mjs';
import {stageRoot,archiveName,version} from './release-info.mjs';
const root=stageRoot;
async function digest(stream){
 const hash=createHash('sha256');
 for await(const chunk of stream)hash.update(chunk);
 return hash.digest('hex');
}
for(const [file,source] of [['EntroTect.exe',path.join(cargoTarget,'release','entrotect.exe')],['backend/worker.cjs','dist-backend/worker.cjs']]){
 if(!(await readFile(path.join(root,file))).equals(await readFile(source)))throw new Error(`Stale packaged file: ${file}`);
}
for(const file of ['node/node.exe','dsh/node_modules/@deepseek-ai/dsh/lib/bin.js','zcode/resources/glm/zcode.cjs'])await access(path.join(root,'runtimes',file));
const name=archiveName,archive=path.resolve('release',name);
const sevenZip=createRequire(import.meta.url)('7zip-bin').path7za;
const oldRuntime=execFileSync(sevenZip,['l','-ba',archive,'runtimes/bridge/*'],{encoding:'utf8',windowsHide:true});
if(oldRuntime.trim())throw new Error('The ZIP contains an obsolete context converter');
const codexRuntime='runtimes/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc';
for(const file of ['EntroTect.exe','backend/worker.cjs','README.md','README.en.md','CHANGELOG.md','CHANGELOG.en.md','docs/reasoning-capabilities.md','runtimes/versions.json',
 'runtimes/kimi/node_modules/@moonshot-ai/kimi-code/dist/main.mjs','runtimes/kimi/node_modules/@moonshot-ai/kimi-code/LICENSE',
 'runtimes/opencode/node_modules/opencode-windows-x64/bin/opencode.exe','runtimes/opencode/LICENSE',
 `${codexRuntime}/bin/codex.exe`,`${codexRuntime}/bin/codex-code-mode-host.exe`,`${codexRuntime}/codex-path/rg.exe`,
 `${codexRuntime}/codex-resources/codex-windows-sandbox-setup.exe`,`${codexRuntime}/codex-resources/codex-command-runner.exe`,
 'runtimes/codex/LICENSE','runtimes/codex/NOTICE']){
 const child=spawn(sevenZip,['e','-so',archive,file],{windowsHide:true,stdio:['ignore','pipe','inherit']});
 const exited=new Promise((resolve,reject)=>{
  child.once('error',reject);
  child.once('close',code=>code===0?resolve():reject(new Error(`Cannot extract ZIP entry: ${file}`)));
 });
 const [actual,expected]=await Promise.all([digest(child.stdout),digest(createReadStream(path.join(root,file))),exited]);
 if(actual!==expected)throw new Error(`Stale ZIP entry: ${file}`);
}
const sha256=await digest(createReadStream(archive));await writeFile(`release/SHA256SUMS-${version}.txt`,`${sha256}  ${name}\n`);
const {size}=await stat(archive);
console.log(JSON.stringify({exe:path.join(root,'EntroTect.exe'),zip:name,sizeMB:Math.round(size/1024/1024),sha256},null,2));
