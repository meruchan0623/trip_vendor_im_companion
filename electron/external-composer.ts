import { createLaunchPlatform, existingClientDebugPort } from '../runtime/platform';
import { reattachExplicitDevInstance, launchFromExplicitUserAction } from '../runtime/launcher';
import { WINDOWS_DYNAMIC_RUNTIME } from '../runtime/build-manifest';
import { connectOwnedLoopback,type LoopbackCDPTransport } from '../runtime/transport';
import { LiveRuntimeDriver } from '../runtime/driver';
import type { NativeInteraction, NativeInteractionOptions, NativePoll } from '../runtime/native-composer';
import type { PanelState, VerifiedComposerSnapshot } from '../src/shared/workbench';
import { reportVendorProgress, type VendorProgressStage } from './vendor-progress';
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
  /** Rebuild page ownership on the same live, revalidated socket after releasing every old handle. */
  reconnect?(signal?:AbortSignal):Promise<ExternalComposer>;
  close():Promise<void>;
}
/** Attaches to an already running, fingerprinted client and mounts only owned page UI. */
export async function connectExternalComposer(targetInstanceId:string,signal?:AbortSignal):Promise<ExternalComposer> {
  if(process.platform!=='win32'&&process.platform!=='darwin'||!/^\d+:\d+:\d+$/.test(targetInstanceId))throw new Error('INVALID_TARGET');
  const started=Date.now();
  const mark=(stage:VendorProgressStage)=>{console.log(JSON.stringify({event:'composer-startup',stage,elapsedMs:Date.now()-started,at:new Date().toISOString()}));reportVendorProgress(stage);};
  const current=()=>{if(signal?.aborted)throw new Error('CONNECTION_SUPERSEDED');};current();
  mark('start');
  const pid=Number(targetInstanceId.split(':')[0]);
  const port=await existingClientDebugPort(pid);
  const platform=createLaunchPlatform();
  const verified=await reattachExplicitDevInstance(platform,pid,port);current();mark('files-verified');
  const verifyOwner=async()=>{if('verifyHandshakeOwner'in platform)await platform.verifyHandshakeOwner(verified.process,port,verified.fingerprint);else{const process=await platform.processIdentity(pid);if(process.startedAt!==verified.process.startedAt)throw new Error('PROCESS_CHANGED');await reattachExplicitDevInstance(platform,pid,port);}};
  const verify=async()=>{current();await verifyOwner();current();};
  const transport=await connectOwnedLoopback(port,verify);mark('transport-ready');
  const owner={transport,verifyOwner,fingerprint:verified.fingerprint,broken:false};transport.onDisconnect(()=>{owner.broken=true;});
  return attachComposer(targetInstanceId,owner,mark,signal);
}
type VerifiedSocket={transport:LoopbackCDPTransport;verifyOwner:()=>Promise<void>;fingerprint:Awaited<ReturnType<typeof reattachExplicitDevInstance>>['fingerprint'];broken:boolean};
async function attachComposer(targetInstanceId:string,owner:VerifiedSocket,mark:(stage:VendorProgressStage)=>void,signal?:AbortSignal):Promise<ExternalComposer>{
  const {transport}=owner;
  let lifecycle:'open'|'reconnecting'|'transferred'|'closed'='open';
  const current=()=>{if(lifecycle!=='open'||signal?.aborted||owner.broken)throw new Error('CONNECTION_SUPERSEDED');};
  const abort=()=>{void transport.disconnect();};
  signal?.addEventListener('abort',abort,{once:true});
  let driver:LiveRuntimeDriver|undefined;
  try {
    current();
    if(typeof __RUNTIME_ARTIFACT_SOURCE__==='undefined'||typeof __RUNTIME_ARTIFACT_SHA256__==='undefined')throw new Error('RUNTIME_ARTIFACT_NOT_BUILT');
    driver=await LiveRuntimeDriver.discover(transport,owner.fingerprint,__RUNTIME_ARTIFACT_SOURCE__,__RUNTIME_ARTIFACT_SHA256__,8000);current();
    mark('target-found');await driver.verifyCurrentTarget(driver.target,{collectParentCaptures:false});mark('page-verified');
    if(typeof __NATIVE_ARTIFACT_SOURCE__==='undefined'||typeof __NATIVE_ARTIFACT_SHA256__==='undefined')throw new Error('EDITOR_ARTIFACT_NOT_BUILT');
    const portAdapter=await driver.externalComposer(__NATIVE_ARTIFACT_SOURCE__,__NATIVE_ARTIFACT_SHA256__);
    mark('native-ready');current();signal?.removeEventListener('abort',abort);const owned=driver;
    let ui:Awaited<ReturnType<LiveRuntimeDriver['mountCompanion']>>|undefined,sequence=0;
    const heartbeat=async()=>{current();await ui?.heartbeat(++sequence);};
    return {targetInstanceId,onInteraction:listener=>{current();return portAdapter.onInteraction(listener);},onInvalidated:listener=>{current();return owned.watchInvalidation(owned.target,listener);},setInteractionOptions:async options=>{current();await portAdapter.setInteractionOptions(options);},
      async mountWorkbench(state,onAction){current();if(ui)throw new Error('WORKBENCH_ALREADY_MOUNTED');ui=await owned.mountCompanion(state,onAction);current();mark('panel-mounted');},
      async updateWorkbench(state){current();await ui?.publish(state);},
      async read(authGeneration){await heartbeat();return portAdapter.read(authGeneration);},
      async renew(){await heartbeat();await portAdapter.renew();},replace:async(...args)=>{current();return portAdapter.replace(...args);},send:async(...args)=>{current();return portAdapter.send(...args);},
      async reconnect(nextSignal){
        current();lifecycle='reconnecting';const nextCurrent=()=>{if(lifecycle!=='reconnecting'||nextSignal?.aborted||owner.broken)throw new Error('CONNECTION_SUPERSEDED');};
        const started=Date.now(),markNext=(stage:VendorProgressStage|'complete')=>console.log(JSON.stringify({event:'composer-reconnect',stage,elapsedMs:Date.now()-started,at:new Date().toISOString()}));markNext('start');
        const cancel=()=>{void transport.disconnect();};nextSignal?.addEventListener('abort',cancel,{once:true});
        try{
          await owned.releaseForReconnect();nextCurrent();await owner.verifyOwner();nextCurrent();
          const next=await attachComposer(targetInstanceId,owner,markNext,nextSignal);
          try{nextCurrent();await owner.verifyOwner();nextCurrent();}catch(error){await next.close();throw error;}
          lifecycle='transferred';markNext('complete');return next;
        }catch(error){lifecycle='closed';await transport.disconnect();throw error;}
        finally{nextSignal?.removeEventListener('abort',cancel);}
      },
      async close(){if(lifecycle==='closed'||lifecycle==='transferred')return;lifecycle='closed';signal?.removeEventListener('abort',abort);await owned.disconnect();},
    };
  }catch(error){signal?.removeEventListener('abort',abort);if(driver)await driver.disconnect().catch(()=>{});else await transport.disconnect().catch(()=>{});throw error;}
}
export async function startExternalClient():Promise<number>{
  if(WINDOWS_DYNAMIC_RUNTIME)throw new Error('INSTALLED_VENDOR_ENTRY_REQUIRED');
  const launched=await launchFromExplicitUserAction(createLaunchPlatform(),'start-runtime-assistance');return launched.process.pid;
}
