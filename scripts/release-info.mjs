import {readFile} from 'node:fs/promises';
import path from 'node:path';
export const version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
export const stageRoot=path.resolve(`release/tauri-${version}-win-x64`);
export const archiveName=`EntroTect-${version}-tauri-win-x64.zip`;
