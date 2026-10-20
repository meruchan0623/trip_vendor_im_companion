import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

const directory=await mkdtemp(join(tmpdir(),'tsim-owned-session-test-'));
try{
  const outfile=join(directory,'macos-owned-session.test.mjs');
  await build({entryPoints:['tests/macos-owned-session.test.ts'],outfile,bundle:true,platform:'node',format:'esm',external:['electron'],logLevel:'warning'});
  const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--test',outfile],{stdio:'inherit'});child.once('error',reject);child.once('exit',resolve);});
  process.exitCode=code??1;
}finally{await rm(directory,{recursive:true,force:true});}
