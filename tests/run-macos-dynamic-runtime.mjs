import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

// Optional: TMC_OFFICIAL_APP=<unmodified official .app> also probes its real bundled pages.
const directory=await mkdtemp(join(tmpdir(),'tsim-macos-dynamic-test-'));
try{
  const outfile=join(directory,'macos-dynamic-runtime.test.mjs');
  await build({entryPoints:['tests/macos-dynamic-runtime.test.ts'],outfile,bundle:true,platform:'node',format:'esm',define:{__TMC_RUNTIME_PLATFORM__:'"darwin"',__TMC_MACOS_DYNAMIC__:'true'},logLevel:'warning'});
  const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--test',outfile],{stdio:'inherit'});child.once('error',reject);child.once('exit',resolve);});
  process.exitCode=code??1;
}finally{await rm(directory,{recursive:true,force:true});}
