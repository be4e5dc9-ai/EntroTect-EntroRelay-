import { build } from 'esbuild';
await build({entryPoints:['backend/worker.ts'],outfile:'dist-backend/worker.cjs',bundle:true,platform:'node',format:'cjs',target:'node24'});
