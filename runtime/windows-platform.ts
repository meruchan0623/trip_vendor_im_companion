import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {readFile} from 'node:fs/promises';
import {fingerprintFile as hash} from './file-fingerprint';
import {win32} from 'node:path';
import {VERIFIED_RUNTIME_BUILD,assertBuildFingerprint,type ProcessIdentity} from './identity';
import type {LaunchPlatform,VerifiedIdleSnapshot} from './launcher';
const execute=promisify(execFile);
const exe=VERIFIED_RUNTIME_BUILD.executable;
const dist=win32.join(win32.dirname(exe),'resources','app.asar.unpacked','dist');
async function powershell(script:string):Promise<unknown>{
  const encoded=Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); ${script}`,'utf16le').toString('base64');
  const {stdout,stderr}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,timeout:15000,maxBuffer:256000});
  if(stderr.trim())throw new Error('PROCESS_INSPECTION_FAILED');
  try{return JSON.parse(stdout.trim());}catch{throw new Error('PROCESS_INSPECTION_INVALID_JSON');}
}
/** The checker reads files/process metadata only. It never opens any original business bridge. */
export class WindowsLaunchPlatform implements LaunchPlatform {
  async inspectReadOnly():Promise<VerifiedIdleSnapshot>{
    if(process.platform!=='win32')throw new Error('WINDOWS_REQUIRED');
    const state=await powershell(`$all=@(Get-CimInstance Win32_Process -ErrorAction Stop); $clients=@(); $main=@(); $installers=@(); foreach($p in $all){ if($p.Name -eq '旅游商家桌面版.exe'){if(-not $p.ExecutablePath -or -not $p.CommandLine){throw 'Client identity unavailable'}; if($p.ExecutablePath -ine '${exe.replaceAll("'","''")}'){throw 'Unknown client image'}; $clients+=([int]$p.ProcessId); if($p.CommandLine -notmatch '--type='){$main+=([int]$p.ProcessId)}}; if($p.Name -match '^旅游商家桌面版.*win_.*\\.exe$' -or $p.ExecutablePath -match 'vbk-electron-updater[\\\\/]pending'){$installers+=([int]$p.ProcessId)}}; @{verified=$true; clientProcessIds=$clients;clientMainProcessIds=$main;installerProcessIds=$installers;version=(Get-Item -LiteralPath '${exe.replaceAll("'","''")}' -ErrorAction Stop).VersionInfo.FileVersion}|ConvertTo-Json -Compress`) as Record<string,unknown>;
    if(!state||state.verified!==true||typeof state.version!=='string'||!['clientProcessIds','clientMainProcessIds','installerProcessIds'].every(key=>Array.isArray(state[key])&&(state[key] as unknown[]).every(id=>Number.isSafeInteger(id)&&(id as number)>0)))throw new Error('PROCESS_INSPECTION_INVALID_STATE');
    const version=JSON.parse(await readFile(win32.join(dist,'packageVersion.json'),'utf8')) as {pkgVersion?:string;aresVersion?:string};
    const [executableSha256,asarSha256,htmlSha256,rendererSha256]=await Promise.all([hash(exe),hash(win32.join(win32.dirname(exe),'resources','app.asar')),hash(win32.join(dist,'src','pages','imPlus','index.html')),hash(win32.join(dist,'js',VERIFIED_RUNTIME_BUILD.rendererName))]);
    const fingerprint={executable:exe,executableVersion:state.version,packageVersion:version.pkgVersion??'',aresVersion:version.aresVersion??'',executableSha256,asarSha256,htmlSha256,rendererSha256};assertBuildFingerprint(fingerprint);
    return{verified:true,fingerprint,clientProcessIds:state.clientProcessIds as number[],clientMainProcessIds:state.clientMainProcessIds as number[],installerProcessIds:state.installerProcessIds as number[]};
  }
  async reserveLoopbackPort(){
    const server=createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();if(!address||typeof address==='string'){server.close();throw new Error('PORT_RESERVATION_FAILED');}
    let released=false;return{address:'127.0.0.1' as const,port:address.port,release:async()=>{if(released)return;released=true;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
  }
  async spawnOriginal(executable:string,args:readonly string[],options:{shell:false;modifyEnvironment:false}):Promise<ProcessIdentity>{
    if(executable!==exe||options.shell!==false||options.modifyEnvironment!==false||args.length!==1||!/^--remote-debugging-port=\d+$/.test(args[0]))throw new Error('UNAPPROVED_LAUNCH');
    // On Windows, non-detached libuv children belong to a kill-on-parent-exit Job.
    // unref alone is insufficient: the original GUI must outlive this helper.
    const child=spawn(executable,[...args],{shell:false,detached:true,windowsHide:false,stdio:'ignore'});
    await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    if(!child.pid)throw new Error('LAUNCH_FAILED');child.unref();
    const identity=await this.identity(child.pid);return identity;
  }
  async processIdentity(pid:number):Promise<ProcessIdentity>{return this.identity(pid);}
  private async identity(pid:number):Promise<ProcessIdentity>{
    if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('INVALID_PID');
    const result=await powershell(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop;if(-not $p -or -not $p.ExecutablePath -or -not $p.CreationDate){throw 'Missing process'};@{pid=[int]$p.ProcessId;executable=$p.ExecutablePath;startedAt=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`) as ProcessIdentity;
    if(!result||result.pid!==pid||typeof result.executable!=='string'||typeof result.startedAt!=='string'||!result.startedAt)throw new Error('PROCESS_IDENTITY_UNAVAILABLE');return result;
  }
  async waitForListener(owner:ProcessIdentity,port:number,timeoutMs:number){
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      const identity=await this.identity(owner.pid);if(identity.startedAt!==owner.startedAt||identity.executable.toLowerCase()!==exe.toLowerCase())throw new Error('PROCESS_CHANGED');
      const result=await powershell(`$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object {$_.LocalPort -eq ${port}});@{listeners=@($listeners|ForEach-Object {@{pid=[int]$_.OwningProcess;address=$_.LocalAddress;port=[int]$_.LocalPort}})}|ConvertTo-Json -Compress -Depth 3`) as {listeners?:unknown[]};
      if(!result||!Array.isArray(result.listeners))throw new Error('LISTENER_CHECK_UNAVAILABLE');
      if(result.listeners.length){if(result.listeners.length!==1)throw new Error('AMBIGUOUS_LISTENER');const listener=result.listeners[0] as {pid:number;address:string;port:number};return{...listener,processStartedAt:identity.startedAt};}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    throw new Error('DEBUG_LISTENER_NOT_AVAILABLE');
  }
}
