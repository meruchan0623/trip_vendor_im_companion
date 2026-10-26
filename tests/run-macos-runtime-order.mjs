import {build} from 'esbuild';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
// Keep the external jsdom lookup inside this checkout; no browser or client is launched.
const parent=resolve('work');await mkdir(parent,{recursive:true});
const directory=await mkdtemp(join(parent,'macos-runtime-order-'));
try{
  await build({entryPoints:['tests/macos-runtime-order.test.ts'],outfile:join(directory,'test.cjs'),bundle:true,platform:'node',format:'cjs',external:['jsdom','electron'],define:{__TMC_RUNTIME_PLATFORM__:'"darwin"'},logLevel:'warning'});
  process.exitCode=spawnSync(process.execPath,['--test',join(directory,'test.cjs')],{stdio:'inherit'}).status??1;
}finally{await rm(directory,{recursive:true,force:true});}
