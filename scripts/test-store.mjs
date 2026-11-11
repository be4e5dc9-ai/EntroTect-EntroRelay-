import {build} from 'esbuild';
import {spawn} from 'node:child_process';
await build({entryPoints:['tests/store-atomic.ts'],outfile:'.local/store-atomic.mjs',bundle:true,platform:'node',format:'esm',target:'node24'});
const child=spawn(process.execPath,['.local/store-atomic.mjs'],{stdio:'inherit',windowsHide:true});child.on('exit',code=>process.exit(code??1));
