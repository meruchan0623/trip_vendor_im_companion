import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WindowsLaunchPlatform } from '../runtime/windows-platform';
import { reattachExplicitDevInstance, launchFromExplicitUserAction } from '../runtime/launcher';
import { connectOwnedLoopback } from '../runtime/transport';
import { LiveRuntimeDriver } from '../runtime/driver';
import type { NativeInteraction, NativePoll } from '../runtime/native-composer';
import type { PanelState, VerifiedComposerSnapshot } from '../src/shared/workbench';
declare const __NATIVE_ARTIFACT_SOURCE__:string;
declare const __NATIVE_ARTIFACT_SHA256__:string;
declare const __RUNTIME_ARTIFACT_SOURCE__:string;
declare const __RUNTIME_ARTIFACT_SHA256__:string;
const execute=promisify(execFile);
export interface ExternalComposer {
  targetInstanceId:string;
  onInteraction?(listener:(event:NativeInteraction)=>void):()=>void;
  onInvalidated?(listener:()=>void):()=>void;
  setInteractionOptions?(options:{shortcutEnabled:boolean}):Promise<void>;
  mountWorkbench?(state:PanelState,onAction:(action:string,args:unknown[])=>Promise<void>):Promise<void>;
  updateWorkbench?(state:PanelState):Promise<void>;
  read(authGeneration:number):Promise<NativePoll>;
  renew():Promise<void>;
  replace(expected:VerifiedComposerSnapshot,text:string,authorize:()=>void|(()=>void)|Promise<void|(()=>void)>):Promise<void>;
  close():Promise<void>;
}
/** Attaches to an already running, fingerprinted client and mounts only owned page UI. */
export async function connectExternalComposer(targetInstanceId:string):Promise<ExternalComposer> {
  if(process.platform!=='win32'||!/^\d+:\d+:\d+$/.test(targetInstanceId))throw new Error('INVALID_TARGET');
  const pid=Number(targetInstanceId.split(':')[0]);
  const script=`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if(-not $p -or $p.CommandLine -match '--type=' -or $p.CommandLine -notmatch '--remote-debugging-port=(\\d+)'){throw 'DEBUG_PORT_REQUIRED'}; @{port=[int]$Matches[1]}|ConvertTo-Json -Compress`;
  let port:number;
  try { const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:16000});port=JSON.parse(stdout.trim()).port; }
  catch {throw new Error('EXISTING_CLIENT_DEBUG_PORT_REQUIRED');}
  const platform=new WindowsLaunchPlatform();
  const verified=await reattachExplicitDevInstance(platform,pid,port);
  const verify=async()=>{const process=await platform.processIdentity(pid);if(process.startedAt!==verified.process.startedAt)throw new Error('PROCESS_CHANGED');await reattachExplicitDevInstance(platform,pid,port);};
  const transport=await connectOwnedLoopback(port,verify);
  let driver:LiveRuntimeDriver|undefined;
  try {
    if(typeof __RUNTIME_ARTIFACT_SOURCE__==='undefined'||typeof __RUNTIME_ARTIFACT_SHA256__==='undefined')throw new Error('RUNTIME_ARTIFACT_NOT_BUILT');
    driver=await LiveRuntimeDriver.discover(transport,verified.fingerprint,__RUNTIME_ARTIFACT_SOURCE__,__RUNTIME_ARTIFACT_SHA256__,8000);
    await driver.verifyCurrentTarget(driver.target);
    if(typeof __NATIVE_ARTIFACT_SOURCE__==='undefined'||typeof __NATIVE_ARTIFACT_SHA256__==='undefined')throw new Error('EDITOR_ARTIFACT_NOT_BUILT');
    const portAdapter=await driver.externalComposer(__NATIVE_ARTIFACT_SOURCE__,__NATIVE_ARTIFACT_SHA256__);
    const owned=driver;
    let ui:Awaited<ReturnType<LiveRuntimeDriver['mountCompanion']>>|undefined,sequence=0,closed=false;
    const heartbeat=async()=>{if(closed)throw new Error('SERVICE_DISCONNECTED');await ui?.heartbeat(++sequence);};
    return {targetInstanceId,onInteraction:portAdapter.onInteraction,onInvalidated:listener=>owned.watchInvalidation(owned.target,listener),setInteractionOptions:portAdapter.setInteractionOptions,
      async mountWorkbench(state,onAction){if(closed||ui)throw new Error('WORKBENCH_ALREADY_MOUNTED');ui=await owned.mountCompanion(state,onAction);if(closed){await ui.detach();throw new Error('SERVICE_DISCONNECTED');}},
      async updateWorkbench(state){if(closed)return;await ui?.publish(state);},
      async read(authGeneration){await heartbeat();return portAdapter.read(authGeneration);},
      async renew(){await heartbeat();await portAdapter.renew();},replace:portAdapter.replace,
      async close(){if(closed)return;closed=true;try{await ui?.detach();}finally{await owned.disconnect();}},
    };
  }catch(error){if(driver)await driver.disconnect().catch(()=>{});else await transport.disconnect().catch(()=>{});throw error;}
}
export async function startExternalClient():Promise<number>{
  const launched=await launchFromExplicitUserAction(new WindowsLaunchPlatform(),'start-runtime-assistance');return launched.process.pid;
}
