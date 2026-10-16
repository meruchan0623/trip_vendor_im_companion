#!/usr/bin/env node
import {build} from 'esbuild';
import {cp,mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {installMacosCompanion} from './install-macos-companion.mjs';

if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('APPLE_SILICON_BUILD_HOST_REQUIRED');
const options={};
for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i].startsWith('--')||!process.argv[i+1])throw new Error('EXPECTED_NAMED_ARGUMENT_VALUE');options[process.argv[i].slice(2)]=process.argv[i+1];}
if(!options['prepared-app'])throw new Error('Usage: --prepared-app <verified ARM app> [--out <new directory>]');
const prepared=resolve(options['prepared-app']),out=resolve(options.out||'release/trip_vendor_im_companion-mac-arm64');
if(await access(out).then(()=>true,()=>false))throw new Error('OUTPUT_ALREADY_EXISTS');
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const compiled=await build({entryPoints:['runtime/macho-fingerprint.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {fingerprintMacExecutable}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const manifest={executableSha256:await fingerprintMacExecutable(join(prepared,'Contents/MacOS/旅游商家桌面版')),asarSha256:await hash(join(prepared,'Contents/Resources/app.asar'))};
const {extractFile}=await import('@electron/asar');
const pkg=JSON.parse(extractFile(join(prepared,'Contents/Resources/app.asar'),'package.json').toString());
if(pkg.main!=='trip-vendor-bootstrap.cjs')throw new Error('PREPARED_APP_MISSING_RELAUNCH_BOOTSTRAP');
await mkdir('work/mac-integrated-build',{recursive:true});
const manifestPath=resolve('work/mac-integrated-build/manifest.json');await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
function run(command,args,env=process.env){
  console.log(JSON.stringify({command,args}));
  const result=spawnSync(command,args,{stdio:'inherit',env});if(result.error)throw result.error;if(result.status!==0)throw new Error(`COMMAND_FAILED ${command} ${result.status}`);
}
const env={...process.env,TMC_MACOS_MANIFEST:manifestPath};
run('npm',['run','build:native:mac'],env);run('npm',['run','build'],env);run('npx',['electron-builder','--mac','dir','--arm64'],env);
await mkdir(out,{recursive:true});
const target=join(out,'旅游商家桌面版.app');await cp(prepared,target,{recursive:true,verbatimSymlinks:true});
const transaction=await installMacosCompanion({targetApp:target,companionApp:resolve('release/mac-arm64/旅游商家助手.app'),backupRoot:resolve('work/mac-integrated-build/backups'),packagingOnly:true});
if(await fingerprintMacExecutable(join(target,'Contents/MacOS/旅游商家桌面版'))!==manifest.executableSha256||await hash(join(target,'Contents/Resources/app.asar'))!==manifest.asarSha256)throw new Error('PACKAGED_FINGERPRINT_DRIFT');
await writeFile(join(out,'安装说明.txt'),`旅游商家桌面版 · 内嵌助手（Apple 芯片）\n\n1. 退出原旅游商家桌面版及独立助手。先保存原程序包以便回退。\n2. 将本目录中的「旅游商家桌面版.app」放到 /Applications（应用程序），保留原名称。\n3. 以后只打开「旅游商家桌面版」，助手自动运行；首次使用须在自己的浏览器登录 TSim 客服系统。\n4. 本包为本地 ad-hoc 签名，未经 Apple 公证。如系统拦截，在系统设置 → 隐私与安全性中检查该应用并选择「仍要打开」。参见 https://support.apple.com/102445 。\n5. 不包含任何账号、登录状态或客户数据。每位用户的数据仍存于自己的用户目录。\n6. 厂商更新整包可能覆盖插件；新版本须重新核验和安装。\n7. 主程序与当前数据库、截图、图像处理路径已迁移 ARM；仍保留厂商未被当前启动路径引用的旧 Intel 私有组件，不承诺所有未来功能或 macOS 28 已完成验证。\n\n日志：~/Library/Logs/trip_vendor_im_companion/\n恢复：退出本程序后，将自己的原版备份放回 /Applications。\n`);
run('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',out,out+'.zip']);
await writeFile(out+'.sha256',`${await hash(out+'.zip')}  ${out.split('/').at(-1)}.zip\n`);
console.log(JSON.stringify({event:'integrated_package_complete',app:target,zip:out+'.zip',manifest,transaction:transaction.transactionPath},null,2));
