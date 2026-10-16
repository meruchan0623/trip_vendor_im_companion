import {mkdir,cp,writeFile,chmod,readFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
if(process.platform!=='darwin')throw new Error('MACOS_REQUIRED');
const helper=resolve('release/mac-arm64/旅游商家助手.app');
const output=resolve(process.argv[2]||'release/TravelMerchantCompanion-0.3.2-persistent-login-update.pkg');
if(await access(output).then(()=>true,()=>false))throw new Error('OUTPUT_ALREADY_EXISTS');
const work=resolve('work/persistent-login-update'),scripts=join(work,'scripts'),payload=join(scripts,'payload');
await mkdir(payload,{recursive:true});
await cp(helper,join(payload,'旅游商家助手.app'),{recursive:true,verbatimSymlinks:true});
await build({entryPoints:['scripts/update-macos-companion.mjs'],bundle:true,platform:'node',target:'node24',format:'esm',outfile:join(payload,'update.mjs')});
const hook=`#!/bin/sh
set -eu
cd "$(/usr/bin/dirname "$0")"
if [ "\${3:-/}" != "/" ]; then echo '只支持当前启动磁盘。' >&2; exit 1; fi
exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/root LANG=en_US.UTF-8 ELECTRON_RUN_AS_NODE=1 ELECTRON_NO_ASAR=1 "./payload/旅游商家助手.app/Contents/MacOS/旅游商家助手" "./payload/update.mjs" --companion-app "./payload/旅游商家助手.app"
`;
await writeFile(join(scripts,'postinstall'),hook);await chmod(join(scripts,'postinstall'),0o755);
const run=(command,args)=>{console.log(JSON.stringify({command,args}));const r=spawnSync(command,args,{stdio:'inherit'});if(r.error||r.status!==0)throw new Error('UPDATE_PACKAGE_COMMAND_FAILED');};
run('/usr/bin/codesign',['--verify','--deep','--strict',helper]);
// Syntax-only validation does not execute the updater or touch the installed application.
run(process.execPath,['--check',join(payload,'update.mjs')]);
run('/usr/bin/pkgbuild',['--nopayload','--identifier','tech.tsim.travel-merchant-companion.session-update','--version','0.3.2','--scripts',scripts,output]);
const digest=createHash('sha256').update(await readFile(output)).digest('hex');
await writeFile(output+'.sha256',digest+'  '+output.split('/').pop()+'\n');
console.log(JSON.stringify({package:output,sha256:digest,requiresUserInstallerAuthorization:true}));
