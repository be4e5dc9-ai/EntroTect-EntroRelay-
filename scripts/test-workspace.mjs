import {build} from 'esbuild';
import {spawn} from 'node:child_process';
await build({entryPoints:['tests/workspace-service.ts'],outfile:'.local/workspace-service.mjs',bundle:true,platform:'node',format:'esm',target:'node24'});
const child=spawn(process.execPath,['.local/workspace-service.mjs'],{stdio:'inherit',windowsHide:true});child.on('exit',code=>process.exitCode=code??1);
