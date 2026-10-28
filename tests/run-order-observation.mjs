import {build} from 'esbuild';
import {mkdir,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const directory='work/order-observation-tests';
await mkdir(directory,{recursive:true});
try{
  await build({entryPoints:['tests/order-observation.test.ts'],outfile:directory+'/test.cjs',bundle:true,platform:'node',format:'cjs',external:['jsdom'],logLevel:'warning'});
  process.exitCode=spawnSync(process.execPath,['--test',directory+'/test.cjs'],{stdio:'inherit'}).status??1;
}finally{await rm(directory,{recursive:true,force:true});}
