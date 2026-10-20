import {build} from 'esbuild';
import {mkdir,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const directory='work/windows-order-tests';
await mkdir(directory,{recursive:true});
try{
  await build({entryPoints:['tests/windows-order.test.ts'],outfile:directory+'/test.cjs',bundle:true,platform:'node',format:'cjs',external:['jsdom'],define:{__TMC_RUNTIME_PLATFORM__:'"win32"'},logLevel:'warning'});
  process.exitCode=spawnSync(process.execPath,['--test',directory+'/test.cjs'],{stdio:'inherit'}).status??1;
}finally{await rm(directory,{recursive:true,force:true});}
