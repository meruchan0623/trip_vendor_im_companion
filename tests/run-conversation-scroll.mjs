import {build} from 'esbuild';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const parent=resolve('work');await mkdir(parent,{recursive:true});
const directory=await mkdtemp(join(parent,'conversation-scroll-'));
try{
  const platform=process.env.TMC_RUNTIME_PLATFORM??'win32';
  if(!['darwin','win32'].includes(platform))throw Error('UNSUPPORTED_TEST_PLATFORM');
  await build({entryPoints:['tests/conversation-scroll.test.ts'],outfile:join(directory,'test.cjs'),bundle:true,platform:'node',format:'cjs',external:['jsdom','electron'],define:{__TMC_RUNTIME_PLATFORM__:JSON.stringify(platform)},logLevel:'warning'});
  process.exitCode=spawnSync(process.execPath,['--test',join(directory,'test.cjs')],{stdio:'inherit'}).status??1;
}finally{await rm(directory,{recursive:true,force:true});}
