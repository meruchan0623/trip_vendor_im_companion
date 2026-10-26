#!/usr/bin/env node
import {readFile,writeFile,mkdir,readdir,copyFile,rm,access} from 'node:fs/promises';
import {join,resolve,relative,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {sha256} from './lib/mac-pkg-asar.mjs';
import {copyWindowsHelperPayload,WINDOWS_PAYLOAD_ZIP_OPTIONS} from './lib/windows-payload-profile.mjs';
import {compressWindowsPayload} from './lib/windows-payload-archive.mjs';
const require=createRequire(import.meta.url);
const installerVersion='0.5.35';
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('WINDOWS_X64_BUILD_HOST_REQUIRED');
const work=resolve('work/windows-inject');
await mkdir(work,{recursive:true});
function run(command,args,env=process.env){
  console.log(JSON.stringify({command,args}));
  const result=spawnSync(command,args,{stdio:'inherit',env});
  if(result.error)throw result.error;if(result.status!==0)throw new Error(`COMMAND_FAILED ${command} ${result.status}`);
}
const localSdk=resolve('work/tools/dotnet/dotnet.exe');
const sdk=await access(localSdk).then(()=>localSdk,()=>process.env.TMC_DOTNET||'dotnet');
const buildEnv={...process.env,TMC_RUNTIME_PLATFORM:'win32',TMC_WINDOWS_DYNAMIC:'1'};delete buildEnv.TMC_WINDOWS_MANIFEST;
run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','native/windows/build.ps1','-Dotnet',sdk],buildEnv);
run(process.execPath,['node_modules/typescript/bin/tsc','--noEmit'],buildEnv);
for(const suite of ['windows-owner-recovery','windows-lifecycle','windows-panel-recovery','windows-order','windows-outbound-translation','native-adapter-ready'])run(process.execPath,[`tests/run-${suite}.mjs`],buildEnv);
run(sdk,['build','tests/native-target-binding/NativeTargetBindingTests.csproj','-c','Release'],buildEnv);
run(resolve('tests/native-target-binding/bin/Release/net10.0-windows/NativeTargetBindingTests.exe'),[String(process.pid)],{...buildEnv,DOTNET_ROOT:dirname(sdk)});
// The in-page order window logic (session handoff, warm-frame reuse) is shared with macOS; gate the payload on it.
run(process.execPath,['tests/run-operator-overlay.mjs'],buildEnv);
run(process.execPath,['node_modules/vite/bin/vite.js','build'],buildEnv);
run(process.execPath,['scripts/build-electron.mjs'],buildEnv);
if(!await access('node_modules/electron/dist/electron.exe').then(()=>true,()=>false))run(process.execPath,['node_modules/electron/install.js'],buildEnv);
run(process.execPath,['node_modules/electron-builder/cli.js','--win','dir','--x64','-c.directories.output=work/windows-inject/electron'],buildEnv);
const helper=join(work,'electron/win-unpacked'),payload=join(work,'payload');
await rm(payload,{recursive:true,force:true});await mkdir(payload,{recursive:true});
// Keep electron-builder output intact for inspection; optimize only this copy.
const payloadProfile=await copyWindowsHelperPayload(helper,join(payload,'helper'));
await writeFile(join(work,'payload-profile.json'),JSON.stringify(payloadProfile,null,2));
console.log(JSON.stringify({event:'windows_payload_optimized',sourceBytes:payloadProfile.sourceBytes,payloadBytes:payloadProfile.payloadBytes,savedBytes:payloadProfile.savedBytes,excludedFiles:payloadProfile.excluded.length,locales:payloadProfile.locales}));
await copyFile('scripts/lib/windows-vendor-bootstrap.cjs',join(payload,'windows-vendor-bootstrap.cjs'));
const payloadFiles={};
async function hashTree(folder){for(const item of await readdir(folder,{withFileTypes:true})){const file=join(folder,item.name);if(item.isDirectory())await hashTree(file);else payloadFiles[relative(join(payload,'helper'),file).replaceAll('\\','/')]=sha256(await readFile(file));}}
await hashTree(join(payload,'helper'));
const manifest={kind:'trip-vendor-windows-injection-v1',version:installerVersion,executable:'旅游商家桌面版.exe',executableVersion:'',executableSha256:'',originalAsarSha256:'',patchedAsarSha256:'',vendorFiles:{},payloadFiles,dynamic:true,bootstrapSha256:sha256(await readFile('scripts/lib/windows-vendor-bootstrap.cjs'))};
await writeFile(join(payload,'manifest.json'),JSON.stringify(manifest,null,2));
const zip=join(work,'payload.zip');await rm(zip,{force:true});
run(join(dirname(require.resolve('electron-winstaller/package.json')),'vendor/7z.exe'),['a',...WINDOWS_PAYLOAD_ZIP_OPTIONS,'-mcu',zip,join(payload,'*')]);
const compressed=join(work,'payload.zip.br'),archiveMetadata=join(work,'payload-archive.json');
await rm(compressed,{force:true});await rm(archiveMetadata,{force:true});
const payloadArchive=await compressWindowsPayload(zip,compressed,archiveMetadata);
console.log(JSON.stringify({event:'windows_payload_brotli_compressed',...payloadArchive}));
run(sdk,['publish','native/installer/Installer.csproj','-c','Release','-r','win-x64','--self-contained','true',`-p:Version=${installerVersion}`,'-o',join(work,'installer')]);
await mkdir('release',{recursive:true});
const output=resolve(`release/旅游商家助手-${installerVersion}-Windows资源注入安装.exe`);
await copyFile(join(work,'installer/TripVendorCompanion-Setup.exe'),output);
await writeFile(output+'.sha256',sha256(await readFile(output))+'  '+output.split(/[\\/]/).at(-1)+'\n');
await writeFile(join(work,'build-report.json'),JSON.stringify({output,sha256:sha256(await readFile(output)),minimumClientVersion:'1.2.11',payloadProfile,payloadArchive,manifest},null,2));
console.log(JSON.stringify({event:'windows_injection_installer_built',output,sha256:sha256(await readFile(output)),minimumClientVersion:'1.2.11'}));
