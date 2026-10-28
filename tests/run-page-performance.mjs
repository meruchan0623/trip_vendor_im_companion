import {build} from 'esbuild';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const parent=resolve('work');await mkdir(parent,{recursive:true});
const directory=await mkdtemp(join(parent,'page-performance-'));
try{
  // Windows packaging sets win32; local macOS checks default to darwin. Exercise
  // the selected platform instead of silently testing only the macOS branch.
  const platform=process.env.TMC_RUNTIME_PLATFORM??'darwin';
  if(!['darwin','win32'].includes(platform))throw Error('UNSUPPORTED_TEST_PLATFORM');
  await build({entryPoints:['tests/page-performance.test.ts'],outfile:join(directory,'test.cjs'),bundle:true,platform:'node',format:'cjs',external:['jsdom','electron'],define:{__TMC_RUNTIME_PLATFORM__:JSON.stringify(platform)},logLevel:'warning'});
  process.exitCode=spawnSync(process.execPath,['--test',join(directory,'test.cjs')],{stdio:'inherit'}).status??1;
}finally{await rm(directory,{recursive:true,force:true});}
