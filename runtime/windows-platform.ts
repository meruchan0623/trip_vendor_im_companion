import {spawn} from 'node:child_process';
import {windowsPowerShell} from './windows-powershell';
import {windowsProcessIdentityScript,windowsProcessScanScript} from './windows-process-identity';
import {createServer} from 'node:net';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fingerprintFile as hash} from './file-fingerprint';
import {win32} from 'node:path';
import {pathToFileURL} from 'node:url';
import {activateWindowsRuntimeBuild,windowsRuntimeBuild,WINDOWS_DYNAMIC_RUNTIME,WINDOWS_PAGE_BUILDS,WINDOWS_RUNTIME_BUILD} from './build-manifest';
import {WINDOWS_EXECUTABLE,windowsInstallationFromExecutable,windowsInstallationFromHelper,validateWindowsRuntimeManifest,validateWindowsPage,windowsRendererName,assertWindowsRendererContract,compareWindowsAres,type WindowsRuntimeManifest,type WindowsPageManifest}from'./windows-compatibility.mjs';
import {VERIFIED_RUNTIME_BUILD,assertBuildFingerprint,type ProcessIdentity} from './identity';
import{assertOwnedLoopbackListener,sameExecutablePath,type BuildFingerprint}from'./identity';
import{VerifiedFiles}from'./verified-files';
import{windowsTcpListenerScript}from'./windows-tcp-listeners';
import{windowsManifestAclScript}from'./windows-acl';
import type {LaunchPlatform,VerifiedIdleSnapshot} from './launcher';
const exe=WINDOWS_EXECUTABLE;
const CLIENT_IMAGE='旅游商家桌面版.exe';
function selectedWindowsInstallation(){return WINDOWS_DYNAMIC_RUNTIME?windowsInstallationFromHelper(process.execPath):windowsInstallationFromExecutable(WINDOWS_EXECUTABLE);}
/** Existing standalone builds retain their original fixed identities; only the installer enables dynamic compatibility. */
export function standaloneWindowsManifest():WindowsRuntimeManifest{return{schemaVersion:1,executable:exe,executableVersion:WINDOWS_RUNTIME_BUILD.executableVersion,executableSha256:WINDOWS_RUNTIME_BUILD.executableSha256,asarSha256:WINDOWS_RUNTIME_BUILD.asarSha256,chromiumMajor:WINDOWS_RUNTIME_BUILD.chromiumMajor,bundledPage:WINDOWS_PAGE_BUILDS[0]};}
export async function selectedWindowsRuntimeManifest(files?:VerifiedFiles):Promise<WindowsRuntimeManifest>{return WINDOWS_DYNAMIC_RUNTIME?loadWindowsRuntimeManifest(files):standaloneWindowsManifest();}
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function noRedirect(file:string){
  const normalized=win32.normalize(file);if(!/^[A-Za-z]:\\/.test(normalized)||normalized.startsWith('\\\\'))throw new Error('WINDOWS_RESOURCE_PATH_REJECTED');
  const parsed=win32.parse(normalized);let current=parsed.root;
  for(const segment of normalized.slice(parsed.root.length).split('\\')){current=win32.join(current,segment);if((await lstat(current)).isSymbolicLink())throw new Error('WINDOWS_RESOURCE_REDIRECTION');}
  if(win32.normalize(await realpath(normalized)).toLowerCase()!==normalized.toLowerCase())throw new Error('WINDOWS_RESOURCE_REDIRECTION');
}
async function stableRead(file:string,maxBytes:number,files?:VerifiedFiles):Promise<Buffer>{
  if(files)return files.verify(file,()=>stableRead(file,maxBytes));
  await noRedirect(file);const before=await lstat(file);
  if(!before.isFile()||before.size>maxBytes)throw new Error('WINDOWS_RESOURCE_SIZE_REJECTED');
  const bytes=await readFile(file),after=await lstat(file);
  if(!after.isFile()||after.isSymbolicLink()||bytes.length>maxBytes||before.size!==bytes.length||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.ino!==after.ino)throw new Error('WINDOWS_RESOURCE_CHANGED_DURING_READ');
  if(!Buffer.from(bytes.toString('utf8'),'utf8').equals(bytes))throw new Error('WINDOWS_RESOURCE_ENCODING_REJECTED');await noRedirect(file);return bytes;
}
/** Bind the manifest to this installed helper, allowing privileged or current-user private installations. */
export async function loadWindowsRuntimeManifest(files?:VerifiedFiles):Promise<WindowsRuntimeManifest>{
  const installation=windowsInstallationFromHelper(process.execPath),manifestPath=installation.manifest;
  await noRedirect(manifestPath);
  // A writable parent can replace the entire installation even when the root's
  // own ACL is private. Creating unrelated siblings remains harmless.
  const ancestors:string[]=[];for(let parent=win32.dirname(installation.root);;parent=win32.dirname(parent)){ancestors.push(parent);if(win32.dirname(parent)===parent)break;}
  const paths=[installation.root,installation.resources,installation.helperDirectory,manifestPath];
  if(files)return files.verifyMany(paths,()=>loadWindowsRuntimeManifest());
  const result=await powershell(windowsManifestAclScript(paths,ancestors)) as {protected?:unknown};
  if(result?.protected!==true)throw new Error('WINDOWS_MANIFEST_NOT_PROTECTED');
  try{return validateWindowsRuntimeManifest(JSON.parse((await stableRead(manifestPath,64000)).toString('utf8')),installation.executable);}catch(error){if(error instanceof Error&&/^(INVALID_|WINDOWS_)/.test(error.message))throw error;throw new Error('INVALID_WINDOWS_RUNTIME_MANIFEST');}
}
/** Reads only the two fixed HTML documents and their single relative module entrypoints. */
export async function probeWindowsPages(folder:string,packageVersion:string,files?:VerifiedFiles):Promise<WindowsPageManifest>{
  const versionFile=win32.join(folder,'packageVersion.json'),versionBytes=await stableRead(versionFile,16000,files);
  let version:{pkgVersion?:unknown;aresVersion?:unknown};try{version=JSON.parse(versionBytes.toString('utf8'));}catch{throw new Error('UNSUPPORTED_WINDOWS_PAGE_VERSION');}
  if(!version||version.pkgVersion!==packageVersion||typeof version.aresVersion!=='string')throw new Error('WINDOWS_PACKAGE_VERSION_MISMATCH');
  const [html,navHtml]=await Promise.all([stableRead(win32.join(folder,'src/pages/imPlus/index.html'),20000,files),stableRead(win32.join(folder,'src/pages/main/index.html'),20000,files)]);
  const rendererName=windowsRendererName(html.toString('utf8'),'imWindow'),navigationRendererName=windowsRendererName(navHtml.toString('utf8'),'mainWindow');
  const [renderer,navRenderer]=await Promise.all([stableRead(win32.join(folder,'js',rendererName),8_000_000,files),stableRead(win32.join(folder,'js',navigationRendererName),200_000,files)]);
  assertWindowsRendererContract(renderer.toString('utf8'),navRenderer.toString('utf8'));
  if(!(await stableRead(versionFile,16000,files)).equals(versionBytes))throw new Error('WINDOWS_RESOURCE_CHANGED_DURING_READ');
  return validateWindowsPage({packageVersion,aresVersion:version.aresVersion,rendererName,navigationRendererName,htmlSha256:digest(html),rendererSha256:digest(renderer),navigationHtmlSha256:digest(navHtml),navigationRendererSha256:digest(navRenderer)});
}
/** Mirrors vendor isUserPath, but probes unknown compatible resource names rather than trusting their version. */
export async function inspectWindowsPages(manifest:WindowsRuntimeManifest,appData=process.env.APPDATA,files?:VerifiedFiles){
  validateWindowsRuntimeManifest(manifest);
  const dist=windowsInstallationFromExecutable(manifest.executable).dist;
  const bundled=await probeWindowsPages(dist,manifest.bundledPage.packageVersion,files);
  if(Object.entries(manifest.bundledPage).some(([key,value])=>(bundled as unknown as Record<string,unknown>)[key]!==value))throw new Error('UNSUPPORTED_WINDOWS_BUNDLED_BUILD');
  if(!appData||!win32.isAbsolute(appData))throw new Error('WINDOWS_APPDATA_UNAVAILABLE');
  const userDist=win32.join(appData,'vbk-electron','dist');let page=bundled,selectedDist=dist;
  let user:{pkgVersion?:unknown;aresVersion?:unknown}|undefined;
  try{user=JSON.parse((await stableRead(win32.join(userDist,'packageVersion.json'),16000,files)).toString('utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(user){
    if(typeof user.aresVersion!=='string')throw new Error('UNSUPPORTED_WINDOWS_PAGE_VERSION');
    if(compareWindowsAres(bundled.aresVersion,user.aresVersion)<0){page=await probeWindowsPages(userDist,bundled.packageVersion,files);selectedDist=userDist;}
  }
  return{build:windowsRuntimeBuild(manifest,page,pathToFileURL(selectedDist+win32.sep).href),dist:selectedDist};
}
async function powershell(script:string):Promise<unknown>{
  try{return await windowsPowerShell.execute(script);}catch{throw new Error('PROCESS_INSPECTION_FAILED');}
}
/** The checker reads files/process metadata only. It never opens any original business bridge. */
export class WindowsLaunchPlatform implements LaunchPlatform {
  private get executable(){return selectedWindowsInstallation().executable;}
  private verifiedFiles?:VerifiedFiles;
  private verifiedFingerprint?:BuildFingerprint;
  async inspectReadOnly():Promise<VerifiedIdleSnapshot>{
    if(process.platform!=='win32')throw new Error('WINDOWS_REQUIRED');
    const exe=this.executable;
    const state=await powershell(`${windowsProcessScanScript(CLIENT_IMAGE)}
$clients=@(); $main=@(); $installers=@(); foreach($p in $all){ if($p.Name -eq '旅游商家桌面版.exe'){if(-not $p.ExecutablePath -or -not $p.LaunchPath -or -not $p.CommandLine){throw 'Client identity unavailable'}; if($p.ExecutablePath -ine '${exe.replaceAll("'","''")}' -or $p.LaunchPath -ine '${exe.replaceAll("'","''")}'){throw 'Unknown client image'}; $clients+=([int]$p.ProcessId); if($p.CommandLine -notmatch '--type='){$main+=([int]$p.ProcessId)}}; if($p.Name -match '^旅游商家桌面版.*win_.*\\.exe$' -or $p.ExecutablePath -match 'vbk-electron-updater[\\\\/]pending'){$installers+=([int]$p.ProcessId)}}; @{verified=$true; clientProcessIds=$clients;clientMainProcessIds=$main;installerProcessIds=$installers;version=(Get-Item -LiteralPath '${exe.replaceAll("'","''")}' -ErrorAction Stop).VersionInfo.FileVersion}|ConvertTo-Json -Compress`) as Record<string,unknown>;
    if(!state||state.verified!==true||typeof state.version!=='string'||!['clientProcessIds','clientMainProcessIds','installerProcessIds'].every(key=>Array.isArray(state[key])&&(state[key] as unknown[]).every(id=>Number.isSafeInteger(id)&&(id as number)>0)))throw new Error('PROCESS_INSPECTION_INVALID_STATE');
    const files=new VerifiedFiles(),manifest=await selectedWindowsRuntimeManifest(files);
    await Promise.all([noRedirect(exe),noRedirect(win32.join(win32.dirname(exe),'resources','app.asar'))]);
    const asar=win32.join(win32.dirname(exe),'resources','app.asar');
    const [{build},executableSha256,asarSha256]=await Promise.all([inspectWindowsPages(manifest,process.env.APPDATA,files),files.verify(exe,()=>hash(exe)),files.verify(asar,()=>hash(asar))]);
    if(!WINDOWS_DYNAMIC_RUNTIME&&!WINDOWS_PAGE_BUILDS.some(page=>page.packageVersion===build.packageVersion&&page.aresVersion===build.aresVersion&&page.rendererName===build.rendererName&&page.htmlSha256===build.htmlSha256&&page.rendererSha256===build.rendererSha256&&page.navigationHtmlSha256===build.navigationHtmlSha256&&page.navigationRendererSha256===build.navigationRendererSha256))throw new Error('UNSUPPORTED_WINDOWS_HOT_UPDATE');
    // Never activate new URLs until every resource and the executable/archive identity agree.
    if(state.version!==manifest.executableVersion||executableSha256!==manifest.executableSha256||asarSha256!==manifest.asarSha256)throw new Error('UNVERIFIED_BUILD');
    activateWindowsRuntimeBuild(build);
    const fingerprint={executable:exe,executableVersion:state.version,packageVersion:build.packageVersion,aresVersion:build.aresVersion,executableSha256,asarSha256,htmlSha256:build.htmlSha256,rendererSha256:build.rendererSha256};assertBuildFingerprint(fingerprint);
    await files.assertUnchanged();this.verifiedFiles=files;this.verifiedFingerprint=fingerprint;
    return{verified:true,fingerprint,clientProcessIds:state.clientProcessIds as number[],clientMainProcessIds:state.clientMainProcessIds as number[],installerProcessIds:state.installerProcessIds as number[]};
  }
  async reserveLoopbackPort(){
    const server=createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();if(!address||typeof address==='string'){server.close();throw new Error('PORT_RESERVATION_FAILED');}
    let released=false;return{address:'127.0.0.1' as const,port:address.port,release:async()=>{if(released)return;released=true;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
  }
  async spawnOriginal(executable:string,args:readonly string[],options:{shell:false;modifyEnvironment:false}):Promise<ProcessIdentity>{
    const exe=this.executable;
    if(executable!==exe||options.shell!==false||options.modifyEnvironment!==false||args.length!==1||!/^--remote-debugging-port=\d+$/.test(args[0]))throw new Error('UNAPPROVED_LAUNCH');
    // On Windows, non-detached libuv children belong to a kill-on-parent-exit Job.
    // unref alone is insufficient: the original GUI must outlive this helper.
    const child=spawn(executable,[...args],{shell:false,detached:true,windowsHide:false,stdio:'ignore'});
    await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    if(!child.pid)throw new Error('LAUNCH_FAILED');child.unref();
    const identity=await this.identity(child.pid);return identity;
  }
  async processIdentity(pid:number):Promise<ProcessIdentity>{return this.identity(pid);}
  /** Bootstrap uses port 0. Only a unique listener of its validated owner is a
   * candidate; no ports are scanned and no endpoint is contacted here. */
  async discoverDebugPort(pid:number):Promise<number>{
    const exe=this.executable,owner=await this.identity(pid);
    if(!sameExecutablePath(owner.executable,exe))throw new Error('UNVERIFIED_PROCESS');
    const result=await powershell(`${windowsTcpListenerScript(0,pid)}\n@{listeners=$listeners}|ConvertTo-Json -Compress -Depth 3`)as{listeners?:{pid:number;address:string;port:number}[]};
    if(!result||!Array.isArray(result.listeners)||result.listeners.length!==1)throw new Error('DEBUG_LISTENER_NOT_AVAILABLE');
    const listener=result.listeners[0];if(!Number.isSafeInteger(listener.port)||listener.port<1024||listener.port>65535)throw new Error('INVALID_DEBUG_PORT');
    assertOwnedLoopbackListener(owner,{...listener,processStartedAt:owner.startedAt},listener.port,exe);return listener.port;
  }
  /** Re-check ownership at every socket boundary, retaining the full verification's unchanged file snapshot. */
  async verifyHandshakeOwner(owner:ProcessIdentity,port:number,fingerprint:BuildFingerprint):Promise<void>{
    const exe=this.executable,files=this.verifiedFiles,verified=this.verifiedFingerprint;
    if(!files||!verified||Object.entries(verified).some(([key,value])=>(fingerprint as Record<string,unknown>)[key]!==value))throw new Error('VERIFIED_FILES_REQUIRED');
    assertBuildFingerprint(fingerprint);
    if(!Number.isSafeInteger(owner.pid)||owner.pid<=0||!Number.isSafeInteger(port)||port<1024||port>65535||!sameExecutablePath(owner.executable,exe))throw new Error('UNVERIFIED_PROCESS');
    await files.assertUnchanged();
    const result=await powershell(`${windowsTcpListenerScript(port)}
${windowsProcessScanScript(CLIENT_IMAGE)}
$main=@();foreach($item in $all){if($item.Name -eq '旅游商家桌面版.exe'){if(-not $item.ExecutablePath -or -not $item.LaunchPath -or -not $item.CommandLine -or $item.ExecutablePath -ine '${exe.replaceAll("'","''")}' -or $item.LaunchPath -ine '${exe.replaceAll("'","''")}'){throw 'Unknown client image'};if($item.CommandLine -notmatch '--type='){$main+=([int]$item.ProcessId)}};if($item.Name -match '^旅游商家桌面版.*win_.*\\.exe$' -or $item.ExecutablePath -match 'vbk-electron-updater[\\\\/]pending'){throw 'Updater active'}};if($main.Count -ne 1 -or $main[0] -ne ${owner.pid}){throw 'Main process changed'};
${windowsProcessIdentityScript(owner.pid)}
@{pid=$identity.pid;executable=$identity.executable;startedAt=$identity.startedAt;listeners=$listeners}|ConvertTo-Json -Compress -Depth 3`)as ProcessIdentity&{listeners?:{pid:number;address:string;port:number}[]};
    if(!result||result.pid!==owner.pid||result.startedAt!==owner.startedAt||typeof result.executable!=='string'||!sameExecutablePath(result.executable,owner.executable))throw new Error('PROCESS_CHANGED');
    if(!Array.isArray(result.listeners)||result.listeners.length!==1)throw new Error('UNOWNED_DEBUG_LISTENER');
    assertOwnedLoopbackListener(result,{...result.listeners[0],processStartedAt:result.startedAt},port);
    await Promise.all(files.paths.map(path=>noRedirect(path)));await files.assertUnchanged();
  }
  private async identity(pid:number):Promise<ProcessIdentity>{
    if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('INVALID_PID');
    const result=await powershell(`${windowsProcessIdentityScript(pid)}\n$identity|ConvertTo-Json -Compress`) as ProcessIdentity;
    if(!result||result.pid!==pid||typeof result.executable!=='string'||typeof result.startedAt!=='string'||!result.startedAt)throw new Error('PROCESS_IDENTITY_UNAVAILABLE');return result;
  }
  async waitForListener(owner:ProcessIdentity,port:number,timeoutMs:number){
    const exe=this.executable,deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      const identity=await this.identity(owner.pid);if(identity.startedAt!==owner.startedAt||identity.executable.toLowerCase()!==exe.toLowerCase())throw new Error('PROCESS_CHANGED');
      const result=await powershell(`${windowsTcpListenerScript(port)}\n@{listeners=$listeners}|ConvertTo-Json -Compress -Depth 3`) as {listeners?:unknown[]};
      if(!result||!Array.isArray(result.listeners))throw new Error('LISTENER_CHECK_UNAVAILABLE');
      if(result.listeners.length){if(result.listeners.length!==1)throw new Error('AMBIGUOUS_LISTENER');const listener=result.listeners[0] as {pid:number;address:string;port:number};return{...listener,processStartedAt:identity.startedAt};}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    throw new Error('DEBUG_LISTENER_NOT_AVAILABLE');
  }
}
