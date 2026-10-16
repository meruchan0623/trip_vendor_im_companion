import { createLaunchPlatform, existingClientDebugPort } from '../runtime/platform';
import { reattachExplicitDevInstance, launchFromExplicitUserAction } from '../runtime/launcher';
import { connectOwnedLoopback } from '../runtime/transport';
import { LiveRuntimeDriver } from '../runtime/driver';
import type { NativeInteraction, NativeInteractionOptions, NativePoll } from '../runtime/native-composer';
import type { PanelState, VerifiedComposerSnapshot } from '../src/shared/workbench';
declare const __NATIVE_ARTIFACT_SOURCE__:string;
declare const __NATIVE_ARTIFACT_SHA256__:string;
declare const __RUNTIME_ARTIFACT_SOURCE__:string;
declare const __RUNTIME_ARTIFACT_SHA256__:string;
export interface ExternalComposer {
  targetInstanceId:string;
  onInteraction?(listener:(event:NativeInteraction)=>void):()=>void;
  onInvalidated?(listener:()=>void):()=>void;
  setInteractionOptions?(options:NativeInteractionOptions):Promise<void>;
  mountWorkbench?(state:PanelState,onAction:(action:string,args:unknown[])=>Promise<void>):Promise<void>;
  updateWorkbench?(state:PanelState):Promise<void>;
  read(authGeneration:number):Promise<NativePoll>;
  renew():Promise<void>;
  replace(expected:VerifiedComposerSnapshot,text:string,authorize:()=>void|(()=>void)|Promise<void|(()=>void)>):Promise<void>;
  /** Sends the exact verified draft through the vendor send button. Only for a user's own Enter in send mode. */
  send?(expected:VerifiedComposerSnapshot,authorize:()=>void|(()=>void)|Promise<void|(()=>void)>):Promise<void>;
  close():Promise<void>;
}
/** Attaches to an already running, fingerprinted client and mounts only owned page UI. */
export async function connectExternalComposer(targetInstanceId:string,signal?:AbortSignal):Promise<ExternalComposer> {
  if(process.platform!=='win32'&&process.platform!=='darwin'||!/^\d+:\d+:\d+$/.test(targetInstanceId))throw new Error('INVALID_TARGET');
  const started=Date.now();
  const mark=(stage:string)=>console.log(JSON.stringify({event:'composer-startup',stage,elapsedMs:Date.now()-started,at:new Date().toISOString()}));
  const current=()=>{if(signal?.aborted)throw new Error('CONNECTION_SUPERSEDED');};current();
  mark('start');
  const pid=Number(targetInstanceId.split(':')[0]);
  const port=await existingClientDebugPort(pid);
  const platform=createLaunchPlatform();
  const verified=await reattachExplicitDevInstance(platform,pid,port);current();mark('files-verified');
  const verify=async()=>{current();const process=await platform.processIdentity(pid);if(process.startedAt!==verified.process.startedAt)throw new Error('PROCESS_CHANGED');await reattachExplicitDevInstance(platform,pid,port);current();};
  const transport=await connectOwnedLoopback(port,verify);mark('transport-ready');
  const abort=()=>{void transport.disconnect();};
  signal?.addEventListener('abort',abort,{once:true});
  let driver:LiveRuntimeDriver|undefined;
  try {
    current();
    if(typeof __RUNTIME_ARTIFACT_SOURCE__==='undefined'||typeof __RUNTIME_ARTIFACT_SHA256__==='undefined')throw new Error('RUNTIME_ARTIFACT_NOT_BUILT');
    driver=await LiveRuntimeDriver.discover(transport,verified.fingerprint,__RUNTIME_ARTIFACT_SOURCE__,__RUNTIME_ARTIFACT_SHA256__,8000);
    mark('target-found');await driver.verifyCurrentTarget(driver.target,{collectParentCaptures:false});mark('page-verified');
    if(typeof __NATIVE_ARTIFACT_SOURCE__==='undefined'||typeof __NATIVE_ARTIFACT_SHA256__==='undefined')throw new Error('EDITOR_ARTIFACT_NOT_BUILT');
    const portAdapter=await driver.externalComposer(__NATIVE_ARTIFACT_SOURCE__,__NATIVE_ARTIFACT_SHA256__);
    mark('native-ready');current();signal?.removeEventListener('abort',abort);const owned=driver;
    let ui:Awaited<ReturnType<LiveRuntimeDriver['mountCompanion']>>|undefined,sequence=0,closed=false;
    const heartbeat=async()=>{if(closed)throw new Error('SERVICE_DISCONNECTED');await ui?.heartbeat(++sequence);};
    return {targetInstanceId,onInteraction:portAdapter.onInteraction,onInvalidated:listener=>owned.watchInvalidation(owned.target,listener),setInteractionOptions:portAdapter.setInteractionOptions,
      async mountWorkbench(state,onAction){if(closed||ui)throw new Error('WORKBENCH_ALREADY_MOUNTED');ui=await owned.mountCompanion(state,onAction);mark('panel-mounted');if(closed){await ui.detach();throw new Error('SERVICE_DISCONNECTED');}},
      async updateWorkbench(state){if(closed)return;await ui?.publish(state);},
      async read(authGeneration){await heartbeat();return portAdapter.read(authGeneration);},
      async renew(){await heartbeat();await portAdapter.renew();},replace:portAdapter.replace,send:portAdapter.send,
      async close(){if(closed)return;closed=true;signal?.removeEventListener('abort',abort);try{await ui?.detach();}finally{await owned.disconnect();}},
    };
  }catch(error){signal?.removeEventListener('abort',abort);if(driver)await driver.disconnect().catch(()=>{});else await transport.disconnect().catch(()=>{});throw error;}
}
export async function startExternalClient():Promise<number>{
  const launched=await launchFromExplicitUserAction(createLaunchPlatform(),'start-runtime-assistance');return launched.process.pid;
}
