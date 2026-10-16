import { randomUUID, createHash } from 'node:crypto';
import { BrowserProfileSessionService, type BrowserProfileSessionOptions } from './browser-profile-session';
import { isOutboundMode, isPanelTarget, sameVerifiedDraft, type OutboundMode, type PanelTarget, type PanelOrderState, type PsimIdentity, type VerifiedComposerSnapshot } from '../src/shared/workbench';
import type { StandaloneState, OrderEntry } from '../src/shared/companion-api';
import type {NativeInteraction} from '../runtime/native-composer';
import type { NativeAdapter, NativeDraftSnapshot, WindowState } from './native-adapter';
import { connectExternalComposer, type ExternalComposer } from './external-composer';
import { embeddedPanelState, invokeEmbeddedAction } from './embedded-host';

type Captured = {source:'uia';snapshot:NativeDraftSnapshot} | {source:'verified-editor';snapshot:VerifiedComposerSnapshot;orderEntries:OrderEntry[];orderViewport:StandaloneState['orderViewport'];messageSurface:StandaloneState['messageSurface']};
const same=(a:Captured,b:Captured)=>a.source===b.source&&(a.source==='uia'?JSON.stringify(a.snapshot)===JSON.stringify(b.snapshot):sameVerifiedDraft(a.snapshot,b.snapshot as VerifiedComposerSnapshot));
const messages:Record<string,string>={
  MESSAGE_PAGE_INACTIVE:'请先切换到旅游商家的“消息”页面并打开客户会话。',
  PSIM_LOGIN_REQUIRED:'请点击请求登录，登录 TSim 后将自动保存会话。',
  SESSION_STORAGE_ENCRYPTION_UNAVAILABLE:'系统安全存储不可用，请解锁系统钥匙串后重试。',
  SESSION_STORAGE_CORRUPT:'保存的登录态无法解密，请在账户设置中重新登录。',
  SESSION_STORAGE_INVALID:'保存的登录态无效，请在账户设置中重新登录。',
  SESSION_STORAGE_READ_FAILED:'无法读取已保存的登录态，请检查本机存储后重试。',
  SESSION_STORAGE_WRITE_FAILED:'登录态保存失败，请检查本机存储后重试。',
  SESSION_STORAGE_CLEAR_FAILED:'登录态清除失败，请检查本机存储后重试。',
  PSIM_SESSION_LOAD_FAILED:'无法读取已保存的登录态，请重试或重新登录。',
  PSIM_SESSION_SAVE_FAILED:'登录态保存失败，请检查本机存储后重试。',
  PSIM_SESSION_CLEAR_FAILED:'登录态清除失败，请检查本机存储后重试。',
  BROWSER_BRIDGE_UNAVAILABLE:'未读取到浏览器 TSim 会话，请确认已在 Edge 或 Chrome 登录。',
  BROWSER_SESSION_ACCESS_DENIED:'系统阻止读取浏览器登录态。请在系统隐私设置中允许旅游商家助手访问浏览器数据，再重试。',
  SERVICE_UNAVAILABLE:'暂时无法核验 TSim 登录态，请检查网络后重试。',
  BROWSER_SESSION_STORAGE_INVALID:'浏览器会话数据暂不可读，请稍后重试。',
  BROWSER_SESSION_TIMEOUT:'TSim 会话核验超时，请稍后重试。',
  BROWSER_LOGIN_OPEN_FAILED:'TSim 登录页未能打开，请检查 Edge 或 Chrome 后重试。',
  BROWSER_BRIDGE_TIMEOUT:'浏览器 TSim 会话响应超时，请检查浏览器连接后重试。',
  EXISTING_CLIENT_DEBUG_PORT_REQUIRED:'此客户端未开放编辑器连接。请使用辅助启动入口启动客户端后再连接。',
  COMPOSER_UNAVAILABLE:'未找到可读取的回复文本框，请先打开客户会话。',
  DRAFT_CHANGED:'草稿或客户会话已改变，请重新翻译。',
  TARGET_REQUIRED:'请先绑定旅游商家窗口。',
  INPUT_COMPOSING:'中文输入尚未完成，请稍后翻译。',
  WRITE_UNAVAILABLE:'此文本框尚不支持安全替换，请连接已核验编辑器。',
  AUTH_CHANGED:'登录账号已改变，请重新翻译。',
  BROWSER_CLEANUP_UNCONFIRMED:'订单浮层关闭状态暂未确认，请检查浏览器窗口。',
  BROWSER_PLACEMENT_FAILED:'订单浮层未能显示，请重新点击订单号。',
  BROWSER_SPACE_TOO_SMALL:'订单查询空间不足，请先放大商家窗口，再打开订单。',
  NATIVE_SEND_FAILED:'未能自动发送，请确认输入框内容后再按 Enter。',
  SEND_UNAVAILABLE:'当前编辑器不支持自动发送，请切换为替换模式。',
};
/** Quiet period after the last edit before an automatic outbound translation request. */
export const AUTO_TRANSLATE_DELAY_MS=500;
export type SessionPort=Pick<BrowserProfileSessionService,'identity'|'sync'|'setBackgroundPolling'|'getBrowserProfile'|'translate'|'queryOriginalIdentifier'|'openLogin'|'logout'|'dispose'>;
export type SessionFactory=(changed:(identity:PsimIdentity|null)=>void,options:BrowserProfileSessionOptions)=>SessionPort;
export class CompanionService {
  private state:StandaloneState={attached:false,targetInstanceId:null,nativeStatus:'starting',auth:'connecting',accountScope:'unknown',draft:null,preview:null,phase:'idle',error:null,language:'en',customerLanguage:'unknown',followCustomerLanguage:true,autoTranslate:true,shortcutEnabled:true,outboundMode:'send',sendPending:false,translationPaused:false,browserOpen:false,composerSource:'unavailable',orderEntries:[],orderViewport:null,messageSurface:{active:false,composerRect:null,toolbarRect:null}};
  private listeners=new Set<(state:StandaloneState)=>void>();
  private psim:SessionPort;
  private sessionStarting:Promise<void>;
  private external?:ExternalComposer;
  private externalConnecting?:Promise<void>;
  private stopInteraction?:()=>void;
  private stopInvalidation?:()=>void;
  private embeddedPublishing=false;
  private embeddedDirty=false;
  private nextConnectAt=0;
  private connectionEpoch=0;
  private connectionAbort?:AbortController;
  private order:PanelOrderState={identifier:'',status:'idle',error:null,fields:[]};
  private orderGeneration=0;
  private orderRequest?:AbortController;
  private clearOrder(){++this.orderGeneration;this.orderRequest?.abort();this.orderRequest=undefined;this.order={identifier:'',status:'idle',error:null,fields:[]};}
  private resetCustomerLanguage(){this.state.customerLanguage='unknown';this.state.followCustomerLanguage=true;this.state.language='en';this.translationIntent++;this.attempted=undefined;this.suppressed=undefined;}
  private contextChanged(){this.invalidate();this.lastWritten=undefined;this.clearPendingSend();this.resetCustomerLanguage();this.clearOrder();this.onContextChanged();}
  private embeddedState(){return embeddedPanelState(this.getState(),this.captured?.source==='verified-editor'?this.context():null);}
  private retireComposer(composer:ExternalComposer){
    if(this.external!==composer||this.closed)return;
    this.translationIntent++;this.invalidate();this.captured=undefined;
    this.state.draft=null;this.state.orderEntries=[];this.state.orderViewport=null;
    this.state.messageSurface={active:false,composerRect:null,toolbarRect:null};this.state.composerSource='unavailable';
    this.retireInteractions();this.external=undefined;this.nextConnectAt=Date.now()+1000;
    void composer.close().catch(()=>{});this.verifiedContext=undefined;this.verifiedCustomerContext=undefined;this.contextChanged();this.publish();
  }
  private publishEmbedded(){
    this.embeddedDirty=true;if(this.embeddedPublishing)return;this.embeddedPublishing=true;
    void(async()=>{try{while(this.embeddedDirty&&!this.closed){this.embeddedDirty=false;const external=this.external;if(external?.updateWorkbench)try{await external.updateWorkbench(this.embeddedState());}catch{this.retireComposer(external);}}}finally{this.embeddedPublishing=false;}})();
  }
  private interactionRefresh=false;
  private interactionTask?:Promise<void>;
  private nativeOptions?:string;
  /** Whether an outbound translation is expected for the current draft; otherwise Enter stays with the vendor. */
  private translationApplies(){return this.state.autoTranslate!==false&&!this.state.translationPaused&&this.state.auth==='ready'&&(this.state.followCustomerLanguage===false||isPanelTarget(this.state.customerLanguage));}
  private syncInteractionOptions(){const external=this.external;if(!external?.setInteractionOptions)return;const options={shortcutEnabled:this.state.shortcutEnabled!==false,enterSend:this.state.outboundMode==='send'&&this.translationApplies()},key=JSON.stringify(options);if(key===this.nativeOptions)return;this.nativeOptions=key;void external.setInteractionOptions(options).catch(()=>{if(this.external===external)this.nativeOptions=undefined;});}
  private retireInteractions(){this.stopInteraction?.();this.stopInteraction=undefined;this.stopInvalidation?.();this.stopInvalidation=undefined;this.nativeOptions=undefined;this.interactionRefresh=false;this.interactionTask=undefined;}
  private interaction(event:NativeInteraction,external:ExternalComposer){
    if(this.closed||external!==this.external)return;
    if(event.type==='replace-shortcut'){if(this.state.shortcutEnabled!==false&&this.state.phase==='ready'&&!this.state.translationPaused&&this.state.auth==='ready'&&this.foreground&&this.reviewed?.capture.source==='verified-editor'&&sameVerifiedDraft(this.reviewed.capture.snapshot,event.snapshot))void this.replaceDraft(event.snapshot);return;}
    if(event.type==='send-shortcut'){void this.sendShortcut(event.snapshot);return;}
    if(event.type!=='draft-changed')return;
    // Revoke immediately, before CDP reads or the 500 ms safety observation can finish.
    this.clearPendingSend();this.translationIntent++;this.invalidate();this.attempted=undefined;this.suppressed=undefined;this.interactionRefresh=true;this.publish();
    if(this.interactionTask)return;
    const task=(async()=>{while(this.interactionRefresh&&!this.closed&&this.external===external){this.interactionRefresh=false;if(!this.foreground)return;await this.acquireEditor();const epoch=this.epoch,id=this.state.targetInstanceId;try{if(this.closed||external!==this.external)continue;const capture=await this.capture();if(this.closed||external!==this.external||epoch!==this.epoch||id!==this.state.targetInstanceId)continue;this.adopt(capture);this.publish();}catch{/* The fallback observation handles source recovery. */}finally{this.setBusy(false);}}})();
    this.interactionTask=task;void task.finally(()=>{if(this.interactionTask===task)this.interactionTask=undefined;});
  }
  private captured?:Captured;
  /** Survives temporary capture failures so recovery can distinguish the same customer from a new one. */
  private verifiedContext?:string;
  private verifiedCustomerContext?:string;
  private sessionIdentity?:string;
  private reviewed?:{capture:Captured;identity:PsimIdentity;text:string};
  /** The draft the user pressed Enter on in send mode, waiting for its translation. */
  private pendingSend?:VerifiedComposerSnapshot;
  /** The last draft this service wrote; Enter sends it as is instead of translating it again. */
  private lastWritten?:VerifiedComposerSnapshot;
  private clearPendingSend(){this.pendingSend=undefined;this.state.sendPending=false;}
  private epoch=0; private request?:AbortController; private closed=false;
  private busy=false; private foreground=false; private poll?:ReturnType<typeof setInterval>;
  private editorIdle:Promise<void>=Promise.resolve();
  private releaseEditor?:()=>void;
  private setBusy(value:boolean){this.busy=value;if(value)this.editorIdle=new Promise(resolve=>{this.releaseEditor=resolve;});else{this.releaseEditor?.();this.releaseEditor=undefined;}}
  private async acquireEditor(){while(this.busy)await this.editorIdle;this.setBusy(true);}
  private observation?:Promise<void>;
  private autoTimer?:ReturnType<typeof setTimeout>;
  private attempted?:string;
  private translationIntent=0;
  private suppressed?:string;
  private pausedContext?:string;
  private renewing=false;
  private context(capture=this.captured){return capture?JSON.stringify(capture.source==='verified-editor'?[this.state.targetInstanceId,capture.snapshot.conversationId,capture.snapshot.scopeGeneration,capture.snapshot.platformAccountScope]:[this.state.targetInstanceId,capture.snapshot.editorIdentity]):'';}
  /** Language and pause preferences belong to the customer, across editor remounts. */
  private customerContext(capture=this.captured){return capture?.source==='verified-editor'?JSON.stringify([this.state.targetInstanceId,capture.snapshot.conversationId,capture.snapshot.platformAccountScope,capture.snapshot.documentGeneration]):this.context(capture);}
  private signature(capture=this.captured){return capture?JSON.stringify([capture.source,capture.snapshot,this.state.language,this.state.accountScope]):'';}
  private stopTimer(){if(this.autoTimer)clearTimeout(this.autoTimer);this.autoTimer=undefined;}
  private schedule(delay=this.pendingSend?0:AUTO_TRANSLATE_DELAY_MS){
    const capture=this.captured,key=this.signature();
    if(this.state.followCustomerLanguage!==false&&!isPanelTarget(this.state.customerLanguage))return;
    if(this.closed||!this.foreground||!this.state.autoTranslate||this.state.translationPaused||this.state.auth!=='ready'||capture?.source!=='verified-editor'||!capture.snapshot.isPlainText||capture.snapshot.composing||!capture.snapshot.text.trim()||key===this.attempted||key===this.suppressed)return;
    if(this.autoTimer){this.state.phase='waiting';return;}
    this.state.phase='waiting';
    this.autoTimer=setTimeout(()=>{this.autoTimer=undefined;if(key!==this.signature())return;if(this.busy||this.externalConnecting){this.schedule(this.pendingSend?25:AUTO_TRANSLATE_DELAY_MS);return;}this.attempted=key;void this.translate(this.state.language,key);},delay);
  }
  async setTranslationOptions(options:{language?:PanelTarget;autoTranslate?:boolean;shortcutEnabled?:boolean;outboundMode?:OutboundMode}){
    if(options.outboundMode!==undefined){if(!isOutboundMode(options.outboundMode))throw new Error('INVALID_OUTBOUND_MODE');if(options.outboundMode!==this.state.outboundMode){this.clearPendingSend();this.state.outboundMode=options.outboundMode;}}
    if(options.shortcutEnabled!==undefined){if(typeof options.shortcutEnabled!=='boolean')throw new Error('INVALID_SHORTCUT_OPTION');this.state.shortcutEnabled=options.shortcutEnabled;}
    if(options.language!==undefined&&!isPanelTarget(options.language))throw new Error('INVALID_LANGUAGE');
    if(options.language!==undefined){this.state.followCustomerLanguage=false;}
    if(options.language!==undefined&&options.language!==this.state.language){this.translationIntent++;this.invalidate();this.state.language=options.language;this.suppressed=undefined;this.attempted=undefined;this.state.error=null;}
    if(options.autoTranslate!==undefined&&options.autoTranslate!==this.state.autoTranslate){this.clearPendingSend();this.translationIntent++;this.invalidate();this.state.autoTranslate=options.autoTranslate;this.attempted=undefined;}
    this.schedule();this.publish();
  }
  async reportCustomerLanguage(language:string,conversationKey:string){
    if(!/^(unknown|zh|en|ja|ko|ar|ru|el|th|es|fr|de|pt|it|vi|id|ms)$/.test(language)||conversationKey!==this.context()||!this.external||!this.state.messageSurface?.active)return;
    if(!await this.waitForObservation())return;await this.acquireEditor();
    const epoch=this.epoch,customerContext=this.verifiedCustomerContext;
    try{const capture=await this.capture();if(epoch!==this.epoch||this.closed)return;this.adopt(capture);if(conversationKey!==this.context(capture)||customerContext!==undefined&&customerContext!==this.customerContext(capture)){this.publish();return;}if(language==='unknown'&&this.state.customerLanguage!=='unknown'||language===this.state.customerLanguage){this.publish();return;}this.state.customerLanguage=language;if(this.state.followCustomerLanguage!==false){this.translationIntent++;this.invalidate();this.attempted=undefined;this.suppressed=undefined;if(isPanelTarget(language))this.state.language=language;this.schedule();}this.publish();}catch(error){if(epoch===this.epoch&&!this.closed)this.fail(error,true);}finally{this.setBusy(false);}
  }
  async followCustomerLanguage(){this.state.followCustomerLanguage=true;this.translationIntent++;this.invalidate();this.attempted=undefined;this.suppressed=undefined;if(isPanelTarget(this.state.customerLanguage))this.state.language=this.state.customerLanguage;this.schedule();this.publish();}
  async cancelTranslation(){this.clearPendingSend();this.translationIntent++;this.pausedContext=this.customerContext();this.state.translationPaused=true;this.invalidate();this.state.phase='idle';this.state.error=null;this.publish();}
  async resumeTranslation(){this.translationIntent++;this.pausedContext=undefined;this.state.translationPaused=false;this.attempted=undefined;this.suppressed=undefined;this.invalidate();this.state.phase='idle';this.schedule();this.publish();}

