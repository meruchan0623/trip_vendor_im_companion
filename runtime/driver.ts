import {isLoginPopoverId} from '../src/shared/owned-login';
import {randomUUID,randomBytes} from 'node:crypto';
import {isOrderWindowIntent, isOutboundMode,isPanelTarget} from '../src/shared/workbench';
import {isCustomerLanguageReport} from '../src/shared/customer-language';
import type {NativeInteraction,NativeInteractionOptions,NativePoll} from './native-composer';
import type {PanelState,VerifiedComposerSnapshot} from '../src/shared/workbench';
import {approvedImTargets,chooseActiveImTarget,observeImTarget,sameTargetInventory} from './target-selection';
import {approvedDocumentURL,assertBuildFingerprint,VERIFIED_RUNTIME_BUILD,type BuildFingerprint} from './identity';
import type {RuntimeTarget,RuntimeDriver,OwnedRuntimeHandle} from './attachment';
import type {CDPEvent,EventCDPTransport} from './transport';
import {RuntimeCDPPolicy,type ParentCapture} from './cdp-policy';
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** Live diagnostics: reason codes only, never page text or payloads. */
const diag=(event:string,fields:Record<string,unknown>)=>{try{console.log(JSON.stringify({event,...fields}));}catch{/* diagnostics are best effort */}};
const reasonOf=(error:unknown)=>error instanceof Error&&/^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)?error.message:'UNCLASSIFIED';
function approvedRendererURL(value:unknown){if(typeof value!=='string')return false;try{const url=new URL(value),expected=new URL(VERIFIED_RUNTIME_BUILD.rendererURL);return url.protocol==='file:'&&!url.host&&!url.search&&!url.hash&&decodeURIComponent(url.pathname).toLowerCase()===decodeURIComponent(expected.pathname).toLowerCase();}catch{return false;}}
/** One approved IM top frame at a time. Only fixed, reviewed native functions may enter the main world. */
export class LiveRuntimeDriver implements RuntimeDriver {
  private policy:RuntimeCDPPolicy;private epoch=0;private invalid=false;private scripts=new Map<string,{id:string;context:number}>();private defaultContexts=new Set<number>();private invalidators=new Set<()=>void>();private stopEvent:()=>void;private stopDisconnect:()=>void;
  private captures:ParentCapture[]=[];
  private nativeListeners=new Set<(event:NativeInteraction)=>void>();private nativeDraining=false;private nativeWake=false;private nativeSendGeneration=0;
  private async drainInteractions(){if(this.invalid)return;this.nativeWake=true;if(this.nativeDraining)return;this.nativeDraining=true;try{while(this.nativeWake&&!this.invalid){this.nativeWake=false;const epoch=this.epoch,events=await this.policy.drainNativeInteractions();this.current(epoch);for(const event of events){if(event?.type!=='draft-changed'&&event?.type!=='replace-shortcut'&&event?.type!=='send-shortcut')throw new Error('NATIVE_EVENTS_UNVERIFIED');if(event.type==='send-shortcut'&&event.sendGeneration!==this.nativeSendGeneration)continue;for(const listener of [...this.nativeListeners])listener(event);}}}catch(error){this.invalidate('NATIVE_EVENT_'+reasonOf(error));}finally{this.nativeDraining=false;}}
  private companionAction?: (action:string,args:unknown[])=>Promise<void>;
  private bindingName=`tsim_${randomBytes(16).toString('hex')}`;
  private mounted=false;private cleanup?:Promise<void>;
  get parentCaptureDiagnostics(){return this.captures.map(item=>({...item}));}
  private constructor(private transport:EventCDPTransport,readonly target:RuntimeTarget,private bundle:string,sha256:string){
    this.policy=new RuntimeCDPPolicy(transport,target,sha256);this.stopEvent=transport.onEvent(event=>this.event(event));this.stopDisconnect=transport.onDisconnect(()=>this.invalidate('TRANSPORT_DISCONNECTED'));
  }
  static async discover(transport:EventCDPTransport,fingerprint:BuildFingerprint,bundle:string,sha256:string,timeoutMs=60000):Promise<LiveRuntimeDriver>{
    assertBuildFingerprint(fingerprint);const deadline=Date.now()+timeoutMs;let selected:{targetId:string;url:string}|undefined;
    while(Date.now()<deadline){const matches=approvedImTargets(await transport.send('Target.getTargets',{}));if(matches.length>1){const observations=[];for(const target of matches)observations.push(await observeImTarget(transport,target,fingerprint,randomUUID()));if(!sameTargetInventory(matches,approvedImTargets(await transport.send('Target.getTargets',{}))))throw new Error('RUNTIME_TARGET_CHANGED');selected=chooseActiveImTarget(observations);break;}if(matches.length===1){selected=matches[0];break;}await pause(250);}
    if(!selected)throw new Error('IM_TARGET_NOT_READY');
    let session:string|undefined;
    try{const result=await transport.send('Target.attachToTarget',{targetId:selected.targetId,flatten:true}) as {sessionId?:unknown};if(typeof result?.sessionId!=='string'||!result.sessionId)throw new Error('INVALID_SESSION');session=result.sessionId;
      const tree=await transport.send('Page.getFrameTree',{},session) as any;const frame=tree?.frameTree?.frame;if(!frame||typeof frame.id!=='string'||frame.parentId||!approvedDocumentURL(frame.url))throw new Error('UNVERIFIED_MAIN_FRAME');
      return new LiveRuntimeDriver(transport,{targetId:selected.targetId,frameId:frame.id,documentURL:frame.url,contextNonce:randomUUID(),fingerprint},bundle,sha256);
    }finally{if(session)await transport.send('Target.detachFromTarget',{sessionId:session});}
  }
  private event(event:CDPEvent){
    if(event.method==='Target.targetDestroyed'&&event.params.targetId===this.target.targetId){this.invalidate('TARGET_DESTROYED');return;}
    if(event.method==='Target.targetInfoChanged'){const info=event.params.targetInfo as any;if(info?.targetId===this.target.targetId&&!approvedDocumentURL(info.url))this.invalidate('TARGET_URL_CHANGED');return;}
    if(event.method==='Target.detachedFromTarget'&&event.params.sessionId===this.policy.session){this.invalidate('SESSION_DETACHED');return;}
    if(event.sessionId!==this.policy.session)return;
    if(this.policy.matchesNativeWake(event)){void this.drainInteractions();return;}
    if(event.method==='Runtime.bindingCalled'&&event.params.name===this.bindingName&&event.params.executionContextId===this.policy.context){void this.action(event.params.payload);return;}
    if(event.method==='Runtime.executionContextCreated'){const context=event.params.context as any;if(context?.auxData?.frameId===this.target.frameId&&context.auxData.isDefault===true&&Number.isSafeInteger(context.id))this.defaultContexts.add(context.id);return;}
    if(event.method==='Debugger.scriptParsed'&&approvedRendererURL(event.params.url)&&typeof event.params.scriptId==='string'&&Number.isSafeInteger(event.params.executionContextId)){this.scripts.set(event.params.scriptId,{id:event.params.scriptId,context:event.params.executionContextId as number});return;}
    if(event.method==='Page.frameNavigated'&&(event.params.frame as any)?.id===this.target.frameId||event.method==='Page.frameStartedLoading'&&event.params.frameId===this.target.frameId||event.method==='Page.frameDetached'&&event.params.frameId===this.target.frameId||event.method==='Runtime.executionContextsCleared'||event.method==='Runtime.executionContextDestroyed'&&(event.params.executionContextId===this.policy.context||event.params.executionContextId===this.target.executionContextId)||event.method==='Inspector.detached')this.invalidate(event.method);
  }
  private invalidate(reason='UNSPECIFIED'){if(this.invalid)return;diag('runtime-invalidated',{reason});this.invalid=true;this.nativeListeners.clear();this.epoch++;this.policy.invalidateContext();for(const callback of [...this.invalidators]){try{callback();}catch{diag('runtime-invalidator-failed',{});}}}
  /** Page intents only: no text payloads, no snapshots, no URLs. Every argument shape is fixed. */
  private async action(payload:unknown){
    if(this.invalid||!this.companionAction||typeof payload!=='string'||payload.length>4096)return;
    const epoch=this.epoch;let id='';
    try{
      const value=JSON.parse(payload);
      if(!value||Object.keys(value).sort().join(',')!=='action,args,id'||typeof value.id!=='string'||!/^\d{1,10}$/.test(value.id)||!Array.isArray(value.args))throw new Error('INVALID_ACTION');
      id=value.id;const args=value.args as unknown[],arg=args[0] as Record<string,unknown>|undefined;
      const plain=(keys:string)=>!!arg&&typeof arg==='object'&&!Array.isArray(arg)&&Object.keys(arg).sort().join(',')===keys;
      switch(value.action){
        case 'setEnabled':if(args.length!==1||typeof args[0]!=='boolean')throw new Error('INVALID_ACTION');break;
        case 'setTarget':if(args.length!==1||!plain('lang,source')||arg!.source!=='manual'||!isPanelTarget(arg!.lang))throw new Error('INVALID_ACTION');break;
        case 'setFallbackTarget':if(args.length!==1||!isPanelTarget(args[0]))throw new Error('INVALID_ACTION');break;
        case 'customerLanguage':if(args.length!==1||!isCustomerLanguageReport(arg))throw new Error('INVALID_ACTION');break;
        case 'followCustomer':case 'retry':case 'openLogin':case 'logout':case 'cancel':case 'resume':if(args.length)throw new Error('INVALID_ACTION');break;
        case 'openOrder':if(args.length!==1||!isOrderWindowIntent(args[0]))throw new Error('INVALID_ACTION');break;
        case 'closeOrder':if(args.length)throw new Error('INVALID_ACTION');break;
        case 'closeLogin':if(args.length!==1||!isLoginPopoverId(args[0]))throw new Error('INVALID_ACTION');break;
        case 'apply':if(args.length!==1||!plain('mode')||arg!.mode!=='replace')throw new Error('INVALID_ACTION');break;
        case 'setOutboundMode':if(args.length!==1||!isOutboundMode(args[0]))throw new Error('INVALID_ACTION');break;
        case 'queryOrder':if(args.length!==1||!plain('identifier')||typeof arg!.identifier!=='string'||arg!.identifier.length<1||arg!.identifier.length>128||/[\u0000-\u001f\u007f-\u009f]/.test(arg!.identifier))throw new Error('INVALID_ACTION');break;
        default:throw new Error('INVALID_ACTION');
      }
      await this.companionAction(value.action,args);this.current(epoch);await this.policy.respondWorkbench(id,true);
    }catch(error){diag('action-failed',{reason:reasonOf(error)});if(id&&!this.invalid)await this.policy.respondWorkbench(id,false).catch(()=>{});}
  }
  private current(epoch:number){if(this.invalid||this.epoch!==epoch)throw new Error('RUNTIME_TARGET_CHANGED');}
  watchInvalidation(target:RuntimeTarget,invalidate:()=>void){if(target!==this.target)throw new Error('WRONG_RUNTIME_TARGET');this.invalidators.add(invalidate);if(this.invalid)invalidate();return()=>this.invalidators.delete(invalidate);}
  async verifyCurrentTarget(target:RuntimeTarget,options:{collectParentCaptures?:boolean}={}){
    if(target!==this.target)throw new Error('WRONG_RUNTIME_TARGET');const epoch=this.epoch;this.current(epoch);
    await this.verifyActiveTarget();this.current(epoch);await this.policy.attachSession();this.current(epoch);await this.policy.enableInspection();this.current(epoch);await this.policy.verifyExactDocument();this.current(epoch);
    const deadline=Date.now()+4000;const candidates=()=>[...this.scripts.values()].filter(script=>this.defaultContexts.has(script.context));while(candidates().length===0&&Date.now()<deadline){this.current(epoch);await pause(50);}if(candidates().length!==1||this.defaultContexts.size!==1)throw new Error('LOADED_RENDERER_NOT_UNIQUE');
    this.target.executionContextId=[...this.defaultContexts][0];await this.policy.verifyRenderer(candidates()[0].id);this.current(epoch);await this.policy.createOwnedWorld();this.current(epoch);// Capture listeners are optional diagnostics, not an authorization gate.
    if(options.collectParentCaptures!==false){this.captures=await this.policy.inspectParentCaptures();this.current(epoch);}
  }
  async mountCompanion(state:PanelState,onAction:(action:string,args:unknown[])=>Promise<void>){
    const epoch=this.epoch;this.current(epoch);if(this.mounted)throw new Error('ALREADY_ATTACHED');this.mounted=true;
    const stopBootstrap=this.keepBootstrapNativeLease(epoch);
    try{
      await this.policy.verifyExactDocument();this.current(epoch);
      await this.policy.installOwnedArtifact(this.bundle);this.current(epoch);
      await this.policy.registerWorkbenchBinding(this.bindingName);this.current(epoch);this.companionAction=onAction;
      for(;;){
        await this.waitUntilVisible(epoch);await this.verifyActiveTarget();this.current(epoch);await this.policy.verifyExactDocument();this.current(epoch);
        try{await this.policy.mountUi({leaseId:this.target.contextNonce,aresVersion:VERIFIED_RUNTIME_BUILD.aresVersion,htmlSha256:this.target.fingerprint.htmlSha256,rendererSha256:this.target.fingerprint.rendererSha256,keyboardBoundary:'isolated-world-shadow'},{bindingName:this.bindingName,state});break;}
        catch(error){this.current(epoch);if(!(error instanceof Error)||error.message!=='IM_TARGET_INACTIVE')throw error;}
      }
      this.current(epoch);await this.policy.verifyOwnedFrame();this.current(epoch);
    }catch(error){await this.cleanupUi().catch(()=>{});throw error;}finally{stopBootstrap();}
    // The service serializes publications. UI heartbeat/update already perform boundary() atomically.
    let detached=false,lastPublished=JSON.stringify(state);
    return{
      publish:async(next:PanelState)=>{if(detached)throw new Error('LEASE_ENDED');this.current(epoch);const signature=JSON.stringify(next);if(signature===lastPublished)return;await this.verifyActiveTarget();this.current(epoch);await this.policy.publishWorkbench(next);this.current(epoch);lastPublished=signature;},
      heartbeat:async(sequence:number)=>{if(detached)throw new Error('LEASE_ENDED');this.current(epoch);await this.verifyActiveTarget();this.current(epoch);await this.policy.heartbeat(sequence);this.current(epoch);},
      detach:async()=>{if(detached)return;detached=true;await this.cleanupUi();},
    };
  }
  private async waitUntilVisible(epoch:number){
    let announced=false;
    for(;;){
      this.current(epoch);const activity=await this.policy.documentActivity();this.current(epoch);if(activity.visible)return;
      if(!announced){diag('runtime-waiting-visible',{});announced=true;}
      await new Promise<void>((resolve,reject)=>{
        const cancel=()=>{clearTimeout(timer);this.invalidators.delete(cancel);reject(new Error('RUNTIME_TARGET_CHANGED'));};
        const timer=setTimeout(()=>{this.invalidators.delete(cancel);resolve();},500);this.invalidators.add(cancel);
        if(this.invalid||this.epoch!==epoch)cancel();
      });
    }
  }
  /** Bootstrap may wait for a hidden BrowserView; renew only the fixed native lease, never draft data. */
  private keepBootstrapNativeLease(epoch:number){
    if(!this.policy.nativeReady)return()=>{};
    let busy=false;
    const timer=setInterval(()=>{if(busy||this.invalid||this.epoch!==epoch)return;busy=true;void this.policy.renewNative().catch(()=>this.invalidate('BOOTSTRAP_NATIVE_LEASE_ENDED')).finally(()=>{busy=false;});},1000);
    return()=>{clearInterval(timer);};
  }
  /** Legacy attachment can mount an inert shell; production supplies CompanionService via mountCompanion. */
  async mountOwnedBundle(target:RuntimeTarget,options:{leaseMs:6000;mode:'outbound-operator';customerSend:'disabled'}):Promise<OwnedRuntimeHandle>{
    if(target!==this.target||options.leaseMs!==6000||options.mode!=='outbound-operator'||options.customerSend!=='disabled')throw new Error('UNAPPROVED_RUNTIME_OPTIONS');
    const epoch=this.epoch;this.current(epoch);if(this.mounted)throw new Error('ALREADY_ATTACHED');this.mounted=true;
    try{await this.policy.verifyExactDocument();this.current(epoch);await this.policy.installOwnedArtifact(this.bundle);this.current(epoch);await this.policy.mountUi({leaseId:target.contextNonce,aresVersion:VERIFIED_RUNTIME_BUILD.aresVersion,htmlSha256:target.fingerprint.htmlSha256,rendererSha256:target.fingerprint.rendererSha256,keyboardBoundary:'isolated-world-shadow'});this.current(epoch);await this.policy.verifyOwnedFrame();this.current(epoch);}catch(error){await this.cleanupUi().catch(()=>{});throw error;}
    return{heartbeat:async sequence=>{this.current(epoch);await this.policy.verifyOwnedFrame();this.current(epoch);await this.policy.heartbeat(sequence);this.current(epoch);},detach:async()=>{await this.cleanupUi();await this.policy.detachSession();}};
  }
  private async cleanupUi(){this.companionAction=undefined;try{await this.policy.detachUi();}finally{this.mounted=false;}}
  async disconnect(){
    if(this.cleanup)return this.cleanup;
    let resolve!:()=>void,reject!:(error:unknown)=>void;
    // Reserve before notifying invalidators: a host callback may synchronously close the same port.
    this.cleanup=new Promise<void>((done,fail)=>{resolve=done;reject=fail;});
    this.invalidate();this.stopEvent();this.stopDisconnect();
    void (async()=>{try{await this.cleanupUi();}finally{try{await this.policy.detachSession();}finally{await this.transport.disconnect();}}})().then(resolve,reject);
    return this.cleanup;
  }
  async geometry(){this.current(this.epoch);return this.policy.geometry();}
  private async verifyActiveTarget(){
    const epoch=this.epoch;this.current(epoch);
    try{
      const candidates=approvedImTargets(await this.transport.send('Target.getTargets',{}));this.current(epoch);
      if(!candidates.some(target=>target.targetId===this.target.targetId))throw new Error('RUNTIME_TARGET_CHANGED');
      if(candidates.length===1)return;
      const observations=[];for(const target of candidates){observations.push(await observeImTarget(this.transport,target,this.target.fingerprint,this.target.contextNonce));this.current(epoch);}
      const currentInventory=approvedImTargets(await this.transport.send('Target.getTargets',{}));this.current(epoch);
      if(!sameTargetInventory(candidates,currentInventory))throw new Error('RUNTIME_TARGET_CHANGED');
      const selected=chooseActiveImTarget(observations);if(selected.targetId!==this.target.targetId||selected.frameId!==this.target.frameId)throw new Error('RUNTIME_TARGET_CHANGED');
    }catch(error){this.invalidate('ACTIVE_TARGET_'+reasonOf(error));throw error;}
  }
  /** External tools use only the verified editor port. This does not mount page UI or an iframe. */
  async externalComposer(source:string,sha256:string){
    const epoch=this.epoch;this.current(epoch);
    await this.policy.installNative(source,sha256,`tsim_native_${randomBytes(16).toString('hex')}`);this.current(epoch);
    let lastDiagnostic='';
    const observed=(poll:NativePoll)=>{const fields={reason:poll.reason??null,messageSurface:poll.messageSurface??null,viewport:poll.orderViewport??null,orderCount:poll.orderEntries?.length??0},signature=JSON.stringify(fields);if(signature!==lastDiagnostic){lastDiagnostic=signature;diag('external-message-surface',fields);}return poll;};
    return {
      onInteraction:(listener:(event:NativeInteraction)=>void)=>{this.current(epoch);this.nativeListeners.add(listener);return()=>{this.nativeListeners.delete(listener);};},
      setInteractionOptions:async(options:NativeInteractionOptions)=>{this.current(epoch);const generation=options.sendGeneration??0;if(!Number.isSafeInteger(generation)||generation<0)throw new Error('INVALID_INTERACTION_OPTIONS');if(generation<this.nativeSendGeneration)return;this.nativeSendGeneration=generation;await this.policy.setNativeInteractionOptions(options);this.current(epoch);},
      renew:async()=>{this.current(epoch);await this.policy.renewNative();this.current(epoch);},
      read:async(authGeneration:number):Promise<NativePoll>=>{
        this.current(epoch);await this.verifyActiveTarget();this.current(epoch);await this.policy.verifyExactDocument();this.current(epoch);
        // A foreground non-message page still calls read(), so renew before the nav gate without reading business text.
        await this.policy.renewNative();this.current(epoch);
        const inactive=(reason='MESSAGE_PAGE_INACTIVE'):NativePoll=>observed({writeVerified:false,reason,messageSurface:{active:false,composerRect:null,toolbarRect:null},orderEntries:[]});
        let nav;try{nav=await this.policy.readMessageNavigation();}catch(error){this.current(epoch);return inactive(reasonOf(error));}this.current(epoch);if(!nav.active)return inactive();
        const result=await this.policy.pollNative(authGeneration) as NativePoll;this.current(epoch);if(!result.messageSurface?.active)return inactive(result.reason??'COMPOSER_GEOMETRY_UNAVAILABLE');
        const after=await this.policy.pollNative(authGeneration) as NativePoll;this.current(epoch);
        if(!after.messageSurface?.active||!result.snapshot||!after.snapshot||JSON.stringify(result.snapshot)!==JSON.stringify(after.snapshot))return inactive();
        const navAfter=await this.policy.readMessageNavigation().catch(()=>null);this.current(epoch);if(!navAfter?.active||navAfter.dpr!==nav.dpr||navAfter.width!==nav.width||navAfter.height!==nav.height)return inactive();
        return observed({...after,orderFrame:undefined,orderEntries:[]});
      },
      replace:async(expected:VerifiedComposerSnapshot,text:string,authorize:()=>void|(()=>void)|Promise<void|(()=>void)>)=>{this.current(epoch);await this.verifyActiveTarget();this.current(epoch);await this.policy.verifyExactDocument();this.current(epoch);const nav=await this.policy.readMessageNavigation();this.current(epoch);if(!nav.active)throw new Error('MESSAGE_PAGE_INACTIVE');const current=await this.policy.pollNative(expected.authGeneration) as NativePoll;this.current(epoch);if(!current.messageSurface?.active)throw new Error('MESSAGE_PAGE_INACTIVE');const navAfter=await this.policy.readMessageNavigation();this.current(epoch);if(!navAfter.active)throw new Error('MESSAGE_PAGE_INACTIVE');const finalAuthorize=await authorize();this.current(epoch);await this.verifyActiveTarget();this.current(epoch);const finalNav=await this.policy.readMessageNavigation();this.current(epoch);if(!finalNav.active)throw new Error('MESSAGE_PAGE_INACTIVE');if(typeof finalAuthorize==='function')finalAuthorize();await this.policy.replaceNative(expected,text);this.current(epoch);},
      send:async(expected:VerifiedComposerSnapshot,authorize:()=>void|(()=>void)|Promise<void|(()=>void)>)=>{this.current(epoch);await this.verifyActiveTarget();this.current(epoch);await this.policy.verifyExactDocument();this.current(epoch);const nav=await this.policy.readMessageNavigation();this.current(epoch);if(!nav.active)throw new Error('MESSAGE_PAGE_INACTIVE');const current=await this.policy.pollNative(expected.authGeneration) as NativePoll;this.current(epoch);if(!current.messageSurface?.active)throw new Error('MESSAGE_PAGE_INACTIVE');const navAfter=await this.policy.readMessageNavigation();this.current(epoch);if(!navAfter.active)throw new Error('MESSAGE_PAGE_INACTIVE');const finalAuthorize=await authorize();this.current(epoch);await this.verifyActiveTarget();this.current(epoch);const finalNav=await this.policy.readMessageNavigation();this.current(epoch);if(!finalNav.active)throw new Error('MESSAGE_PAGE_INACTIVE');if(typeof finalAuthorize==='function')finalAuthorize();await this.policy.sendNative(expected);this.current(epoch);},
    };
  }
}








