import {build} from 'esbuild';
import {mkdir,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
// Inside the repository so the external jsdom resolves from node_modules.
const directory='work/order-summary-tests';
await mkdir(directory,{recursive:true});
try{
  await build({entryPoints:['tests/order-summary.test.ts'],outfile:directory+'/test.cjs',bundle:true,platform:'node',format:'cjs',external:['jsdom','electron'],define:{__TMC_RUNTIME_PLATFORM__:'"win32"'},logLevel:'warning'});
  process.exitCode=spawnSync(process.execPath,['--test',directory+'/test.cjs'],{stdio:'inherit'}).status??1;
}finally{await rm(directory,{recursive:true,force:true});}
