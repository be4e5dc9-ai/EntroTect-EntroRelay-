import {build} from 'esbuild';
import {spawn} from 'node:child_process';
await build({entryPoints:['tests/history-native.ts'],outfile:'.local/history-native.mjs',bundle:true,platform:'node',format:'esm',target:'node24'});
const child=spawn(process.execPath,['.local/history-native.mjs'],{stdio:'inherit',windowsHide:true});
child.on('exit',code=>process.exit(code??1));
