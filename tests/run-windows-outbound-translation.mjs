import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
const directory=await mkdtemp(join(tmpdir(),'tsim-windows-outbound-'));
try{
  const outfile=join(directory,'test.mjs');
  await build({entryPoints:['tests/windows-outbound-translation.test.ts'],outfile,bundle:true,platform:'node',format:'esm',external:['electron'],define:{__TMC_RUNTIME_PLATFORM__:'"win32"'},logLevel:'warning'});
  process.exitCode=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--test',outfile],{stdio:'inherit'});child.once('error',reject);child.once('exit',code=>resolve(code??1));});
}finally{await rm(directory,{recursive:true,force:true});}
