import {readdir,readFile,mkdir,cp,writeFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export async function collectNotices(destination){
 await mkdir(destination,{recursive:true});const index=[],seen=new Set();
 async function collect(directory,label,license){
  const real=await realpath(directory).catch(()=>null);if(!real||seen.has(real))return;seen.add(real);
  const files=(await readdir(real)).filter(name=>/^(licen[sc]e|notice|copying|copyright)(?:[._-]|$)/i.test(name));
  if(!files.length)return;const folder=path.join(destination,label.replace(/[^a-zA-Z0-9_.-]/g,'_'));await mkdir(folder,{recursive:true});
  for(const file of files)await cp(path.join(real,file),path.join(folder,file),{recursive:true,force:true});
  index.push(`${label} — ${license||'see included files'}`);
 }
 for(const entry of await readdir('node_modules/.pnpm',{withFileTypes:true})){
  if(!entry.isDirectory())continue;const modules=path.join('node_modules/.pnpm',entry.name,'node_modules');
  for(const module of await readdir(modules).catch(()=>[])){
   const candidates=module.startsWith('@')?(await readdir(path.join(modules,module))).map(name=>path.join(modules,module,name)):[path.join(modules,module)];
   for(const candidate of candidates){const pkg=await readFile(path.join(candidate,'package.json'),'utf8').then(JSON.parse).catch(()=>null);if(pkg)await collect(candidate,`npm-${pkg.name}-${pkg.version}`,pkg.license);}
  }
 }
 const lock=await readFile('src-tauri/Cargo.lock','utf8'),registry=path.join(process.env.CARGO_HOME||path.join(os.homedir(),'.cargo'),'registry','src');
 const registries=await readdir(registry).catch(()=>[]);
 for(const match of lock.matchAll(/name = "([^"]+)"\r?\nversion = "([^"]+)"/g))for(const source of registries)await collect(path.join(registry,source,`${match[1]}-${match[2]}`),`rust-${match[1]}-${match[2]}`);
 await writeFile(path.join(destination,'INDEX.txt'),index.sort().join('\n')+'\n');console.log(`Included notices from ${index.length} dependencies`);
}
