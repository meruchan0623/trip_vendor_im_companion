import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const directory='work/windows-panel-recovery-tests';
await mkdir(directory,{recursive:true});
await build({entryPoints:['tests/windows-panel-recovery.test.ts'],outfile:directory+'/test.cjs',bundle:true,platform:'node',format:'cjs',external:['jsdom'],define:{__TMC_RUNTIME_PLATFORM__:'"win32"'},logLevel:'warning'});
process.exitCode=spawnSync(process.execPath,['--test',directory+'/test.cjs'],{stdio:'inherit'}).status??1;