  private sessionError:string|null=null;
  private sourceFailure=false;
  private surfaceMeasurementRevision=0;
  constructor(private native:NativeAdapter,openLoginURL:(url:string)=>Promise<void>,private onContextChanged:()=>void=()=>{},sessionOptions:BrowserProfileSessionOptions={},private embeddedMode=false,sessionFactory:SessionFactory=(changed,options)=>new BrowserProfileSessionService(changed,options)){
    this.psim=sessionFactory(identity=>{
      const sessionIdentity=identity?.accountScope;
      if(sessionIdentity!==undefined&&this.sessionIdentity!==undefined&&sessionIdentity!==this.sessionIdentity){this.contextChanged();this.verifiedContext=undefined;this.verifiedCustomerContext=undefined;}
      if(sessionIdentity!==undefined)this.sessionIdentity=sessionIdentity;
      this.clearOrder();this.invalidate();this.attempted=undefined;this.suppressed=undefined;this.state.auth=identity?'ready':'connecting';this.state.accountScope=identity?.accountScope??'unknown';
      if(identity&&[messages.BROWSER_BRIDGE_UNAVAILABLE,messages.BROWSER_BRIDGE_TIMEOUT,messages.PSIM_LOGIN_REQUIRED].includes(this.state.error??'')){this.state.error=null;if(this.state.phase==='failed')this.state.phase='idle';}
      this.schedule();this.publish();
    },{...sessionOptions,openExternal:openLoginURL,backgroundPolling:false,onStatus:(status,code)=>{
      if(this.closed)return;
      this.state.auth=status;
      if(status==='failed'){this.sessionError=messages[code??'SERVICE_UNAVAILABLE']??messages.BROWSER_SESSION_STORAGE_INVALID;this.state.error=this.sessionError;this.state.phase='failed';}
      else if(status==='ready'||status==='needs_login'){if(this.sessionError&&this.state.error===this.sessionError){this.state.error=null;if(this.state.phase==='failed')this.state.phase='idle';}this.sessionError=null;}
      sessionOptions.onStatus?.(status,code);this.schedule();this.publish();
    }});
    this.sessionStarting=this.psim.sync().catch(error=>{if(!this.closed){if(this.state.auth!=='needs_login')this.state.auth='failed';this.fail(error);this.sessionError=this.state.error;}});
  }
  private updatePolling(){
    const active=this.state.attached&&!this.closed;
    this.psim.setBackgroundPolling(active);
    if(!active){if(this.poll)clearInterval(this.poll);this.poll=undefined;return;}
    if(this.poll)return;
    this.poll=setInterval(()=>{
      if(this.embeddedMode&&!this.external&&!this.externalConnecting&&Date.now()>=this.nextConnectAt){this.nextConnectAt=Date.now()+5000;void this.connectComposer();return;}
      if(this.foreground&&!this.busy&&!this.externalConnecting&&this.state.attached)this.observation=this.observe().finally(()=>{this.observation=undefined;});
      else if(this.external&&!this.renewing&&!this.externalConnecting){const external=this.external;this.renewing=true;void external.renew().catch(()=>this.retireComposer(external)).finally(()=>{this.renewing=false;});}
    },500);
  }
  getState(){const state=structuredClone(this.state);if(state.auth==='failed'&&this.sessionError)state.error=this.sessionError;return state;}
  getOrderStatus(){return this.order.status;}
  getSurfaceMeasurementRevision(){return this.surfaceMeasurementRevision;}
  getBrowserProfile(){return this.psim.getBrowserProfile();}
  async refreshSession(){await this.psim.sync();}
  onState(listener:(state:StandaloneState)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  private publish(){this.syncInteractionOptions();if(!this.closed){this.publishEmbedded();for(const listener of this.listeners)listener(this.getState());}}
  setNativeStatus(status:string){this.state.nativeStatus=status;this.publish();}
  setBrowserOpen(open:boolean){this.state.browserOpen=open;this.publish();}
  reportBrowserFailure(code:'BROWSER_PLACEMENT_FAILED'|'BROWSER_CLEANUP_UNCONFIRMED'|'BROWSER_SPACE_TOO_SMALL'){this.fail(new Error(code));}
  setWindowState(window:WindowState|null){
    if(this.closed)return;
    const id=window?.targetInstanceId??null;if(id!==this.state.targetInstanceId){this.verifiedContext=undefined;this.verifiedCustomerContext=undefined;this.clearPendingSend();this.resetCustomerLanguage();this.clearOrder();}
    if(id!==this.state.targetInstanceId){this.connectionEpoch++;this.connectionAbort?.abort();this.nextConnectAt=0;this.invalidate();this.captured=undefined;this.state.draft=null;this.state.orderEntries=[];this.state.orderViewport=null;this.state.messageSurface={active:false,composerRect:null,toolbarRect:null};this.state.composerSource='unavailable';const previous=this.external;this.retireInteractions();this.external=undefined;void previous?.close().catch(()=>{});}
    if(id!==this.state.targetInstanceId){this.pausedContext=undefined;this.state.translationPaused=false;this.attempted=undefined;this.suppressed=undefined;}
    const wasForeground=this.foreground;
    this.state.targetInstanceId=id;this.state.attached=!!window;this.foreground=!!window&&window.visible&&!window.minimized&&(window.foreground||('groupForeground' in window&&window.groupForeground===true));this.updatePolling();if(wasForeground&&!this.foreground){this.stopTimer();if(this.state.phase==='translating'){this.invalidate();this.attempted=undefined;}else if(this.state.phase==='waiting'){this.state.phase='idle';}}this.schedule();this.publish();
  }
  invalidate(){this.stopTimer();this.epoch++;this.request?.abort();this.request=undefined;this.reviewed=undefined;this.state.preview=null;if(this.state.phase==='ready'||this.state.phase==='translating'||this.state.phase==='waiting')this.state.phase='stale';}
  private fail(error:unknown,sourceFailure=false){this.clearPendingSend();const code=error instanceof Error?error.message:'SERVICE_UNAVAILABLE';this.sourceFailure=sourceFailure&&code!=='DRAFT_CHANGED'&&code!=='AUTH_CHANGED';if(this.sourceFailure||['MESSAGE_PAGE_INACTIVE','COMPOSER_UNAVAILABLE','WRITE_UNAVAILABLE','INPUT_COMPOSING'].includes(code)){this.attempted=undefined;this.invalidate();}const locations=error instanceof Error?error.stack?.split('\n').slice(1,5).flatMap(line=>{const match=/([\w.-]+\.(?:c?js|ts):\d+:\d+)/.exec(line);return match?[match[1]]:[];}):[];console.log(JSON.stringify({event:'companion-service-failed',code:/^[A-Z][A-Z0-9_]{1,80}$/.test(code)?code:'UNCLASSIFIED',errorType:error instanceof Error&&/^[A-Za-z]+$/.test(error.name)?error.name:'Unknown',locations}));if(this.sourceFailure||code==='MESSAGE_PAGE_INACTIVE'||code==='COMPOSER_UNAVAILABLE'){this.attempted=undefined;this.invalidate();this.captured=undefined;this.state.draft=null;this.state.orderEntries=[];this.state.orderViewport=null;this.state.messageSurface={active:false,composerRect:null,toolbarRect:null};this.state.composerSource='unavailable';this.clearOrder();this.onContextChanged();}this.state.error=this.state.auth==='failed'&&this.sessionError?this.sessionError:messages[code]??`操作未完成（${/^[A-Z][A-Z0-9_]{1,80}$/.test(code)?code:'SERVICE_UNAVAILABLE'}），请核对连接后重试。`;this.state.phase='failed';this.publish();}
  private async capture():Promise<Captured>{
    const id=this.state.targetInstanceId;if(!id)throw new Error('TARGET_REQUIRED');
    if(this.external){
      const external=this.external;if(external.targetInstanceId!==id)throw new Error('TARGET_REQUIRED');
      let result;
      try{result=await external.read(this.psim.identity()?.authGeneration??0);}catch(error){
        if(error instanceof Error&&/LEASE_ENDED|RUNTIME_TARGET_CHANGED|OWNED_FRAME_BOUNDARY_FAILED|NATIVE_NOT_READY|NATIVE_POLL_FAILED|SERVICE_DISCONNECTED/.test(error.message))this.retireComposer(external);
        throw error;
      }
      if(result.messageSurface?.active===false)throw new Error('MESSAGE_PAGE_INACTIVE');
      if(!result.snapshot)throw new Error(result.reason??'COMPOSER_UNAVAILABLE');
      if(!result.writeVerified)throw new Error('WRITE_UNAVAILABLE');
      return{source:'verified-editor',snapshot:result.snapshot,orderEntries:result.orderEntries??[],orderViewport:result.orderViewport??null,messageSurface:result.messageSurface};
    }
    if(this.embeddedMode)throw new Error('COMPOSER_UNAVAILABLE');
    const snapshot=await this.native.readDraft();if(snapshot.targetInstanceId!==id)throw new Error('TARGET_REQUIRED');
    return{source:'uia',snapshot};
  }
  private adopt(capture:Captured,invalidateChanged=true){
    this.surfaceMeasurementRevision++;
    if(capture.source==='verified-editor'){
      const customerContext=this.customerContext(capture);
      const context=JSON.stringify([this.context(capture),capture.snapshot.editorIdentity,capture.snapshot.composerId,capture.snapshot.documentGeneration]);
      if(this.verifiedCustomerContext!==undefined&&this.verifiedCustomerContext!==customerContext)this.contextChanged();
      else if(this.verifiedContext!==undefined&&this.verifiedContext!==context){this.invalidate();this.lastWritten=undefined;this.clearPendingSend();this.clearOrder();this.onContextChanged();}
      this.verifiedCustomerContext=customerContext;this.verifiedContext=context;
    }
    const changed=!this.captured||JSON.stringify(this.captured.snapshot)!==JSON.stringify(capture.snapshot)||this.captured.source!==capture.source;
    if(invalidateChanged&&this.captured&&changed){this.invalidate();this.attempted=undefined;}
    if(this.pausedContext!==undefined&&this.pausedContext!==this.customerContext(capture)){this.pausedContext=undefined;this.state.translationPaused=false;}
    if(changed&&this.suppressed!==this.signature(capture))this.suppressed=undefined;
    this.captured=capture;this.state.composerSource=capture.source;
    this.state.messageSurface=capture.source==='verified-editor'?(capture.messageSurface??{active:false,composerRect:null,toolbarRect:null}):{active:false,composerRect:null,toolbarRect:null};
    this.state.orderEntries=capture.source==='verified-editor'?capture.orderEntries:[];this.state.orderViewport=capture.source==='verified-editor'?capture.orderViewport:null;
    this.state.draft={text:capture.snapshot.text,canReplace:capture.source==='verified-editor'?capture.snapshot.isPlainText&&!capture.snapshot.composing:capture.snapshot.canReplace};
    if(invalidateChanged)this.schedule();
  }
  private async observe(){
    this.setBusy(true);const epoch=this.epoch,id=this.state.targetInstanceId;
    try{const capture=await this.capture();if(this.closed||id!==this.state.targetInstanceId||epoch!==this.epoch)return;const recovered=this.sourceFailure&&this.state.phase==='failed'&&this.state.composerSource==='unavailable'&&capture.source==='verified-editor';this.adopt(capture);if(recovered){this.sourceFailure=false;this.state.phase='idle';this.state.error=null;this.schedule();}this.publish();}
    catch(error){if(this.closed||id!==this.state.targetInstanceId||epoch!==this.epoch)return;if(this.external&&error instanceof Error&&/LEASE_ENDED|RUNTIME_TARGET_CHANGED|OWNED_FRAME_BOUNDARY_FAILED|NATIVE_NOT_READY|NATIVE_POLL_FAILED|SERVICE_DISCONNECTED/.test(error.message)){this.retireComposer(this.external);return;}if(this.state.draft||this.state.messageSurface?.active||this.state.orderEntries.length){this.clearPendingSend();this.clearOrder();this.onContextChanged();if(this.state.phase==='ready'||this.state.phase==='translating'||this.state.phase==='waiting')this.attempted=undefined;this.invalidate();this.captured=undefined;this.state.draft=null;this.state.orderEntries=[];this.state.orderViewport=null;this.state.messageSurface={active:false,composerRect:null,toolbarRect:null};this.state.composerSource='unavailable';this.publish();}}
    finally{this.setBusy(false);}
  }
  /** Background captures must finish before a visible enabled user action acquires the editor. */
  private async waitForObservation(){const id=this.state.targetInstanceId;await this.observation;return !this.closed&&id===this.state.targetInstanceId;}
  async readDraft(){if(!await this.waitForObservation()||this.busy)return;this.setBusy(true);this.state.phase='reading';this.state.error=null;const epoch=this.epoch,id=this.state.targetInstanceId;this.publish();try{const capture=await this.capture();if(epoch!==this.epoch||id!==this.state.targetInstanceId)throw new Error('DRAFT_CHANGED');this.state.phase='idle';this.adopt(capture);this.sourceFailure=false;this.publish();}catch(error){this.fail(error,true);}finally{this.setBusy(false);}}
  /** A click belongs to the exact displayed range and conversation, even between observation ticks. */
  async confirmOrderEntry(index:number,expected:OrderEntry):Promise<void>{
    if(!await this.waitForObservation()||this.busy)throw new Error('ORDER_ENTRY_STALE');
    this.setBusy(true);
    try{
    const previous=this.captured,epoch=this.epoch;
    if(previous?.source!=='verified-editor')throw new Error('ORDER_ENTRY_STALE');
    const capture=await this.capture();
    if(epoch!==this.epoch||capture.source!=='verified-editor'||capture.snapshot.conversationId!==previous.snapshot.conversationId||capture.snapshot.scopeGeneration!==previous.snapshot.scopeGeneration||capture.snapshot.documentGeneration!==previous.snapshot.documentGeneration)throw new Error('ORDER_ENTRY_STALE');
    const entry=capture.orderEntries[index];
    if(!entry||entry.identifier!==expected.identifier||entry.identifierType!==expected.identifierType||(['x','y','width','height'] as const).some(key=>Math.abs(entry.rect[key]-expected.rect[key])>0.5))throw new Error('ORDER_ENTRY_STALE');
    this.adopt(capture);this.publish();
    }finally{this.setBusy(false);}
  }
  async connectComposer(){
    // A verified local panel can show connecting/login state while remote authentication runs.
    if(this.closed)return;
    if(this.externalConnecting)return this.externalConnecting;
    const id=this.state.targetInstanceId;if(!id){this.fail(new Error('TARGET_REQUIRED'));return;}this.nextConnectAt=Date.now()+5000;
    this.externalConnecting=(async()=>{
      if(!await this.waitForObservation()||this.busy||id!==this.state.targetInstanceId)return;
      this.connectionAbort?.abort();const connectionAbort=new AbortController();this.connectionAbort=connectionAbort;
      this.invalidate();const epoch=this.connectionEpoch;this.state.error=null;this.state.phase='reading';this.publish();
      const previous=this.external;this.retireInteractions();this.external=undefined;await previous?.close().catch(()=>{});
      try{
        const composer=await connectExternalComposer(id,connectionAbort.signal);
        if(this.closed||epoch!==this.connectionEpoch||id!==this.state.targetInstanceId){await composer.close();return;}
        this.external=composer;this.stopInteraction=composer.onInteraction?.(event=>this.interaction(event,composer));
        this.stopInvalidation=composer.onInvalidated?.(()=>this.retireComposer(composer));this.syncInteractionOptions();
        await composer.mountWorkbench?.(this.embeddedState(),async(action,args)=>{
          if(this.closed||this.external!==composer||id!==this.state.targetInstanceId)throw new Error('RUNTIME_TARGET_CHANGED');
          await invokeEmbeddedAction(this,action,args);
        });
        if(this.external!==composer||this.closed){await composer.close();return;}
        this.state.phase='idle';await this.readDraft();
      }
      catch(error){const failed=this.external;this.retireInteractions();this.external=undefined;await failed?.close().catch(()=>{});if(!this.closed&&epoch===this.connectionEpoch&&id===this.state.targetInstanceId)this.fail(error,true);}
    })().finally(()=>{this.externalConnecting=undefined;});
    return this.externalConnecting;
  }
  async translate(target:PanelTarget,automaticSignature?:string){
    if(!isPanelTarget(target)){this.fail(new Error('INVALID_LANGUAGE'));return;}
    let intent=this.translationIntent;
    await this.sessionStarting;
    if(intent!==this.translationIntent||!this.foreground||this.state.translationPaused)return;
    if(!automaticSignature&&target!==this.state.language)await this.setTranslationOptions({language:target});
    if(this.state.followCustomerLanguage!==false&&!isPanelTarget(this.state.customerLanguage))return;
    // Authentication may publish a newly recovered identity and revoke old reviews.
    // Complete that step before creating this translation's epoch, so a manual retry survives recovery.
    intent=this.translationIntent;const intendedWindow=this.state.targetInstanceId,expectedCustomerContext=this.verifiedCustomerContext;
    try{await this.psim.sync();}catch(error){if(intent===this.translationIntent&&!this.closed)this.fail(error);return;}
    if(intent!==this.translationIntent||this.closed||!this.foreground||this.state.translationPaused||target!==this.state.language||intendedWindow!==this.state.targetInstanceId)return;
    const expectedEpoch=this.epoch;
    if(!await this.waitForObservation()||this.busy||expectedEpoch!==this.epoch||intent!==this.translationIntent||this.state.translationPaused||!this.foreground||target!==this.state.language)return;
    this.invalidate();this.state.error=null;this.state.phase='translating';this.setBusy(true);this.publish();
    const epoch=this.epoch,request=new AbortController();this.request=request;
    const expectedContext=this.context();
    let capture:Captured,identity:PsimIdentity;
    try{
      const currentIdentity=this.psim.identity();if(!currentIdentity)throw new Error('PSIM_LOGIN_REQUIRED');identity=currentIdentity;
      try{capture=await this.capture();}catch(error){if(epoch===this.epoch)this.fail(error,true);return;}
      if(epoch!==this.epoch||!this.foreground)return;
      if(expectedContext&&expectedContext!==this.context(capture)||expectedCustomerContext!==undefined&&expectedCustomerContext!==this.customerContext(capture)){this.adopt(capture);this.publish();return;}
      if(capture.source==='verified-editor'&&!capture.snapshot.isPlainText){this.adopt(capture,false);throw new Error('WRITE_UNAVAILABLE');}
      if(capture.source==='verified-editor'&&capture.snapshot.composing)throw new Error('INPUT_COMPOSING');
      if(!capture.snapshot.text.trim())throw new Error('EMPTY_DRAFT');
      this.adopt(capture,false);
      if(epoch!==this.epoch||intent!==this.translationIntent||target!==this.state.language){this.publish();return;}
      if(automaticSignature&&automaticSignature!==this.signature()){this.schedule();this.publish();return;}
      this.attempted=this.signature();
    }catch(error){if(epoch===this.epoch)this.fail(error);return;}
    finally{this.setBusy(false);}
    try{
      const version=createHash('sha256').update(JSON.stringify(capture.snapshot)).digest('hex');
      const result=await this.psim.translate({text:capture.snapshot.text,target_lang:target,source_lang:'zh',purpose:'outbound',draft_request_id:randomUUID(),composer_content_version:version},identity,request.signal);
      if(this.closed||epoch!==this.epoch||!await this.waitForObservation()||epoch!==this.epoch)return;
      await this.acquireEditor();
      try{
        if(this.closed||epoch!==this.epoch)return;
        const after=await this.capture();
        if(this.closed||epoch!==this.epoch)return;
        if(!same(capture,after)){this.adopt(after);this.publish();return;}
        if(!result.data.translated_text.trim())throw new Error('EMPTY_TRANSLATION');
        this.reviewed={capture,identity,text:result.data.translated_text};this.state.preview=result.data.translated_text;this.state.phase='ready';this.publish();
      }finally{this.setBusy(false);}
      void this.flushPendingSend();
    }catch(error){if(epoch===this.epoch)this.fail(error);}finally{if(this.request===request)this.request=undefined;}
  }
  /** Send mode: a plain Enter sends the reviewed translation, waiting for it if the request is still pending. */
  private async sendShortcut(snapshot:VerifiedComposerSnapshot){
    if(this.closed||!this.foreground||this.state.outboundMode!=='send'||!snapshot.isPlainText)return;
    // Translation off, paused or not applicable, or the draft is already our translation: send it unchanged, as the vendor would.
    if(!this.translationApplies()||this.lastWritten&&sameVerifiedDraft(this.lastWritten,snapshot)){await this.sendAsIs(snapshot);return;}
    this.pendingSend=snapshot;this.state.sendPending=true;
    const reviewed=this.reviewed;
    if(this.state.phase==='ready'&&reviewed?.capture.source==='verified-editor'&&sameVerifiedDraft(reviewed.capture.snapshot,snapshot)){await this.flushPendingSend();return;}
    // An in-flight request flushes the pending send when it completes.
    if(this.state.phase!=='translating'){this.stopTimer();this.attempted=undefined;this.state.error=null;if(this.state.phase==='failed')this.state.phase='idle';this.schedule();if(!this.autoTimer)this.clearPendingSend();}
    this.publish();
  }
  private async flushPendingSend(){
    const pending=this.pendingSend,reviewed=this.reviewed;if(!pending||this.state.phase!=='ready')return;
    this.clearPendingSend();
    if(!reviewed||reviewed.capture.source!=='verified-editor'||!sameVerifiedDraft(reviewed.capture.snapshot,pending)){this.publish();return;}
    await this.replaceDraft(pending,'send');
  }
  private async sendAsIs(snapshot:VerifiedComposerSnapshot){
    if(!await this.waitForObservation()||!this.foreground)return;
    await this.acquireEditor();const epoch=this.epoch;
    try{
      const external=this.external;if(!external?.send)throw new Error('SEND_UNAVAILABLE');
      const current=await this.capture();if(epoch!==this.epoch)throw new Error('DRAFT_CHANGED');if(current.source!=='verified-editor'||!sameVerifiedDraft(current.snapshot,snapshot)){this.adopt(current);this.publish();throw new Error('DRAFT_CHANGED');}
      if(!current.snapshot.isPlainText)throw new Error('WRITE_UNAVAILABLE');
      await external.send(current.snapshot,()=>{if(this.closed||!this.foreground||epoch!==this.epoch||this.external!==external||this.state.outboundMode!=='send')throw new Error('DRAFT_CHANGED');});
      this.lastWritten=undefined;
    }catch(error){this.fail(error);}finally{this.setBusy(false);}
  }
  async replaceDraft(shortcutSnapshot?:VerifiedComposerSnapshot,intent:'replace'|'send'='replace'){
    const allowed=()=>intent==='send'?this.state.outboundMode==='send':this.state.shortcutEnabled!==false;
    const shortcutReview=shortcutSnapshot?this.reviewed:undefined;
    if(shortcutSnapshot&&(!shortcutReview||shortcutReview.capture.source!=='verified-editor'||!sameVerifiedDraft(shortcutReview.capture.snapshot,shortcutSnapshot)||!allowed()||this.state.translationPaused||this.state.phase!=='ready'))return;
    if(!await this.waitForObservation()||!this.reviewed||!this.foreground)return;
    // A user's Enter must not be dropped because a background read holds the editor.
    if(intent==='send')await this.acquireEditor();else if(this.busy)return;else this.setBusy(true);
    if(!this.reviewed||!this.foreground||shortcutSnapshot&&(this.reviewed!==shortcutReview||!allowed()||this.state.translationPaused||this.state.phase!=='ready')){this.setBusy(false);return;}
    const reviewed=this.reviewed,epoch=this.epoch;this.stopTimer();this.state.error=null;this.state.phase='replacing';this.publish();
    try{
      await this.psim.sync();
      const auth=this.psim.identity();if(!auth||auth.authGeneration!==reviewed.identity.authGeneration||auth.accountScope!==reviewed.identity.accountScope)throw new Error('AUTH_CHANGED');
      const current=await this.capture();if(!this.foreground||epoch!==this.epoch)throw new Error('DRAFT_CHANGED');if(!same(current,reviewed.capture)){this.adopt(current);this.publish();throw new Error('DRAFT_CHANGED');}
      const authorize=async()=>{
        await this.psim.sync();
        const assertCurrent=()=>{const latest=this.psim.identity();
          if(this.closed||!this.foreground||shortcutSnapshot&&(!allowed()||this.state.translationPaused)||epoch!==this.epoch||this.external?.targetInstanceId!==this.state.targetInstanceId||!latest||latest.authGeneration!==reviewed.identity.authGeneration||latest.accountScope!==reviewed.identity.accountScope)throw new Error('AUTH_CHANGED');
        };
        assertCurrent();return assertCurrent;
      };
      if(current.source==='verified-editor'){if(!current.snapshot.isPlainText)throw new Error('WRITE_UNAVAILABLE');if(intent==='send'&&!this.external!.send)throw new Error('SEND_UNAVAILABLE');await this.external!.replace(current.snapshot,reviewed.text,authorize);}else{if(intent==='send')throw new Error('SEND_UNAVAILABLE');if(!current.snapshot.canReplace)throw new Error('WRITE_UNAVAILABLE');await this.native.replaceDraft(current.snapshot,reviewed.text);}
      const after=await this.capture();if(epoch!==this.epoch||after.snapshot.text!==reviewed.text)throw new Error('DRAFT_READBACK_MISMATCH');
      this.adopt(after,false);
      if(epoch!==this.epoch)throw new Error('DRAFT_CHANGED');
      if(current.source==='verified-editor'&&(after.source!=='verified-editor'||after.snapshot.conversationId!==current.snapshot.conversationId||after.snapshot.scopeGeneration!==current.snapshot.scopeGeneration||after.snapshot.platformAccountScope!==current.snapshot.platformAccountScope||after.snapshot.documentGeneration!==current.snapshot.documentGeneration||after.snapshot.editorIdentity!==current.snapshot.editorIdentity||after.snapshot.composerId!==current.snapshot.composerId))throw new Error('DRAFT_CHANGED');
      this.lastWritten=after.source==='verified-editor'?after.snapshot:undefined;
      this.suppressed=this.signature(after);this.attempted=this.suppressed;this.reviewed=undefined;this.state.preview=null;this.state.phase='replaced';
      if(intent==='send'&&after.source==='verified-editor'){this.publish();await this.external!.send!(after.snapshot,authorize);this.lastWritten=undefined;this.state.phase='idle';}
      this.publish();
    }catch(error){this.invalidate();this.fail(error);}finally{this.setBusy(false);}
  }
  async queryOrder(identifier:string){
    if(typeof identifier!=='string'||!identifier.trim()||identifier.length>128||/[\r\n\u0000]/.test(identifier))throw new Error('INVALID_ORDER_IDENTIFIER');
    await this.sessionStarting;
    if(this.closed||!this.foreground||!this.external||this.captured?.source!=='verified-editor'||!this.state.messageSurface?.active)throw new Error('MESSAGE_PAGE_REQUIRED');
    this.clearOrder();const generation=this.orderGeneration,context=this.context(),identity=this.psim.identity(),request=new AbortController();
    if(!identity)throw new Error('PSIM_LOGIN_REQUIRED');
    this.orderRequest=request;this.order={identifier:identifier.trim(),status:'loading',fields:[],error:null};this.publish();
    const current=()=>!this.closed&&!request.signal.aborted&&generation===this.orderGeneration&&context===this.context()&&this.psim.identity()?.authGeneration===identity.authGeneration&&this.psim.identity()?.accountScope===identity.accountScope;
    try{
      if(!await this.waitForObservation()||!current())return;
      await this.acquireEditor();
      try{const capture=await this.capture();if(!current())return;this.adopt(capture);this.publish();if(!current())return;}finally{this.setBusy(false);}
      const result=await this.psim.queryOriginalIdentifier(identifier.trim(),request.signal);
      if(!current())return;
      await this.acquireEditor();
      try{const capture=await this.capture();if(!current())return;this.adopt(capture);this.publish();if(!current())return;}finally{this.setBusy(false);}
      this.order={identifier:result.identifier,status:result.found?'ready':'empty',fields:result.fields,error:null};this.publish();
    }catch(error){if(current()){const code=error instanceof Error?error.message:'';const reasons:Record<string,string>={PSIM_LOGIN_REQUIRED:'请先登录 TSim 客服后查询订单。',AUTH_CHANGED:'登录状态已变化，请重新登录后查询。',ORDER_PERMISSION_REQUIRED:'当前账号没有订单查询权限。',INVALID_ORDER_IDENTIFIER:'请输入有效的订单 ID（字母、数字、下划线或横线）。',ORDER_QUERY_FAILED:'订单服务暂时不可用，请稍后重试。',ORDER_RESPONSE_INVALID:'订单服务返回了无法识别的结果，请稍后重试。'};this.order={identifier:identifier.trim(),status:'failed',fields:[],error:reasons[code]??'订单查询未完成，请检查连接后重试。'};this.publish();}}
    finally{if(this.orderRequest===request)this.orderRequest=undefined;}
  }
  async openLogin(){try{await this.psim.openLogin();}catch(error){this.fail(error);}}
  async logout(){try{await this.psim.logout();}catch(error){this.fail(error);}}
  async dispose(){this.closed=true;this.connectionAbort?.abort();this.clearPendingSend();this.clearOrder();this.updatePolling();this.invalidate();this.listeners.clear();this.retireInteractions();const external=this.external;this.external=undefined;await external?.close().catch(()=>{});await this.psim.dispose();}
}
