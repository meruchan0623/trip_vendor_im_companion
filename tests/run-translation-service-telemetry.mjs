import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const directory=await mkdtemp(join(tmpdir(),'tsim-service-telemetry-'));
try{const outfile=join(directory,'test.cjs');await build({entryPoints:['tests/translation-service-telemetry.test.ts'],outfile,bundle:true,platform:'node',format:'cjs',define:{__TMC_RUNTIME_PLATFORM__:'"darwin"'},logLevel:'warning'});const result=spawnSync(process.execPath,['--test',outfile],{stdio:'inherit'});if(result.error)throw result.error;process.exitCode=result.status??1;}finally{await rm(directory,{recursive:true,force:true});}
