import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
// Keep jsdom resolution in this checkout. This runner does not launch a real browser/client.
const directory=await mkdtemp(join(process.cwd(),'node_modules/.tsim-bootstrap-diagnostics-'));
try{
  const outfile=join(directory,'test.mjs');
  await build({entryPoints:['tests/windows-bootstrap-diagnostics.test.ts'],outfile,bundle:true,platform:'node',format:'esm',external:['jsdom'],logLevel:'warning'});
  process.exitCode=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--test',outfile],{stdio:'inherit'});child.once('error',reject);child.once('exit',code=>resolve(code??1));});
}finally{await rm(directory,{recursive:true,force:true});}
