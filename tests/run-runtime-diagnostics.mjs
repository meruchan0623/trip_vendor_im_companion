import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const directory='work/runtime-diagnostics-tests';await mkdir(directory,{recursive:true});
await build({entryPoints:['tests/runtime-diagnostics.test.ts'],outfile:directory+'/test.cjs',bundle:true,platform:'node',format:'cjs',external:['jsdom'],define:{__TMC_RUNTIME_PLATFORM__:'"win32"'},logLevel:'warning'});
const result=spawnSync(process.execPath,['--test',directory+'/test.cjs'],{stdio:'inherit'});if(result.error)throw result.error;process.exitCode=result.status??1;
