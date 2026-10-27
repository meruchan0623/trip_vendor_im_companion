import {ownedLoginURL,isLoginPopoverId,type LoginPopover} from '../src/shared/owned-login';
import { randomUUID, createHash } from 'node:crypto';
import { BrowserProfileSessionService, type BrowserProfileSessionOptions } from './browser-profile-session';
import { isCustomerLanguage, isOrderWindowIntent, type OrderWindowIntent, isOutboundMode, isPanelTarget, sameVerifiedDraft, type OutboundMode, type PanelTarget, type PanelOrderState, type PsimIdentity, type OperatorSessionGrant, type VerifiedComposerSnapshot } from '../src/shared/workbench';
import type { StandaloneState, OrderEntry } from '../src/shared/companion-api';
import type {NativeInteraction} from '../runtime/native-composer';
import type { NativeAdapter, NativeDraftSnapshot, WindowState } from './native-adapter';
import { connectExternalComposer, type ExternalComposer } from './external-composer';
import { embeddedPanelState, invokeEmbeddedAction } from './embedded-host';
import {collectingCustomerLanguage,emptyLanguageCounts,isCustomerLanguageResolution,resolveCustomerLanguage,unavailableCustomerLanguage,type CustomerLanguageResolution} from '../src/shared/customer-language';
import {createOutboundWaitController,type OutboundWaitController,type OutboundWaitPersisted} from '../runtime/outbound-wait-controller';
import type {OutboundWaitStore} from './outbound-wait-store';
import type {TranslationOptionsStore} from './translation-options-store';
import type {BrowserProfile} from './browser-profile-session';
import type {OperatorSelection} from './system-browser';
import {reportVendorProgress} from './vendor-progress';
import {isOrderSummaryIntent,parseOrderSummaryResult,type OrderSummaryFailure,type OrderSummaryIntent,type OrderSummaryResult} from '../src/shared/order-summary';
import type {RuntimeLogEntry} from './runtime-diagnostics';
import {createTelemetry,runWithTelemetry,currentTelemetry,setTelemetry,timeTelemetry,finishTelemetry,type TelemetryTrace} from './translation-telemetry';

type Captured = {source:'uia';snapshot:NativeDraftSnapshot} | {source:'verified-editor';snapshot:VerifiedComposerSnapshot;currentOrderHint?:StandaloneState['currentOrderHint'];orderEntries:OrderEntry[];orderViewport:StandaloneState['orderViewport'];messageSurface:StandaloneState['messageSurface']};
const same=(a:Captured,b:Captured)=>a.source===b.source&&(a.source==='uia'?JSON.stringify(a.snapshot)===JSON.stringify(b.snapshot):sameVerifiedDraft(a.snapshot,b.snapshot as VerifiedComposerSnapshot));
const ORDER_FAILURES:Record<string,string>={PSIM_LOGIN_REQUIRED:'请先登录 TSim 账号后查询订单。',AUTH_CHANGED:'登录状态已变化，请重新登录后查询。',ORDER_PERMISSION_REQUIRED:'当前 TSim 账号没有订单查询权限。',INVALID_ORDER_IDENTIFIER:'请输入有效的订单 ID（字母、数字、下划线或横线）。',ORDER_QUERY_FAILED:'订单服务暂时不可用，请稍后重试。',ORDER_LIST_RESPONSE_INVALID:'订单服务返回了无法识别的结果，请稍后重试。',ORDER_DETAIL_RESPONSE_INVALID:'订单服务返回了无法识别的结果，请稍后重试。',ORDER_RESPONSE_INVALID:'订单服务返回了无法识别的结果，请稍后重试。',INVALID_READ_IDENTIFIER:'订单服务返回了无法识别的结果，请稍后重试。',SERVICE_RESPONSE_TOO_LARGE:'订单结果过大，无法在助手内显示。'};
const messages:Record<string,string>={
  TRANSLATION_OPTIONS_READ_FAILED:'无法读取兜底语言设置，请重新选择并保存。',
  TRANSLATION_OPTIONS_INVALID:'兜底语言设置无效，请重新选择并保存。',
  TRANSLATION_OPTIONS_SAVE_FAILED:'兜底语言保存失败，仍保留原设置，请重试。',
  MESSAGE_PAGE_INACTIVE:'请先切换到旅游商家的“消息”页面并打开客户会话。',
  CONVERSATION_SOURCE_UNVERIFIED:'客户会话正在切换，请稍后重新查询。',
  PSIM_LOGIN_REQUIRED:process.platform==='darwin'?'请先在助手内登录 TSim 账号，再使用翻译与订单查询。':'请先在 Edge 或 Chrome 登录 TSim_CS，助手将自动复用浏览器会话。',
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
  BROWSER_SESSION_ACCESS_DENIED:'系统阻止读取浏览器登录态。请检查浏览器数据的访问权限，再重试。',
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
  browser_accessibility_required:'请在 macOS 系统设置 → 隐私与安全性 → 辅助功能中允许旅游商家助手或 TravelMerchant.WindowHelper 控制订单窗口，然后重新查询。',
  BROWSER_PROFILE_REQUIRED:'请先在已绑定的 Edge 或 Chrome 中登录 TSim_CS，再查询订单。',
  ORDER_CONTEXT_CHANGED:'客户会话或登录态已变化，请重新点击订单号。',
  BROWSER_SPACE_TOO_SMALL:'订单查询空间不足，请先放大商家窗口，再打开订单。',
  NATIVE_SEND_FAILED:'未能自动发送，请确认输入框内容后再按 Enter。',
  SEND_UNAVAILABLE:'当前编辑器不支持自动发送，请切换为替换模式。',
};
export const CUSTOMER_LANGUAGE_RESOLUTION_TIMEOUT_MS=5000;
/** Idle lease renewal cadence: four attempts inside the 6 s page and native leases. */
const LEASE_RENEW_MS=1500;
const DRAFT_SETTLE_MS=120;
/** A verified capture this recent, under the same epoch, lets the operator grant skip a second read. */
export const OPERATOR_CAPTURE_FRESH_MS=1000;
export type SessionPort=Pick<BrowserProfileSessionService,'identity'|'sync'|'setBackgroundPolling'|'getBrowserProfile'|'operatorGrant'|'translate'|'queryOriginalIdentifier'|'openLogin'|'logout'|'dispose'|'outboundWaitBounds'>&Partial<Pick<BrowserProfileSessionService,'queryOrderSummary'>>;
/**
 * Order card cache: a settled snapshot answers repeat views of the same order for a minute; an explicit
 * refresh younger than ORDER_SUMMARY_REFRESH_MS reuses it too, so repeated clicks cannot flood perform (60/min).
 * In-flight reads are always joined; failures are never cached.
 */
const ORDER_SUMMARY_TTL_MS=60_000,ORDER_SUMMARY_REFRESH_MS=3000,ORDER_SUMMARY_ENTRIES=20;
const ORDER_SUMMARY_FAILURES:Record<string,OrderSummaryFailure>={PSIM_LOGIN_REQUIRED:'login',PSIM_HTTP_401:'login',PSIM_HTTP_423:'login',PROFILE_UNVERIFIED:'login',ORDER_PERMISSION_REQUIRED:'permission',PSIM_HTTP_403:'permission',PSIM_HTTP_422:'permission',RATE_LIMITED:'rate_limited',PSIM_HTTP_429:'rate_limited'};
type OrderSummaryEntry={at:number;scope:string;controller:AbortController;promise:Promise<OrderSummaryResult>;settled?:OrderSummaryResult};
export type SessionFactory=(changed:(identity:PsimIdentity|null)=>void,options:BrowserProfileSessionOptions)=>SessionPort;
export interface OrderWindowPort {open(selection:OperatorSelection,profile:BrowserProfile,authorize:()=>Promise<boolean>):Promise<void>;close():Promise<void>}
export class CompanionService {
  private orderWindowGeneration=0;
  private orderClosing:Promise<void>=Promise.resolve();
  private invalidateOrderWindow(){++this.orderWindowGeneration;this.state.browserOpen=false;const closing=this.orderWindow?.close();if(closing)this.orderClosing=Promise.all([this.orderClosing,closing]).then(()=>{}).catch(()=>{if(!this.closed)this.reportBrowserFailure('BROWSER_CLEANUP_UNCONFIRMED');});}
  async closeOrder(){if(this.state.sessionMode==='owned')this.clearOrder();else this.invalidateOrderWindow();await this.orderClosing;this.publish();}
  private loginPopover:LoginPopover|undefined;
  private loginGeneration=0;
  private loginOpening:{epoch:number;generation:number}|undefined;
  private state:StandaloneState={attached:false,targetInstanceId:null,nativeStatus:'starting',auth:'connecting',accountScope:'unknown',draft:null,preview:null,phase:'idle',error:null,language:'en',customerLanguage:'unknown',fallbackTarget:'en',customerLanguageResolution:unavailableCustomerLanguage(),followCustomerLanguage:true,autoTranslate:true,shortcutEnabled:true,outboundMode:'send',sendPending:false,translationPaused:false,browserOpen:false,composerSource:'unavailable',orderEntries:[],orderViewport:null,messageSurface:{active:false,composerRect:null,toolbarRect:null}};
  private listeners=new Set<(state:StandaloneState)=>void>();
  private psim:SessionPort;
  private sessionStarting:Promise<void>;
  private translationOptionsStarting:Promise<void>;
  private external?:ExternalComposer;
  /** Settles when the attempt ends or starts waiting for the vendor page; set for the attempt's whole life. */
  private externalConnecting?:Promise<void>;
  private connectingAttempt?:{release:()=>void};
  private stopInteraction?:()=>void;
  private stopInvalidation?:()=>void;
  private embeddedPublishing=false;
  private embeddedDirty=false;
  private embeddedPublication:Promise<void>=Promise.resolve();
  private previewAcknowledgements=new WeakMap<object,number>();
  private previewTelemetry=new WeakMap<TelemetryTrace,{review:object;publishedAt:number}>();
  private telemetrySignals=new WeakMap<TelemetryTrace,AbortSignal>();
  private nextConnectAt=0;
  private connectionEpoch=0;
  private connectionAttempts=0;
  private connectionAbort?:AbortController;
  /** The connection whose verified socket is waiting for the vendor IM page; that wait is not busy. */
  private waitingConnection?:AbortController;
  private reconnecting?:{id:string;epoch:number;controller:AbortController;promise:Promise<ExternalComposer|undefined>;ready?:ExternalComposer;claimed:boolean;disposed:boolean};
  private dropReconnect(){const pending=this.reconnecting;this.reconnecting=undefined;if(!pending)return;pending.controller.abort();if(pending.ready&&!pending.claimed&&!pending.disposed){pending.disposed=true;void pending.ready.close().catch(()=>{});}}
  private order:PanelOrderState={identifier:'',status:'idle',error:null,fields:[]};
  private orderGeneration=0;
  private orderRequest?:AbortController;
  private clearOrder(){this.invalidateOrderWindow();++this.orderGeneration;this.orderRequest?.abort();this.orderRequest=undefined;this.order={identifier:'',status:'idle',error:null,fields:[]};}
  private customerResolutionTimer?:ReturnType<typeof setTimeout>;
  private customerResolutionGeneration=0;
  private automaticTarget(){return isPanelTarget(this.state.customerLanguage)?this.state.customerLanguage:this.state.customerLanguageResolution?.status==='fallback'?this.state.fallbackTarget??'en':undefined;}
  private applyAutomaticTarget(){if(this.state.followCustomerLanguage===false)return;const target=this.automaticTarget();if(target)this.state.language=target;}
  private invalidateLanguage(){this.clearPendingSend();this.translationIntent++;this.invalidate();this.attempted=undefined;this.suppressed=undefined;}
  private resetCustomerLanguage(collecting=true){
    clearTimeout(this.customerResolutionTimer);const generation=++this.customerResolutionGeneration;
    this.state.customerLanguage='unknown';this.state.customerLanguageResolution=collecting?collectingCustomerLanguage():unavailableCustomerLanguage();this.state.followCustomerLanguage=true;this.state.language=this.state.fallbackTarget??'en';this.translationIntent++;this.attempted=undefined;this.suppressed=undefined;
    if(!collecting){this.customerResolutionTimer=undefined;return;}
    this.customerResolutionTimer=setTimeout(()=>{this.customerResolutionTimer=undefined;if(this.closed||generation!==this.customerResolutionGeneration||this.state.customerLanguageResolution?.status!=='collecting')return;this.state.customerLanguageResolution=unavailableCustomerLanguage();if(this.state.followCustomerLanguage!==false){this.invalidateLanguage();this.applyAutomaticTarget();this.schedule();}this.publish();},CUSTOMER_LANGUAGE_RESOLUTION_TIMEOUT_MS);
  }
  private contextChanged(){this.contextRevision++;this.inputObservedAt=undefined;this.inputDueAt=undefined;this.inputDeferredAt=undefined;this.inputDeferredMs=0;this.invalidate();this.state.currentOrderHint=null;this.lastWritten=undefined;this.clearPendingSend();this.resetCustomerLanguage();this.clearOrder();this.onContextChanged();}
  // Both platforms show the TSim operator inside the merchant page; the host only grants its session.
  private embeddedState(){return {...embeddedPanelState(this.getState(),this.captured?.source==='verified-editor'?this.context():null),...(this.loginPopover?{loginPopover:{...this.loginPopover}}:{})};}
  private retireComposer(composer:ExternalComposer){
    if(this.external!==composer||this.closed)return;
    this.loginGeneration++;this.loginPopover=undefined;this.translationIntent++;this.invalidate();this.captured=undefined;
    this.state.draft=null;this.state.orderEntries=[];this.state.currentOrderHint=null;this.state.orderViewport=null;
    this.state.messageSurface={active:false,composerRect:null,toolbarRect:null};this.state.composerSource='unavailable';
    // Retiring an in-flight mount transfers cleanup/socket ownership to reconnect.
    // A late rejection must neither keep polling blocked nor close its successor.
    this.connectingAttempt=undefined;this.externalConnecting=undefined;
    this.retireInteractions();this.external=undefined;this.nextConnectAt=Date.now()+1000;
    if(composer.reconnect&&this.state.targetInstanceId){
      this.dropReconnect();const controller=new AbortController();this.connectionAbort=controller;
      const pending:NonNullable<CompanionService['reconnecting']>={id:this.state.targetInstanceId,epoch:this.connectionEpoch,controller,promise:Promise.resolve(undefined),claimed:false,disposed:false};this.reconnecting=pending;
      pending.promise=composer.reconnect(controller.signal,()=>this.composerWaiting(controller)).then(async next=>{
        if(this.closed||controller.signal.aborted||this.reconnecting!==pending||pending.id!==this.state.targetInstanceId||pending.epoch!==this.connectionEpoch){if(!pending.disposed){pending.disposed=true;await next.close().catch(()=>{});}return undefined;}
        pending.ready=next;return next;
      }).catch(()=>undefined);this.nextConnectAt=Date.now();
    }else void composer.close().catch(()=>{});
    this.verifiedContext=undefined;this.verifiedCustomerContext=undefined;this.contextChanged();this.publish();
  }
  private publishEmbedded(){
    this.embeddedDirty=true;if(this.embeddedPublishing)return;this.embeddedPublishing=true;
    this.embeddedPublication=(async()=>{try{while(this.embeddedDirty&&!this.closed){this.embeddedDirty=false;const external=this.external,review=this.reviewed,next=this.embeddedState();if(external?.updateWorkbench)try{const previewUpdated=await external.updateWorkbench(next);if(previewUpdated===true&&review&&next.preview===review.text&&!this.previewAcknowledgements.has(review))this.previewAcknowledgements.set(review,performance.now());}catch{this.retireComposer(external);}}}finally{this.embeddedPublishing=false;}})();
  }
  private interactionRefresh=false;
  private interactionTask?:Promise<void>;
  private nativeOptions?:string;
  private nativeInteractionFlags?:string;
  /** Whether an outbound translation is expected for the current draft; otherwise Enter stays with the vendor. */
  private translationApplies(){return this.state.autoTranslate!==false&&!this.state.translationPaused&&this.state.auth==='ready'&&(this.state.followCustomerLanguage===false||!!this.automaticTarget());}
  private syncInteractionOptions(){const external=this.external;if(!external?.setInteractionOptions)return;const flags={shortcutEnabled:this.state.shortcutEnabled!==false,enterSend:this.foreground&&this.state.outboundMode==='send'&&this.translationApplies()},flagKey=JSON.stringify(flags);if(flagKey!==this.nativeInteractionFlags){this.nativeInteractionFlags=flagKey;this.clearPendingSend();}const options={...flags,sendGeneration:this.nativeSendGeneration},key=JSON.stringify(options);if(key===this.nativeOptions)return;this.nativeOptions=key;void external.setInteractionOptions(options).catch(()=>{if(this.external===external)this.nativeOptions=undefined;});}
  private retireInteractions(){this.stopInteraction?.();this.stopInteraction=undefined;this.stopInvalidation?.();this.stopInvalidation=undefined;this.nativeOptions=undefined;this.nativeInteractionFlags=undefined;this.interactionRefresh=false;this.interactionTask=undefined;}
  private interaction(event:NativeInteraction,external:ExternalComposer){
    if(this.closed||external!==this.external)return;
    if(event.type==='replace-shortcut'){if(this.state.shortcutEnabled!==false&&this.state.phase==='ready'&&!this.state.translationPaused&&this.state.auth==='ready'&&this.foreground&&this.reviewed?.capture.source==='verified-editor'&&sameVerifiedDraft(this.reviewed.capture.snapshot,event.snapshot))void this.replaceDraft(event.snapshot);return;}
    if(event.type==='send-shortcut'){if(event.sendGeneration===this.nativeSendGeneration)void this.sendShortcut(event.snapshot);return;}
    if(event.type!=='draft-changed')return;
    this.markInput('native-event');this.inputEventPending=true;
    // Revoke immediately, before CDP reads or the 500 ms safety observation can finish.
    // The notice carries no content, so it is handled as a revision of the same draft: a request already
    // handed to the session may finish. The settle read below classifies the edit; adopt() aborts that
    // request for a cleared draft or another conversation/editor, and every other path still aborts at once.
    this.clearPendingSend(false);this.translationIntent++;this.reviseDraft();this.attempted=undefined;this.suppressed=undefined;this.interactionRefresh=true;this.publish();
    if(this.interactionTask)return;
    const task=(async()=>{while(this.interactionRefresh&&!this.closed&&this.external===external){
      // Coalesce a typing burst into one read; every read also runs script in the vendor renderer.
      await new Promise(resolve=>setTimeout(resolve,DRAFT_SETTLE_MS));if(this.closed||this.external!==external)return;
      this.interactionRefresh=false;if(!this.foreground)return;await this.acquireEditor();const epoch=this.epoch,id=this.state.targetInstanceId;try{if(this.closed||external!==this.external)continue;const capture=await this.capture();if(this.closed||external!==this.external||epoch!==this.epoch||id!==this.state.targetInstanceId)continue;this.adopt(capture);this.publish();}catch{/* The fallback observation handles source recovery. */}finally{this.setBusy(false);}}})();
    this.interactionTask=task;void task.finally(()=>{if(this.interactionTask===task)this.interactionTask=undefined;});
  }
  private captured?:Captured;
  /** When `captured` was last adopted as verified; any `invalidate()` (epoch change, account switch, reset) drops it. */
  private verifiedAt?:{at:number;capture:Captured;epoch:number;target:string|null;external:ExternalComposer;accountScope?:string;authGeneration?:number};
  /** Survives temporary capture failures so recovery can distinguish the same customer from a new one. */
  private verifiedContext?:string;
  private verifiedCustomerContext?:string;
  private sessionIdentity?:string;
  private reviewed?:{capture:Captured;identity:PsimIdentity;text:string;telemetryId?:string};
  /** The draft the user pressed Enter on in send mode, waiting for its translation. */
  private pendingSend?:{snapshot:VerifiedComposerSnapshot;generation:number};
  /** A revoked Enter stays revoked even if focus or send mode returns during an await. */
  private sendIntentGeneration=0;
  /** Native delivery authorization survives earlier draft-change notices in the same drain batch. */
  private nativeSendGeneration=0;
  /** The last draft this service wrote; Enter sends it as is instead of translating it again. */
  private lastWritten?:VerifiedComposerSnapshot;
  private clearPendingSend(revokeNative=true){this.sendIntentGeneration++;if(revokeNative)this.nativeSendGeneration++;this.pendingSend=undefined;this.state.sendPending=false;}
  private epoch=0; private request?:AbortController; private closed=false;
  /** The translation request currently handed to the session; `revision` is aborted when a newer revision of the same draft supersedes it. */
  private outbound?:{request:AbortController;revision:AbortController};
  /** At most one superseded outbound request, allowed to finish; its result fails the epoch check. invalidate() aborts it. */
  private superseded?:AbortController;
  private busy=false; private foreground=false; private poll?:ReturnType<typeof setInterval>;
  private editorIdle:Promise<void>=Promise.resolve();
  private releaseEditor?:()=>void;
  private setBusy(value:boolean){this.busy=value;if(value)this.editorIdle=new Promise(resolve=>{this.releaseEditor=resolve;});else{this.releaseEditor?.();this.releaseEditor=undefined;}}
  private async acquireEditor(){while(this.busy)await this.editorIdle;this.setBusy(true);}
  private observation?:Promise<void>;
  private waitController!:OutboundWaitController;
  private waitScope:string|null=null;
  private waitLoading=false;
  private waitStarting:Promise<void>=Promise.resolve();
  private outboundSeq=0;
  private translationPreparing=false;
  private manualPending?:{signature:string;target:PanelTarget;intent:number;sendGeneration?:number};
  private waitStoreFailure(error:unknown){const code=error instanceof Error&&/^OUTBOUND_WAIT_[A-Z_]+$/.test(error.message)?error.message:'OUTBOUND_WAIT_STORE_FAILED';console.warn(JSON.stringify({event:'outbound-wait-store-failed',code}));}
  private newWaitController(scope:string|null,persisted:OutboundWaitPersisted|null=null){
    return createOutboundWaitController({clock:{now:()=>performance.now(),setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>)},
      persisted,bounds:this.psim?.outboundWaitBounds?.()??null,onDue:()=>this.translateDue(),
      onPersist:state=>{if(scope&&this.waitScope===scope&&!this.closed)void this.outboundWaitStore?.save(scope,state).catch(error=>this.waitStoreFailure(error));}});
  }
  private switchWaitScope(scope:string|null){
    if(this.waitController&&scope===this.waitScope)return;
    this.waitController?.dispose();this.waitScope=scope;const controller=this.waitController=this.newWaitController(scope);
    this.waitLoading=!!scope&&!!this.outboundWaitStore;
    this.waitStarting=(this.waitLoading?this.outboundWaitStore!.load(scope!).catch(error=>{this.waitStoreFailure(error);return null;}):Promise.resolve(null)).then(saved=>{
      if(this.closed||this.waitController!==controller)return;
      if(saved){controller.dispose();this.waitController=this.newWaitController(scope,saved);}
      this.waitLoading=false;this.schedule();
    });
  }
  private applyWaitBounds(){this.waitController.applyBounds(this.psim?.outboundWaitBounds?.()??null);}
  /** Numeric diagnostics only: no draft, translation, customer or conversation identifiers. */
  getOutboundWaitDiagnostics(){return this.waitController.snapshot();}
  private attempted?:string;
  private translationIntent=0;
  private suppressed?:string;
  private pausedContext?:string;
  private renewing=false;
  /** Last read or renew start. Each read already renews both 6 s leases. */
  private leaseAt=0;
  private context(capture=this.captured){return capture?JSON.stringify(capture.source==='verified-editor'?[this.state.targetInstanceId,capture.snapshot.conversationId,capture.snapshot.scopeGeneration,capture.snapshot.platformAccountScope]:[this.state.targetInstanceId,capture.snapshot.editorIdentity]):'';}
  /** Language and pause preferences belong to the customer, across editor remounts. */
  private customerContext(capture=this.captured){return capture?.source==='verified-editor'?JSON.stringify([this.state.targetInstanceId,capture.snapshot.conversationId,capture.snapshot.platformAccountScope,capture.snapshot.documentGeneration]):this.context(capture);}
  private signature(capture=this.captured){return capture?JSON.stringify([capture.source,capture.snapshot,this.state.language,this.state.accountScope]):'';}
  private stopTimer(){this.waitController.cancel();this.manualPending=undefined;}
  private canSchedule(){
    const capture=this.captured;
    return !(this.state.followCustomerLanguage!==false&&!this.automaticTarget())&&!this.closed&&!this.waitLoading&&this.foreground&&this.state.autoTranslate&&!this.state.translationPaused&&this.state.auth==='ready'&&capture?.source==='verified-editor'&&capture.snapshot.isPlainText&&!!capture.snapshot.text.trim();
  }
  private schedule(immediate=false){
    if(!this.canSchedule()){this.waitController.cancel();return;}
    if(this.signature()===this.attempted||this.signature()===this.suppressed)return;
    this.state.phase='waiting';
    // Enter reserves the latest verified draft immediately, while the old HTTP request retains the only slot.
    if(immediate&&this.pendingSend&&(this.translationPreparing||this.waitController.snapshot().inFlightId!==null))this.manualPending={signature:this.signature(),target:this.state.language,intent:this.translationIntent,sendGeneration:this.pendingSend.generation};
    if(immediate&&!this.waitController.snapshot().inFlightId&&!this.translationPreparing&&!(this.captured?.source==='verified-editor'&&this.captured.snapshot.composing)){this.waitController.cancel();this.translateDue();return;}
    if(!this.waitController.snapshot().pending)this.waitController.onEdit('typing');
    this.inputDueAt=this.waitController.snapshot().dueAt??undefined;
  }
  private translateDue(){
    if(!this.canSchedule()||this.signature()===this.attempted||this.signature()===this.suppressed)return;
    if(this.captured?.source==='verified-editor'&&this.captured.snapshot.composing)return;
    if(this.busy||this.externalConnecting||this.translationPreparing){this.waitController.onEdit('typing');this.inputDueAt=this.waitController.snapshot().dueAt??undefined;return;}
    const key=this.signature();this.attempted=key;void this.translate(this.state.language,key);
  }
  async setTranslationOptions(options:{fallbackTarget?:PanelTarget;language?:PanelTarget;autoTranslate?:boolean;shortcutEnabled?:boolean;outboundMode?:OutboundMode}){
    if(options.fallbackTarget!==undefined){
      if(!isPanelTarget(options.fallbackTarget))throw new Error('INVALID_FALLBACK_TARGET');await this.translationOptionsStarting;
      try{await this.translationOptionsStore?.save({fallbackTarget:options.fallbackTarget});}catch{const error=new Error('TRANSLATION_OPTIONS_SAVE_FAILED');this.fail(error);throw error;}
      if(this.closed)return;const previous=this.automaticTarget();this.state.fallbackTarget=options.fallbackTarget;if(this.state.followCustomerLanguage!==false&&previous!==this.automaticTarget()){this.invalidateLanguage();this.applyAutomaticTarget();}this.state.error=null;
    }
    if(options.outboundMode!==undefined){if(!isOutboundMode(options.outboundMode))throw new Error('INVALID_OUTBOUND_MODE');if(options.outboundMode!==this.state.outboundMode){this.clearPendingSend();this.state.outboundMode=options.outboundMode;}}
    if(options.shortcutEnabled!==undefined){if(typeof options.shortcutEnabled!=='boolean')throw new Error('INVALID_SHORTCUT_OPTION');this.state.shortcutEnabled=options.shortcutEnabled;}
    if(options.language!==undefined&&!isPanelTarget(options.language))throw new Error('INVALID_LANGUAGE');
    if(options.language!==undefined){if(this.state.followCustomerLanguage!==false)this.clearPendingSend();this.state.followCustomerLanguage=false;}
    if(options.language!==undefined&&options.language!==this.state.language){this.clearPendingSend();this.translationIntent++;this.invalidate();this.state.language=options.language;this.suppressed=undefined;this.attempted=undefined;this.state.error=null;}
    if(options.autoTranslate!==undefined&&options.autoTranslate!==this.state.autoTranslate){this.clearPendingSend();this.translationIntent++;this.invalidate();this.state.autoTranslate=options.autoTranslate;this.attempted=undefined;}
    this.schedule();this.publish();
  }
  async reportCustomerLanguage(language:string,conversationKey:string,resolution?:CustomerLanguageResolution){
    if(!isCustomerLanguage(language)||resolution!==undefined&&!isCustomerLanguageResolution(resolution,language)||conversationKey!==this.context()||!this.external||!this.state.messageSurface?.active)return;
    if(!await this.waitForObservation())return;await this.acquireEditor();
    const epoch=this.epoch,customerContext=this.verifiedCustomerContext;
    try{const capture=await this.capture();if(epoch!==this.epoch||this.closed)return;this.adopt(capture);if(conversationKey!==this.context(capture)||customerContext!==undefined&&customerContext!==this.customerContext(capture)){this.publish();return;}clearTimeout(this.customerResolutionTimer);this.customerResolutionTimer=undefined;const previousLanguage=this.state.customerLanguage,previousStatus=this.state.customerLanguageResolution?.status;this.state.customerLanguageResolution=resolution?structuredClone(resolution):language==='unknown'?unavailableCustomerLanguage():resolveCustomerLanguage(language,emptyLanguageCounts());this.state.customerLanguage=language;if(this.state.followCustomerLanguage!==false&&(previousLanguage!==language||previousStatus!==this.state.customerLanguageResolution.status)){this.invalidateLanguage();this.applyAutomaticTarget();this.schedule();}this.publish();}catch(error){if(epoch===this.epoch&&!this.closed)this.fail(error,true);}finally{this.setBusy(false);}
  }
  async followCustomerLanguage(){if(this.state.followCustomerLanguage!==false)return;this.clearPendingSend();this.state.followCustomerLanguage=true;this.translationIntent++;this.invalidate();this.attempted=undefined;this.suppressed=undefined;this.applyAutomaticTarget();this.schedule();this.publish();}
  async cancelTranslation(){this.clearPendingSend();this.translationIntent++;this.pausedContext=this.customerContext();this.state.translationPaused=true;this.invalidate();this.state.phase='idle';this.state.error=null;this.publish();}
  async resumeTranslation(){this.translationIntent++;this.pausedContext=undefined;this.state.translationPaused=false;this.attempted=undefined;this.suppressed=undefined;this.invalidate();this.state.phase='idle';this.schedule();this.publish();}

  private sessionError:string|null=null;
  private sourceFailure=false;
  private surfaceMeasurementRevision=0;
  private inputRevision=0;
  private contextRevision=0;
  private inputObservedAt:number|undefined;
  private inputTimingSource:'native-event'|'capture'|'manual'='capture';
  private inputEventPending=false;
  private inputDueAt:number|undefined;
  private inputDeferredAt:number|undefined;
  private inputDeferredMs=0;
  private markInput(source:'native-event'|'capture'){
    this.inputRevision++;this.inputObservedAt=performance.now();this.inputTimingSource=source;
    this.inputDeferredAt=this.waitController.snapshot().inFlightId!==null?this.inputObservedAt:undefined;this.inputDeferredMs=0;
  }
  private telemetryFailure(error:unknown){
    const code=error instanceof Error?error.message:'SERVICE_UNAVAILABLE';
    const reason=/AUTH_CHANGED/.test(code)?'auth-changed':/LOGIN|HTTP_401|HTTP_423/.test(code)?'login-required':/PERMISSION|HTTP_403/.test(code)?'permission-required':/TIMEOUT/.test(code)?'timeout':/429|RATE_LIMITED/.test(code)?'rate-limited':/ABORT|SUPERSEDED/.test(code)?'aborted':/DRAFT_CHANGED/.test(code)?'draft-changed':/READBACK|ECHO|INVALID.*RESPONSE/.test(code)?'invalid-response':'request-failed';
    setTelemetry({code,reason,outcome:reason==='rate-limited'?'rate-limited':reason==='aborted'?'cancelled':'failed'});
  }
  constructor(private native:NativeAdapter,openLoginURL:(url:string)=>Promise<void>,private onContextChanged:()=>void=()=>{},sessionOptions:BrowserProfileSessionOptions={},private embeddedMode=false,sessionFactory:SessionFactory=(changed,options)=>new BrowserProfileSessionService(changed,options),private translationOptionsStore?:TranslationOptionsStore,private orderWindow?:OrderWindowPort,private outboundWaitStore?:OutboundWaitStore,private runtimeLogs:()=>RuntimeLogEntry[]=()=>[]){
    this.switchWaitScope(null);
    this.state.sessionMode=process.platform==='darwin'?'owned':'browser';
    this.translationOptionsStarting=(translationOptionsStore?.load()??Promise.resolve({fallbackTarget:'en' as const})).then(options=>{if(this.closed)return;const previous=this.automaticTarget();this.state.fallbackTarget=options.fallbackTarget;if(this.state.followCustomerLanguage!==false&&previous!==this.automaticTarget()){this.invalidateLanguage();this.applyAutomaticTarget();this.schedule();}this.publish();}).catch(error=>{if(!this.closed)this.fail(error);});
    this.psim=sessionFactory(identity=>{
      // Enter authorizes one review under the current login, never a later session.
      this.clearPendingSend();
      const sessionIdentity=identity?.accountScope;
      if(sessionIdentity!==undefined&&this.sessionIdentity!==undefined&&sessionIdentity!==this.sessionIdentity){this.contextChanged();this.verifiedContext=undefined;this.verifiedCustomerContext=undefined;}
      if(sessionIdentity!==undefined)this.sessionIdentity=sessionIdentity;
      this.clearOrder();this.invalidate();this.attempted=undefined;this.suppressed=undefined;this.state.auth=identity?'ready':'connecting';this.state.accountScope=identity?.accountScope??'unknown';this.switchWaitScope(identity?.accountScope??null);
      if(identity&&[messages.BROWSER_BRIDGE_UNAVAILABLE,messages.BROWSER_BRIDGE_TIMEOUT,messages.PSIM_LOGIN_REQUIRED].includes(this.state.error??'')){this.state.error=null;if(this.state.phase==='failed')this.state.phase='idle';}
      this.schedule();this.publish();
    },{...sessionOptions,openExternal:openLoginURL,backgroundPolling:false,onStatus:(status,code)=>{
      if(this.closed)return;
      this.state.auth=status;
      if(status==='failed'){this.sessionError=messages[code??'SERVICE_UNAVAILABLE']??messages.BROWSER_SESSION_STORAGE_INVALID;this.state.error=this.sessionError;this.state.phase='failed';}
      else if(status==='ready'||status==='needs_login'){if(this.sessionError&&this.state.error===this.sessionError){this.state.error=null;if(this.state.phase==='failed')this.state.phase='idle';}this.sessionError=null;}
      sessionOptions.onStatus?.(status,code);this.schedule();this.publish();
    }});
    const sync=this.psim.sync.bind(this.psim);
    this.psim.sync=async options=>{try{await sync(options);}finally{if(!this.closed)this.applyWaitBounds();}};
    this.sessionStarting=this.psim.sync().catch(error=>{if(!this.closed){if(this.state.auth!=='needs_login')this.state.auth='failed';this.fail(error);this.sessionError=this.state.error;}});
  }
  private updatePolling(){
    const active=this.state.attached&&!this.closed;
    this.psim.setBackgroundPolling(active);
    if(!active){if(this.poll)clearInterval(this.poll);this.poll=undefined;return;}
    if(this.poll)return;
    this.poll=setInterval(()=>{
      if(this.embeddedMode&&!this.external&&!this.externalConnecting&&Date.now()>=this.nextConnectAt){this.nextConnectAt=Date.now()+5000;void this.connectComposer();return;}
      if(this.foreground&&!this.busy&&!this.externalConnecting&&this.state.attached){this.leaseAt=Date.now();this.observation=this.observe().finally(()=>{this.observation=undefined;});}
      else if(this.external&&!this.renewing&&!this.externalConnecting&&Date.now()-this.leaseAt>=LEASE_RENEW_MS){const external=this.external;this.renewing=true;this.leaseAt=Date.now();void external.renew().catch(()=>this.retireComposer(external)).finally(()=>{this.renewing=false;});}
    },500);
  }
  getState(){const state=structuredClone(this.state);if(state.auth==='failed'&&this.sessionError)state.error=this.sessionError;return state;}
  getOrderStatus(){return this.order.status;}
  getRuntimeLogs(){return this.runtimeLogs().slice(-1000);}
  getRuntimeHealth(){return{connectionEpoch:this.connectionEpoch,reconnectCount:Math.max(0,this.connectionAttempts-1)};}
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
    const id=window?.targetInstanceId??null;if(id!==this.state.targetInstanceId){this.loginPopover=undefined;this.verifiedContext=undefined;this.verifiedCustomerContext=undefined;this.clearPendingSend();this.resetCustomerLanguage(false);this.clearOrder();}
    if(id!==this.state.targetInstanceId){this.connectionEpoch++;this.connectingAttempt=undefined;this.externalConnecting=undefined;this.connectionAbort?.abort();this.dropReconnect();this.nextConnectAt=0;this.invalidate();this.captured=undefined;this.state.draft=null;this.state.orderEntries=[];this.state.currentOrderHint=null;this.state.orderViewport=null;this.state.messageSurface={active:false,composerRect:null,toolbarRect:null};this.state.composerSource='unavailable';const previous=this.external;this.retireInteractions();this.external=undefined;void previous?.close().catch(()=>{});}
    if(id!==this.state.targetInstanceId){this.pausedContext=undefined;this.state.translationPaused=false;this.attempted=undefined;this.suppressed=undefined;}
    const wasForeground=this.foreground;
    this.state.targetInstanceId=id;this.state.attached=!!window;this.foreground=!!window&&window.visible&&!window.minimized&&(window.foreground||('groupForeground' in window&&window.groupForeground===true));this.updatePolling();if(wasForeground&&!this.foreground){this.clearPendingSend();this.stopTimer();this.abortSuperseded();if(this.state.phase==='translating'){this.invalidate();this.attempted=undefined;}else if(this.state.phase==='waiting'){this.state.phase='idle';}}this.schedule();this.publish();
  }
  /** Revokes the preview and aborts every translation request at once, including a superseded one still finishing. */
  invalidate(){this.abortSuperseded();this.revokeTranslation();}
  /**
   * A content edit of the same draft (same conversation, account scope, document and editor). Revokes the
   * preview and restarts the debounce like invalidate(), but a request already handed to the session is not
   * aborted: the session drops it before the POST, or it completes and its result fails the epoch check.
   * Only one superseded request is kept; the debounced latest draft is sent once it settles (schedule()).
   * Conversation, target, account, cleared-draft, foreground and pause changes keep using invalidate().
   */
  private reviseDraft(){
    const outbound=this.outbound;
    if(outbound&&this.request===outbound.request){this.abortSuperseded();this.superseded=outbound.request;this.request=undefined;outbound.revision.abort();}
    this.revokeTranslation(false);this.waitController.onEdit('typing');this.inputDueAt=this.waitController.snapshot().dueAt??undefined;
  }
  private abortSuperseded(){const superseded=this.superseded;this.superseded=undefined;superseded?.abort();}
  private revokeTranslation(cancelWait=true){this.verifiedAt=undefined;if(cancelWait)this.stopTimer();this.epoch++;this.request?.abort();this.request=undefined;this.reviewed=undefined;this.state.preview=null;if(this.state.phase==='ready'||this.state.phase==='translating'||this.state.phase==='waiting')this.state.phase='stale';}
  /** A verified socket waiting for the IM page keeps its attempt open; release the panel controls meanwhile. */
  private composerWaiting(controller:AbortController){
    if(this.closed||controller.signal.aborted||this.connectionAbort!==controller)return;
    this.waitingConnection=controller;if(this.state.phase==='reading')this.waitForMessagePage();
    this.connectingAttempt?.release();
  }
  /** No selected message page is a normal waiting state; the verified connection keeps observing. */
  private waitForMessagePage(){
    const keepFailure=this.state.phase==='failed';
    this.clearPendingSend();if(!keepFailure)this.attempted=undefined;this.invalidate();this.captured=undefined;
    this.state.draft=null;this.state.orderEntries=[];this.state.currentOrderHint=null;this.state.orderViewport=null;
    this.state.messageSurface={active:false,composerRect:null,toolbarRect:null};this.state.composerSource='unavailable';
    this.clearOrder();this.onContextChanged();if(!keepFailure)this.sourceFailure=false;
    if(this.state.auth==='failed'&&this.sessionError){this.state.phase='failed';this.state.error=this.sessionError;}
    else if(!keepFailure){this.state.phase='idle';this.state.error=null;}
    this.publish();
  }
  private fail(error:unknown,sourceFailure=false){this.telemetryFailure(error);const code=error instanceof Error?error.message:'SERVICE_UNAVAILABLE';if(code==='MESSAGE_PAGE_INACTIVE'){this.waitForMessagePage();return;}this.clearPendingSend();this.sourceFailure=sourceFailure&&code!=='DRAFT_CHANGED'&&code!=='AUTH_CHANGED';if(this.sourceFailure||['MESSAGE_PAGE_INACTIVE','COMPOSER_UNAVAILABLE','WRITE_UNAVAILABLE','INPUT_COMPOSING'].includes(code)){this.attempted=undefined;this.invalidate();}const locations=error instanceof Error?error.stack?.split('\n').slice(1,5).flatMap(line=>{const match=/([\w.-]+\.(?:c?js|ts):\d+:\d+)/.exec(line);return match?[match[1]]:[];}):[];console.log(JSON.stringify({event:'companion-service-failed',code:/^[A-Z][A-Z0-9_]{1,80}$/.test(code)?code:'UNCLASSIFIED',errorType:error instanceof Error&&/^[A-Za-z]+$/.test(error.name)?error.name:'Unknown',locations}));if(this.sourceFailure||code==='MESSAGE_PAGE_INACTIVE'||code==='COMPOSER_UNAVAILABLE'){this.attempted=undefined;this.invalidate();this.captured=undefined;this.state.draft=null;this.state.orderEntries=[];this.state.currentOrderHint=null;this.state.orderViewport=null;this.state.messageSurface={active:false,composerRect:null,toolbarRect:null};this.state.composerSource='unavailable';this.clearOrder();this.onContextChanged();}this.state.error=this.state.auth==='failed'&&this.sessionError?this.sessionError:messages[code]??`操作未完成（${/^[A-Z][A-Z0-9_]{1,80}$/.test(code)?code:'SERVICE_UNAVAILABLE'}），请核对连接后重试。`;this.state.phase='failed';this.publish();}
  private async capture():Promise<Captured>{
    const id=this.state.targetInstanceId;if(!id)throw new Error('TARGET_REQUIRED');
    if(this.external){
      const external=this.external;if(external.targetInstanceId!==id)throw new Error('TARGET_REQUIRED');
      let result;
      try{result=await external.read(this.psim.identity()?.authGeneration??0);}catch(error){
        if(error instanceof Error&&/LEASE_ENDED|RUNTIME_TARGET_CHANGED|OWNED_FRAME_BOUNDARY_FAILED|NATIVE_NOT_READY|NATIVE_POLL_FAILED|SERVICE_DISCONNECTED/.test(error.message))this.retireComposer(external);
        throw error;
      }
      if(result.messageSurface?.active===false)throw new Error(result.reason??'MESSAGE_PAGE_INACTIVE');
      if(!result.snapshot)throw new Error(result.reason??'COMPOSER_UNAVAILABLE');
      if(!result.writeVerified)throw new Error('WRITE_UNAVAILABLE');
      return{source:'verified-editor',snapshot:result.snapshot,currentOrderHint:result.currentOrderHint,orderEntries:result.orderEntries??[],orderViewport:result.orderViewport??null,messageSurface:result.messageSurface};
    }
    if(this.embeddedMode)throw new Error('COMPOSER_UNAVAILABLE');
    const snapshot=await this.native.readDraft();if(snapshot.targetInstanceId!==id)throw new Error('TARGET_REQUIRED');
    return{source:'uia',snapshot};
  }
  private draftTarget(capture:Extract<Captured,{source:'verified-editor'}>){return JSON.stringify([this.context(capture),capture.snapshot.editorIdentity,capture.snapshot.composerId,capture.snapshot.documentGeneration]);}
  /** Non-empty new content in the same verified draft target; a cleared draft or any target change is not a revision. */
  private revisesDraft(previous:Captured,next:Captured){return previous.source==='verified-editor'&&next.source==='verified-editor'&&!!next.snapshot.text.trim()&&this.draftTarget(previous)===this.draftTarget(next);}
  private adopt(capture:Captured,invalidateChanged=true){
    this.surfaceMeasurementRevision++;
    const composing=capture.source==='verified-editor'&&capture.snapshot.composing;
    if(composing&&!this.waitController.snapshot().composing)this.waitController.onCompositionStart();
    else if(!composing&&this.waitController.snapshot().composing)this.waitController.onCompositionEnd();
    if(capture.source==='verified-editor'){
      const customerContext=this.customerContext(capture);
      if(this.verifiedCustomerContext===undefined)this.resetCustomerLanguage();
      const context=this.draftTarget(capture);
      if(this.verifiedCustomerContext!==undefined&&this.verifiedCustomerContext!==customerContext)this.contextChanged();
      else if(this.verifiedContext!==undefined&&this.verifiedContext!==context){this.invalidate();this.lastWritten=undefined;this.clearPendingSend();this.clearOrder();this.onContextChanged();}
      this.verifiedCustomerContext=customerContext;this.verifiedContext=context;
    }
    const changed=!this.captured||JSON.stringify(this.captured.snapshot)!==JSON.stringify(capture.snapshot)||this.captured.source!==capture.source;
    if(changed&&this.captured?.snapshot.text!==capture.snapshot.text){if(!this.inputEventPending||this.inputObservedAt===undefined)this.markInput('capture');this.inputEventPending=false;}
    if(invalidateChanged&&this.captured&&changed){if(this.revisesDraft(this.captured,capture))this.reviseDraft();else this.invalidate();this.attempted=undefined;}
    if(this.pausedContext!==undefined&&this.pausedContext!==this.customerContext(capture)){this.pausedContext=undefined;this.state.translationPaused=false;}
    if(changed&&this.suppressed!==this.signature(capture))this.suppressed=undefined;
    this.captured=capture;this.state.composerSource=capture.source;
    this.state.messageSurface=capture.source==='verified-editor'?(capture.messageSurface??{active:false,composerRect:null,toolbarRect:null}):{active:false,composerRect:null,toolbarRect:null};
    this.state.orderEntries=capture.source==='verified-editor'?capture.orderEntries:[];this.state.orderViewport=capture.source==='verified-editor'?capture.orderViewport:null;
    this.state.currentOrderHint=capture.source==='verified-editor'?capture.currentOrderHint:null;
    this.state.draft={text:capture.snapshot.text,canReplace:capture.source==='verified-editor'?capture.snapshot.isPlainText&&!capture.snapshot.composing:capture.snapshot.canReplace};
    if(invalidateChanged)this.schedule();
    const identity=this.psim.identity();
    this.verifiedAt=capture.source==='verified-editor'&&this.external?{at:Date.now(),capture,epoch:this.epoch,target:this.state.targetInstanceId,external:this.external,accountScope:identity?.accountScope,authGeneration:identity?.authGeneration}:undefined;
  }
  private async observe(){
    this.setBusy(true);const epoch=this.epoch,id=this.state.targetInstanceId;
    try{const capture=await this.capture();if(this.closed||id!==this.state.targetInstanceId||epoch!==this.epoch)return;const recovered=this.sourceFailure&&this.state.phase==='failed'&&this.state.composerSource==='unavailable'&&capture.source==='verified-editor';this.adopt(capture);if(recovered){this.sourceFailure=false;this.state.phase='idle';this.state.error=null;this.schedule();}this.publish();}
    catch(error){if(this.closed||id!==this.state.targetInstanceId||epoch!==this.epoch)return;if(error instanceof Error&&error.message==='MESSAGE_PAGE_INACTIVE'){this.waitForMessagePage();return;}if(this.external&&error instanceof Error&&/LEASE_ENDED|RUNTIME_TARGET_CHANGED|OWNED_FRAME_BOUNDARY_FAILED|NATIVE_NOT_READY|NATIVE_POLL_FAILED|SERVICE_DISCONNECTED/.test(error.message)){this.retireComposer(this.external);return;}if(this.state.draft||this.state.messageSurface?.active||this.state.orderEntries.length){this.clearPendingSend();this.clearOrder();this.onContextChanged();if(this.state.phase==='ready'||this.state.phase==='translating'||this.state.phase==='waiting')this.attempted=undefined;this.invalidate();this.captured=undefined;this.state.draft=null;this.state.orderEntries=[];this.state.currentOrderHint=null;this.state.orderViewport=null;this.state.messageSurface={active:false,composerRect:null,toolbarRect:null};this.state.composerSource='unavailable';this.publish();}}
    finally{this.setBusy(false);}
  }
  /** Background captures must finish before a visible enabled user action acquires the editor. */
  private async waitForObservation(){const id=this.state.targetInstanceId;await this.observation;return !this.closed&&id===this.state.targetInstanceId;}
  async readDraft(){if(!await this.waitForObservation()||this.busy)return;this.setBusy(true);if(this.state.phase!=='failed'){this.state.phase='reading';this.state.error=null;}const epoch=this.epoch,id=this.state.targetInstanceId;this.publish();try{const capture=await this.capture();if(epoch!==this.epoch||id!==this.state.targetInstanceId)throw new Error('DRAFT_CHANGED');this.state.phase='idle';this.state.error=null;this.adopt(capture);this.sourceFailure=false;this.publish();}catch(error){this.fail(error,true);}finally{this.setBusy(false);}}
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
    // A waiting attempt connects on its own once the IM page appears. No caller, including the one
    // that started it, awaits that wait: a pending Settings action keeps every control disabled.
    if(this.externalConnecting)return this.externalConnecting;
    const id=this.state.targetInstanceId;if(!id){this.fail(new Error('TARGET_REQUIRED'));return;}this.nextConnectAt=Date.now()+5000;
    let release!:()=>void;const released=new Promise<void>(resolve=>{release=resolve;});
    const attempt={release};this.connectingAttempt=attempt;
    const current=()=>!this.closed&&this.connectingAttempt===attempt&&id===this.state.targetInstanceId;
    const operation=(async()=>{
      if(!await this.waitForObservation()||!current()||this.busy)return;
      this.connectionAttempts++;
      const warm=this.reconnecting;const connectionAbort=warm&&!warm.controller.signal.aborted?warm.controller:new AbortController();if(!warm)this.connectionAbort?.abort();this.connectionAbort=connectionAbort;
      this.invalidate();const epoch=this.connectionEpoch;this.state.error=null;this.state.phase='reading';this.publish();
      const previous=this.external;this.retireInteractions();this.external=undefined;await previous?.close().catch(()=>{});
      let composer:ExternalComposer|undefined;
      try{
        if(!current()||connectionAbort.signal.aborted)return;
        if(warm&&this.waitingConnection===connectionAbort)this.composerWaiting(connectionAbort);
        composer=warm?await warm.promise:undefined;
        if(warm&&this.reconnecting===warm){this.reconnecting=undefined;warm.claimed=true;}
        if(!current()||connectionAbort.signal.aborted||epoch!==this.connectionEpoch){if(composer&&!warm?.disposed){if(warm)warm.disposed=true;await composer.close();}return;}
        composer??=await connectExternalComposer(id,connectionAbort.signal,()=>this.composerWaiting(connectionAbort));
        if(!current()||connectionAbort.signal.aborted||epoch!==this.connectionEpoch){await composer.close();return;}
        const connected=composer;this.external=connected;
        this.stopInteraction=connected.onInteraction?.(event=>this.interaction(event,connected));
        const stopInvalidation=connected.onInvalidated?.(()=>this.retireComposer(connected));
        // Registration can synchronously report a previously invalidated driver.
        if(!current()||this.external!==connected){stopInvalidation?.();return;}
        this.stopInvalidation=stopInvalidation;this.syncInteractionOptions();
        await connected.mountWorkbench?.(this.embeddedState(),this.workbenchAction(connected,id));
        // retireComposer/window changes own stale cleanup, including socket transfer.
        if(!current()||this.external!==connected)return;
        this.state.phase='idle';await this.readDraft();
      }
      catch(error){
        if(!current())return;
        if(composer&&this.external===composer){this.retireInteractions();this.external=undefined;await composer.close().catch(()=>{});}
        if(current()&&epoch===this.connectionEpoch){reportVendorProgress('failed');this.fail(error,true);}
      }
    })().finally(()=>{
      if(this.connectingAttempt!==attempt)return;
      this.nextConnectAt=Date.now()+5000;this.connectingAttempt=undefined;this.externalConnecting=undefined;this.waitingConnection=undefined;
    });
    this.externalConnecting=Promise.race([operation,released]);return this.externalConnecting;
  }
  async translate(target:PanelTarget,automaticSignature?:string){
    if(!isPanelTarget(target)){this.fail(new Error('INVALID_LANGUAGE'));return;}
    if(!automaticSignature&&target!==this.state.language)await this.setTranslationOptions({language:target});
    if(this.translationPreparing||this.waitController.snapshot().inFlightId!==null){
      if(!automaticSignature&&this.signature()!==this.attempted)this.manualPending={signature:this.signature(),target,intent:this.translationIntent};
      this.schedule();return;
    }
    this.translationPreparing=true;
    try{await this.runTranslation(target,automaticSignature);}finally{
      this.translationPreparing=false;const pending=this.manualPending;this.manualPending=undefined;
      if(pending&&!this.closed&&this.foreground&&!this.state.translationPaused&&pending.intent===this.translationIntent&&pending.signature===this.signature()&&(pending.sendGeneration===undefined||pending.sendGeneration===this.sendIntentGeneration&&pending.sendGeneration===this.pendingSend?.generation))void this.translate(pending.target);
    }
  }
  private async runTranslation(target:PanelTarget,automaticSignature?:string){
    const begun=performance.now(),observedAt=automaticSignature?this.inputObservedAt:begun;
    const revision=this.inputRevision,contextRevision=this.contextRevision,targetId=this.state.targetInstanceId;
    const startIdentity=this.psim.identity(),startSignature=this.signature();
    const trace=createTelemetry('translate',{trigger:this.pendingSend?'enter':automaticSignature?'automatic':'manual',
      sourceLanguage:'zh',targetLanguage:target,targetSource:this.state.followCustomerLanguage===false?'manual':this.state.customerLanguageResolution?.status==='fallback'?'fallback':this.automaticTarget()?'recognized':'unavailable',
      sourceChars:this.captured?.snapshot.text.length,configuredWaitMs:this.waitController.snapshot().effectiveWaitMs,
      actualWaitMs:observedAt===undefined?undefined:Math.max(0,begun-observedAt),
      schedulerDelayMs:automaticSignature&&this.inputDueAt!==undefined?Math.max(0,begun-this.inputDueAt):undefined,
      inFlightWaitMs:this.inputDeferredMs,inputTimingSource:automaticSignature?this.inputTimingSource:'manual',
      inputRevision:revision,contextRevision,sessionMode:this.state.sessionMode,authStateBefore:this.state.auth,
      foreground:this.foreground,composing:this.captured?.source==='verified-editor'&&this.captured.snapshot.composing,
      plainText:this.captured?.source==='verified-editor'&&this.captured.snapshot.isPlainText,attempt:1,outcome:'skipped'});
    return runWithTelemetry(trace,async()=>{
      try{await this.performTranslation(target,automaticSignature);}
      catch(error){this.telemetryFailure(error);throw error;}
      finally{
        const reason=()=>this.closed?'closed':targetId!==this.state.targetInstanceId||contextRevision!==this.contextRevision?'context-changed':startIdentity&&this.psim.identity()?.authGeneration!==startIdentity.authGeneration?'auth-changed':revision!==this.inputRevision||startSignature!==this.signature()?'draft-changed':!this.foreground?'not-foreground':this.state.translationPaused?'paused':this.state.auth!=='ready'?'login-required':!this.captured?.snapshot.text.trim()?'empty-draft':this.captured?.source==='verified-editor'&&this.captured.snapshot.composing?'composing':'not-ready';
        const fields={authStateAfter:this.state.auth};
        const stopped=()=>['paused','not-foreground','closed','context-changed','auth-changed','empty-draft'].includes(reason())||!!this.telemetrySignals.get(trace)?.aborted&&reason()!=='draft-changed';
        const outcome=trace.fields.outcome==='skipped'&&trace.fields.translationSent?(stopped()?'cancelled':'superseded'):String(trace.fields.outcome??'skipped');
        if(outcome==='shown'){
          const preview=this.previewTelemetry.get(trace),review=preview?.review,publication=this.embeddedPublication,publishedAt=preview?.publishedAt??performance.now();
          // Observe the owned DOM acknowledgement without delaying business operations or Enter.
          let timer:ReturnType<typeof setTimeout>|undefined;
          void Promise.race([publication.then(()=>true,()=>false),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),5000);timer.unref?.();})]).then(ack=>{
            clearTimeout(timer);const ackAt=review?this.previewAcknowledgements.get(review):undefined,displayed=ackAt!==undefined;
            const stale=!review||this.reviewed!==review;
            finishTelemetry(trace,displayed?'shown':stale?(stopped()?'cancelled':'superseded'):'success',{...fields,previewShown:displayed,
              reason:displayed?undefined:stale?reason():'unavailable',previewPublishMs:displayed?Math.max(0,ackAt-publishedAt):undefined,
              userWaitMs:displayed&&observedAt!==undefined?Math.max(0,ackAt-observedAt):undefined,
              responseToPreviewMs:displayed&&typeof trace.fields.responseToPreviewMs==='number'?trace.fields.responseToPreviewMs+Math.max(0,ackAt-publishedAt):undefined},ackAt);
          });
        }else finishTelemetry(trace,outcome,{...fields,reason:trace.fields.reason??reason(),previewShown:false});
      }
    });
  }
  private async performTranslation(target:PanelTarget,automaticSignature?:string){
    if(!isPanelTarget(target)){this.fail(new Error('INVALID_LANGUAGE'));return;}
    let intent=this.translationIntent;
    await this.sessionStarting;
    if(intent!==this.translationIntent||!this.foreground||this.state.translationPaused)return;
    await this.translationOptionsStarting;await this.waitStarting;
    if(!automaticSignature&&target!==this.state.language)await this.setTranslationOptions({language:target});
    if(this.state.followCustomerLanguage!==false&&!this.automaticTarget())return;
    // Authentication may publish a newly recovered identity and revoke old reviews.
    // Complete that step before creating this translation's epoch, so a manual retry survives recovery.
    intent=this.translationIntent;const intendedWindow=this.state.targetInstanceId,expectedCustomerContext=this.verifiedCustomerContext;
    // Windows reuses a successful check of the same auth generation started within OUTBOUND_SYNC_REUSE_MS
    // (usually the 4 s background poll); an in-flight, failed or revoked check is never reused.
    try{await this.psim.sync({reuseRecent:true});}catch(error){if(intent===this.translationIntent&&!this.closed)this.fail(error);return;}
    if(intent!==this.translationIntent||this.closed||!this.foreground||this.state.translationPaused||target!==this.state.language||intendedWindow!==this.state.targetInstanceId)return;
    const expectedEpoch=this.epoch;
    if(!await this.waitForObservation()||this.busy||expectedEpoch!==this.epoch||intent!==this.translationIntent||this.state.translationPaused||!this.foreground||target!==this.state.language)return;
    this.invalidate();this.state.error=null;this.state.phase='translating';this.setBusy(true);this.publish();
    const epoch=this.epoch,request=new AbortController();this.request=request;
    const telemetry=currentTelemetry();if(telemetry)this.telemetrySignals.set(telemetry,request.signal);
    const expectedContext=this.context();
    let capture:Captured,identity:PsimIdentity;
    try{
      const currentIdentity=this.psim.identity();if(!currentIdentity)throw new Error('PSIM_LOGIN_REQUIRED');identity=currentIdentity;
      try{capture=await timeTelemetry('captureBeforeMs',()=>this.capture());}catch(error){if(epoch===this.epoch)this.fail(error,true);return;}
      if(epoch!==this.epoch||!this.foreground)return;
      if(expectedContext&&expectedContext!==this.context(capture)||expectedCustomerContext!==undefined&&expectedCustomerContext!==this.customerContext(capture)){this.adopt(capture);this.publish();return;}
      if(capture.source==='verified-editor'&&!capture.snapshot.isPlainText){this.adopt(capture,false);throw new Error('WRITE_UNAVAILABLE');}
      if(capture.source==='verified-editor'&&capture.snapshot.composing)throw new Error('INPUT_COMPOSING');
      if(!capture.snapshot.text.trim())throw new Error('EMPTY_DRAFT');
      this.adopt(capture,false);
      if(epoch!==this.epoch||intent!==this.translationIntent||target!==this.state.language){this.publish();return;}
      if(automaticSignature&&automaticSignature!==this.signature()){this.schedule();this.publish();return;}
      this.attempted=this.signature();
      setTelemetry({sourceChars:capture.snapshot.text.length,plainText:capture.source==='verified-editor'&&capture.snapshot.isPlainText,composing:capture.source==='verified-editor'&&capture.snapshot.composing,authGeneration:identity.authGeneration});
    }catch(error){if(epoch===this.epoch)this.fail(error);return;}
    finally{this.setBusy(false);}
    const controller=this.waitController,id=++this.outboundSeq;let outcome:'shown'|'superseded'|'failed'|'cancelled'|'rate_limited'='superseded';
    try{
      const version=createHash('sha256').update(JSON.stringify(capture.snapshot)).digest('hex');
      const revision=new AbortController();this.outbound={request,revision};
      controller.onRequestSent(id);
      const result=await this.psim.translate({text:capture.snapshot.text,target_lang:target,source_lang:'zh',purpose:'outbound',draft_request_id:randomUUID(),composer_content_version:version},identity,request.signal,revision.signal);
      const responseAt=currentTelemetry()?.httpCompletedAt??performance.now();setTelemetry({targetChars:result.data.translated_text.length});
      if(this.outbound?.request===request)this.outbound=undefined;
      if(this.closed||epoch!==this.epoch||!await this.waitForObservation()||epoch!==this.epoch)return;
      await timeTelemetry('editorLockMs',()=>this.acquireEditor());
      try{
        if(this.closed||epoch!==this.epoch)return;
        const after=await timeTelemetry('captureAfterMs',()=>this.capture());
        if(this.closed||epoch!==this.epoch)return;
        if(!same(capture,after)){this.adopt(after);this.publish();return;}
        if(!result.data.translated_text.trim())throw new Error('EMPTY_TRANSLATION');
        this.reviewed={capture,identity,text:result.data.translated_text,telemetryId:currentTelemetry()?.fields.traceId as string|undefined};this.state.preview=result.data.translated_text;this.state.phase='ready';outcome='shown';controller.onResponse(id,outcome);setTelemetry({outcome:'shown',readbackMatched:true,responseToPreviewMs:performance.now()-responseAt});const trace=currentTelemetry();if(trace)this.previewTelemetry.set(trace,{review:this.reviewed,publishedAt:performance.now()});this.publish();
      }finally{this.setBusy(false);}
      void this.flushPendingSend();
    }catch(error){const code=error instanceof Error?error.message:'';outcome=request.signal.aborted?'cancelled':code==='RATE_LIMITED'||code==='PSIM_HTTP_429'?'rate_limited':code==='REQUEST_ABORTED'?'cancelled':code==='REQUEST_SUPERSEDED'?'superseded':'failed';this.telemetryFailure(error);setTelemetry({outcome:outcome==='rate_limited'?'rate-limited':outcome});if(epoch===this.epoch)this.fail(error);}finally{if(this.request===request)this.request=undefined;if(this.outbound?.request===request)this.outbound=undefined;if(this.superseded===request)this.superseded=undefined;if(outcome!=='shown')controller.onResponse(id,request.signal.aborted?'cancelled':outcome);if(this.inputDeferredAt!==undefined){this.inputDeferredMs=performance.now()-this.inputDeferredAt;this.inputDeferredAt=undefined;}}
  }
  /** Send mode: a plain Enter sends the reviewed translation, waiting for it if the request is still pending. */
  private async sendShortcut(snapshot:VerifiedComposerSnapshot){
    if(this.closed||!this.foreground||this.state.outboundMode!=='send'||!snapshot.isPlainText)return;
    // Translation off, paused or not applicable, or the draft is already our translation: send it unchanged, as the vendor would.
    const generation=this.sendIntentGeneration;
    if(!this.translationApplies()||this.lastWritten&&sameVerifiedDraft(this.lastWritten,snapshot)){await this.sendAsIs(snapshot,generation);return;}
    this.pendingSend={snapshot,generation};this.state.sendPending=true;
    // Native Enter can arrive before the preceding input's CDP capture. Keep its
    // intent visible while refreshing; scheduling against the old empty draft
    // would otherwise clear the intent before that capture can adopt the text.
    const current=()=>!this.closed&&this.foreground&&this.state.outboundMode==='send'&&generation===this.sendIntentGeneration;
    const capturedMatches=()=>this.captured?.source==='verified-editor'&&sameVerifiedDraft(this.captured.snapshot,snapshot);
    if(!capturedMatches()){
      this.publish();await this.interactionTask;
      if(!current()||!await this.waitForObservation()||!current())return;
      if(!capturedMatches()){
        await this.acquireEditor();
        try{
          if(!current())return;const capture=await this.capture();if(!current())return;
          this.adopt(capture);
          if(!current())return;
          if(!capturedMatches()){this.clearPendingSend();this.publish();return;}
        }catch(error){if(current())this.fail(error,true);return;}finally{this.setBusy(false);}
      }
    }
    if(!current())return;
    const reviewed=this.reviewed;
    if(this.state.phase==='ready'&&reviewed?.capture.source==='verified-editor'&&sameVerifiedDraft(reviewed.capture.snapshot,snapshot)){await this.flushPendingSend();return;}
    // An in-flight request flushes the pending send when it completes.
    if(this.state.phase!=='translating'){this.stopTimer();this.attempted=undefined;this.state.error=null;if(this.state.phase==='failed')this.state.phase='idle';this.schedule(true);if(!this.waitController.snapshot().pending&&!this.translationPreparing&&this.waitController.snapshot().inFlightId===null)this.clearPendingSend();}
    this.publish();
  }
  private async flushPendingSend(){
    const pending=this.pendingSend,reviewed=this.reviewed;if(!pending||this.state.phase!=='ready')return;
    // Consume the queued intent without revoking its in-progress authorization.
    this.pendingSend=undefined;this.state.sendPending=false;
    if(pending.generation!==this.sendIntentGeneration||!reviewed||reviewed.capture.source!=='verified-editor'||!sameVerifiedDraft(reviewed.capture.snapshot,pending.snapshot)){this.publish();return;}
    await this.replaceDraft(pending.snapshot,'send',pending.generation);
  }
  private async sendAsIs(snapshot:VerifiedComposerSnapshot,generation:number){
    return this.traceAction('send',()=>this.performSendAsIs(snapshot,generation));
  }
  private async traceAction(operation:'replace'|'send',action:()=>Promise<void>){
    const trace=createTelemetry(operation,{parentTraceId:this.reviewed?.telemetryId??currentTelemetry()?.fields.traceId,
      trigger:operation==='send'?'enter':'manual',sourceLanguage:'zh',targetLanguage:this.state.language,sessionMode:this.state.sessionMode,
      authStateBefore:this.state.auth,foreground:this.foreground,contextRevision:this.contextRevision,outcome:'skipped',sendConfirmed:false});
    return runWithTelemetry(trace,async()=>{try{await action();}catch(error){this.telemetryFailure(error);throw error;}
      finally{finishTelemetry(trace,String(trace.fields.outcome??'skipped'),{authStateAfter:this.state.auth,reason:trace.fields.reason??(trace.fields.outcome==='skipped'?(!this.foreground?'not-foreground':'not-ready'):undefined)});}});
  }
  private async performSendAsIs(snapshot:VerifiedComposerSnapshot,generation:number){
    if(!await this.waitForObservation()||!this.foreground)return;
    await this.acquireEditor();const epoch=this.epoch;
    try{
      const external=this.external;if(!external?.send)throw new Error('SEND_UNAVAILABLE');
      const current=await this.capture();if(epoch!==this.epoch)throw new Error('DRAFT_CHANGED');if(current.source!=='verified-editor'||!sameVerifiedDraft(current.snapshot,snapshot)){this.adopt(current);this.publish();throw new Error('DRAFT_CHANGED');}
      if(!current.snapshot.isPlainText)throw new Error('WRITE_UNAVAILABLE');
      const authorize=()=>{if(this.closed||!this.foreground||epoch!==this.epoch||this.external!==external||this.state.outboundMode!=='send'||generation!==this.sendIntentGeneration)throw new Error('DRAFT_CHANGED');};
      await timeTelemetry('sendMs',()=>external.send!(current.snapshot,()=>{authorize();return authorize;}));
      setTelemetry({outcome:'send-unconfirmed',sendTriggered:true,sendConfirmed:false});
      this.lastWritten=undefined;
    }catch(error){this.fail(error);}finally{this.setBusy(false);}
  }
  async replaceDraft(shortcutSnapshot?:VerifiedComposerSnapshot,intent:'replace'|'send'='replace',sendGeneration=this.sendIntentGeneration){
    return this.traceAction(intent==='send'?'send':'replace',()=>this.performReplaceDraft(shortcutSnapshot,intent,sendGeneration));
  }
  private async performReplaceDraft(shortcutSnapshot?:VerifiedComposerSnapshot,intent:'replace'|'send'='replace',sendGeneration=this.sendIntentGeneration){
    const allowed=()=>intent==='send'?this.state.outboundMode==='send'&&sendGeneration===this.sendIntentGeneration:this.state.shortcutEnabled!==false;
    const shortcutReview=shortcutSnapshot?this.reviewed:undefined;
    if(shortcutSnapshot&&(!shortcutReview||shortcutReview.capture.source!=='verified-editor'||!sameVerifiedDraft(shortcutReview.capture.snapshot,shortcutSnapshot)||!allowed()||this.state.translationPaused||this.state.phase!=='ready'))return;
    if(!await this.waitForObservation()||!this.reviewed||!this.foreground)return;
    // A user's Enter must not be dropped because a background read holds the editor.
    if(intent==='send')await this.acquireEditor();else if(this.busy)return;else this.setBusy(true);
    if(!this.reviewed||!this.foreground||shortcutSnapshot&&(this.reviewed!==shortcutReview||!allowed()||this.state.translationPaused||this.state.phase!=='ready')){this.setBusy(false);return;}
    const reviewed=this.reviewed,epoch=this.epoch;this.state.error=null;this.state.phase='replacing';this.publish();
    try{
      // Like translation, writing and sending reuse a successful check of the same auth generation started
      // within OUTBOUND_SYNC_REUSE_MS (Windows); the identity comparisons below still run before every write.
      await this.psim.sync({reuseRecent:true});
      const auth=this.psim.identity();if(!auth||auth.authGeneration!==reviewed.identity.authGeneration||auth.accountScope!==reviewed.identity.accountScope)throw new Error('AUTH_CHANGED');
      const current=await timeTelemetry('captureBeforeMs',()=>this.capture());if(!this.foreground||epoch!==this.epoch)throw new Error('DRAFT_CHANGED');if(!same(current,reviewed.capture)){this.adopt(current);this.publish();throw new Error('DRAFT_CHANGED');}
      const authorize=async()=>{
        await this.psim.sync({reuseRecent:true});
        const assertCurrent=()=>{const latest=this.psim.identity();
          if(this.closed||!this.foreground||shortcutSnapshot&&(!allowed()||this.state.translationPaused)||epoch!==this.epoch||this.external?.targetInstanceId!==this.state.targetInstanceId||!latest||latest.authGeneration!==reviewed.identity.authGeneration||latest.accountScope!==reviewed.identity.accountScope)throw new Error('AUTH_CHANGED');
        };
        assertCurrent();return assertCurrent;
      };
      if(current.source==='verified-editor'){if(!current.snapshot.isPlainText)throw new Error('WRITE_UNAVAILABLE');if(intent==='send'&&!this.external!.send)throw new Error('SEND_UNAVAILABLE');await timeTelemetry('replaceMs',()=>this.external!.replace(current.snapshot,reviewed.text,authorize));}else{if(intent==='send')throw new Error('SEND_UNAVAILABLE');if(!current.snapshot.canReplace)throw new Error('WRITE_UNAVAILABLE');await timeTelemetry('replaceMs',()=>this.native.replaceDraft(current.snapshot,reviewed.text));}
      const after=await timeTelemetry('captureAfterMs',()=>this.capture());setTelemetry({readbackMatched:epoch===this.epoch&&after.snapshot.text===reviewed.text});if(epoch!==this.epoch||after.snapshot.text!==reviewed.text)throw new Error('DRAFT_READBACK_MISMATCH');
      this.adopt(after,false);
      if(epoch!==this.epoch)throw new Error('DRAFT_CHANGED');
      if(current.source==='verified-editor'&&(after.source!=='verified-editor'||after.snapshot.conversationId!==current.snapshot.conversationId||after.snapshot.scopeGeneration!==current.snapshot.scopeGeneration||after.snapshot.platformAccountScope!==current.snapshot.platformAccountScope||after.snapshot.documentGeneration!==current.snapshot.documentGeneration||after.snapshot.editorIdentity!==current.snapshot.editorIdentity||after.snapshot.composerId!==current.snapshot.composerId))throw new Error('DRAFT_CHANGED');
      this.waitController.onDraftSent();
      this.lastWritten=after.source==='verified-editor'?after.snapshot:undefined;
      this.suppressed=this.signature(after);this.attempted=this.suppressed;this.reviewed=undefined;this.state.preview=null;this.state.phase='replaced';
      setTelemetry({outcome:'replaced',reason:undefined});
      if(intent==='send'&&after.source==='verified-editor'){this.publish();await timeTelemetry('sendMs',()=>this.external!.send!(after.snapshot,authorize));setTelemetry({outcome:'send-unconfirmed',sendTriggered:true,sendConfirmed:false});this.lastWritten=undefined;this.state.phase='idle';}
      this.publish();
    }catch(error){this.invalidate();this.fail(error);}finally{this.setBusy(false);}
  }
  async openOrder(intent:OrderWindowIntent){
    if(!isOrderWindowIntent(intent)||!this.orderWindow)throw new Error('INVALID_ACTION');
    await this.sessionStarting;
    const identity=this.psim.identity(),context=this.context(),target=this.state.targetInstanceId;
    if(!identity){this.fail(new Error('PSIM_LOGIN_REQUIRED'));throw new Error('PSIM_LOGIN_REQUIRED');}
    if(this.closed||!this.foreground||!this.external||!this.state.messageSurface?.active||intent.conversationKey!==context){if(!this.closed)this.fail(new Error('ORDER_CONTEXT_CHANGED'));throw new Error('ORDER_CONTEXT_CHANGED');}
    this.invalidateOrderWindow();const generation=this.orderWindowGeneration;
    const current=()=>!this.closed&&generation===this.orderWindowGeneration&&target===this.state.targetInstanceId&&context===this.context()&&this.state.messageSurface?.active===true&&this.psim.identity()?.accountScope===identity.accountScope&&this.psim.identity()?.authGeneration===identity.authGeneration;
    try{
      await this.psim.sync();if(!current())throw new Error('ORDER_CONTEXT_CHANGED');
      const profile=this.psim.getBrowserProfile();if(!profile)throw new Error('BROWSER_PROFILE_REQUIRED');
      await this.acquireEditor();try{const capture=await this.capture();if(!current())throw new Error('ORDER_CONTEXT_CHANGED');this.adopt(capture);if(!current())throw new Error('ORDER_CONTEXT_CHANGED');}finally{this.setBusy(false);}
      await this.orderClosing;if(!current())throw new Error('ORDER_CONTEXT_CHANGED');
      await this.orderWindow.open({identifier:intent.identifier,identifierType:intent.identifierType,requestId:randomUUID()},profile,async()=>{
        await this.psim.sync();if(!current())return false;if(JSON.stringify(this.psim.getBrowserProfile())!==JSON.stringify(profile)){this.invalidateOrderWindow();return false;}
        await this.acquireEditor();try{const capture=await this.capture();if(!current())return false;this.adopt(capture);return current();}finally{this.setBusy(false);}
      });
      if(current()){this.state.browserOpen=true;this.publish();}
    }catch(error){if(current()){this.fail(error);throw error;}}
  }
  /** Page intents for one mounted composer. `operatorSession` resolves to the grant the page hands to the TSim frame. */
  private workbenchAction(composer:ExternalComposer,id:string){
    return async(action:string,args:unknown[])=>{
      if(this.closed||this.external!==composer||id!==this.state.targetInstanceId)throw new Error('RUNTIME_TARGET_CHANGED');
      return invokeEmbeddedAction(this,action,args);
    };
  }
  /** Hands the verified bearer to the in-page TSim operator for the visible conversation only. */
  async operatorSession(intent:OrderWindowIntent):Promise<OperatorSessionGrant>{
    if(!isOrderWindowIntent(intent))throw new Error('INVALID_ACTION');
    await this.sessionStarting;
    if(this.closed||!this.foreground||!this.external||this.captured?.source!=='verified-editor'||!this.state.messageSurface?.active)throw new Error('MESSAGE_PAGE_REQUIRED');
    if(intent.conversationKey!==this.context())throw new Error('ORDER_CONTEXT_CHANGED');
    const identity=this.psim.identity();if(!identity||this.state.auth!=='ready')throw new Error('PSIM_LOGIN_REQUIRED');
    const epoch=this.epoch,target=this.state.targetInstanceId,external=this.external;
    const current=()=>!this.closed&&this.foreground&&this.external===external&&this.state.targetInstanceId===target&&this.epoch===epoch&&this.state.messageSurface?.active===true&&intent.conversationKey===this.context()&&this.state.auth==='ready'&&this.psim.identity()?.accountScope===identity.accountScope&&this.psim.identity()?.authGeneration===identity.authGeneration;
    // Fast path: the displayed verified capture was adopted moments ago under this epoch, target, lease and login, and no read is in flight.
    const fresh=this.verifiedAt,age=fresh?Date.now()-fresh.at:Infinity;
    if(fresh&&age>=0&&age<=OPERATOR_CAPTURE_FRESH_MS&&fresh.capture===this.captured&&fresh.epoch===epoch&&fresh.target===target&&fresh.external===external&&fresh.accountScope===identity.accountScope&&fresh.authGeneration===identity.authGeneration&&!this.busy&&!this.observation&&!this.interactionTask&&!this.externalConnecting&&current()){
      const grant=this.psim.operatorGrant(identity);if(!grant)throw new Error('AUTH_CHANGED');
      return grant;
    }
    if(!await this.waitForObservation()||!current())throw new Error('ORDER_CONTEXT_CHANGED');
    await this.acquireEditor();
    try{
      if(!current())throw new Error('ORDER_CONTEXT_CHANGED');
      const capture=await this.capture();if(!current())throw new Error('ORDER_CONTEXT_CHANGED');
      this.adopt(capture);this.publish();if(!current())throw new Error('ORDER_CONTEXT_CHANGED');
    }catch(error){if(current())this.fail(error,true);throw error;}
    finally{this.setBusy(false);}
    const grant=this.psim.operatorGrant(identity);if(!grant)throw new Error('AUTH_CHANGED');
    return grant;
  }
  async queryOrder(identifier:string,conversationKey?:string){
    if(typeof identifier!=='string'||!identifier.trim()||identifier.length>128||/[\r\n\u0000]/.test(identifier))throw new Error('INVALID_ORDER_IDENTIFIER');
    const requestedGeneration=this.orderGeneration;
    await this.sessionStarting;
    if(requestedGeneration!==this.orderGeneration||conversationKey!==undefined&&conversationKey!==this.context())throw new Error('ORDER_CONTEXT_CHANGED');
    if(this.closed||!this.foreground||!this.external||this.captured?.source!=='verified-editor'||!this.state.messageSurface?.active)throw new Error('MESSAGE_PAGE_REQUIRED');
    this.clearOrder();const generation=this.orderGeneration,context=this.context(),identity=this.psim.identity(),request=new AbortController(),value=identifier.trim();
    // A missing login is an order outcome the panel can explain, not a rejected page intent.
    if(!identity){this.order={identifier:value,status:'failed',fields:[],error:ORDER_FAILURES.PSIM_LOGIN_REQUIRED};this.publish();return;}
    this.orderRequest=request;this.order={identifier:value,status:'loading',fields:[],error:null};this.publish();
    // The page bridge only waits for acceptance; results arrive through published state.
    void this.runOrderQuery(value,generation,context,identity,request);
  }
  private async runOrderQuery(identifier:string,generation:number,context:string,identity:PsimIdentity,request:AbortController){
    const current=()=>!this.closed&&!request.signal.aborted&&generation===this.orderGeneration&&context===this.context()&&this.psim.identity()?.authGeneration===identity.authGeneration&&this.psim.identity()?.accountScope===identity.accountScope;
    try{
      if(!await this.waitForObservation()||!current())return;
      await this.acquireEditor();
      try{const capture=await this.capture();if(!current())return;this.adopt(capture);this.publish();if(!current())return;}finally{this.setBusy(false);}
      const result=await this.psim.queryOriginalIdentifier(identifier,request.signal);
      if(!current())return;
      await this.acquireEditor();
      try{const capture=await this.capture();if(!current())return;this.adopt(capture);this.publish();if(!current())return;}finally{this.setBusy(false);}
      this.order={identifier:result.identifier,status:result.found?'ready':'empty',fields:result.fields,error:null};this.publish();
    }catch(error){if(current()){const code=error instanceof Error?error.message:'';this.order={identifier,status:'failed',fields:[],error:ORDER_FAILURES[code]??(/^PSIM_HTTP_(?:401|423)$/.test(code)?ORDER_FAILURES.AUTH_CHANGED:'订单查询未完成，请检查网络连接后重试。')};this.publish();}}
    finally{if(this.orderRequest===request)this.orderRequest=undefined;}
  }
  private orderSummaries=new Map<string,OrderSummaryEntry>();
  private clearOrderSummaries(){for(const entry of this.orderSummaries.values())entry.controller.abort();this.orderSummaries.clear();}
  /**
   * Read-only plan snapshot for the order shown under 用户信息. Expected outcomes (login, permission, context)
   * resolve as results because the page bridge drops rejection reasons.
   */
  async orderSummary(intent:OrderSummaryIntent):Promise<OrderSummaryResult>{
    if(!isOrderSummaryIntent(intent))throw new Error('INVALID_ACTION');
    const {identifier}=intent,failed=(reason:OrderSummaryFailure):OrderSummaryResult=>({status:'failed',identifier,reason});
    await this.sessionStarting;
    if(this.closed||!this.external||this.captured?.source!=='verified-editor'||!this.state.messageSurface?.active||intent.conversationKey!==this.context())return failed('context');
    const identity=this.psim.identity();
    if(!identity||this.state.auth!=='ready')return failed('login');
    if(!identity.permissions.includes('complaint_records'))return failed('permission');
    if(!this.psim.queryOrderSummary)return failed('unavailable');
    const scope=JSON.stringify([identity.accountScope,identity.authGeneration]),key=JSON.stringify([identity.accountScope,identity.authGeneration,identifier]);
    for(const [other,entry] of this.orderSummaries)if(entry.scope!==scope){entry.controller.abort();this.orderSummaries.delete(other);}
    const now=Date.now(),cached=this.orderSummaries.get(key);
    if(cached&&!cached.settled)return cached.promise;
    const age=cached?now-cached.at:Infinity;
    if(cached?.settled&&age>=0&&age<ORDER_SUMMARY_TTL_MS&&!(intent.refresh&&age>=ORDER_SUMMARY_REFRESH_MS))return cached.settled;
    this.orderSummaries.delete(key);
    const controller=new AbortController(),entry:OrderSummaryEntry={at:now,scope,controller,promise:Promise.resolve(failed('unavailable'))};
    const sameIdentity=()=>{const current=this.psim.identity();return !!current&&current.accountScope===identity.accountScope&&current.authGeneration===identity.authGeneration;};
    entry.promise=(async():Promise<OrderSummaryResult>=>{
      try{
        const summary=await this.psim.queryOrderSummary!(identifier,controller.signal);
        if(this.closed||controller.signal.aborted||!sameIdentity())throw new Error('AUTH_CHANGED');
        // The page validates again; a projection that fails the shared shape is reported, never forwarded.
        const result=parseOrderSummaryResult(summary.plans.length?{status:'ready',summary,fetchedAt:Date.now()}:{status:'empty',identifier});
        if(!result)throw new Error('ORDER_RESPONSE_INVALID');
        if(this.orderSummaries.get(key)===entry)entry.settled=result;
        return result;
      }catch(error){
        if(this.orderSummaries.get(key)===entry)this.orderSummaries.delete(key);
        const code=error instanceof Error?error.message:'';
        return failed(ORDER_SUMMARY_FAILURES[code]??(this.psim.identity()?'unavailable':'login'));
      }
    })();
    this.orderSummaries.set(key,entry);
    for(const [other,value] of this.orderSummaries){if(this.orderSummaries.size<=ORDER_SUMMARY_ENTRIES)break;if(value.settled)this.orderSummaries.delete(other);}
    return entry.promise;
  }
  async presentLogin(url:string){
    ownedLoginURL(url);if(this.closed||this.loginOpening&&(this.loginOpening.epoch!==this.connectionEpoch||this.loginOpening.generation!==this.loginGeneration))return;
    this.loginPopover={id:randomUUID(),url};this.publish();
  }
  async closeLogin(id:string){
    if(!isLoginPopoverId(id))throw new Error('INVALID_ACTION');
    if(this.loginPopover?.id!==id)return;this.loginPopover=undefined;this.publish();
  }
  async openLogin(){const opening={epoch:this.connectionEpoch,generation:this.loginGeneration};this.loginOpening=opening;try{await this.psim.openLogin();}catch(error){if(!this.closed&&this.loginOpening===opening&&opening.epoch===this.connectionEpoch&&opening.generation===this.loginGeneration)this.fail(error);}finally{if(this.loginOpening===opening)this.loginOpening=undefined;}}
  async logout(){
    const scope=this.waitScope??this.sessionIdentity??null;this.sessionIdentity=undefined;this.switchWaitScope(null);const cleared=scope?this.outboundWaitStore?.clear(scope):undefined;
    this.loginGeneration++;this.loginPopover=undefined;this.clearPendingSend();this.clearOrder();this.clearOrderSummaries();this.translationIntent++;this.invalidate();this.lastWritten=undefined;this.attempted=undefined;this.suppressed=undefined;this.state.auth='connecting';this.state.error=null;this.publish();
    try{await Promise.all([this.psim.logout(),cleared]);this.state.auth='needs_login';this.state.accountScope='unknown';this.state.phase='idle';this.state.error=null;this.publish();}
    catch(error){this.state.auth='failed';this.fail(error);}
  }
  async dispose(){this.loginPopover=undefined;this.closed=true;clearTimeout(this.customerResolutionTimer);this.customerResolutionGeneration++;this.connectionAbort?.abort();this.dropReconnect();this.clearPendingSend();this.clearOrder();this.clearOrderSummaries();this.updatePolling();this.invalidate();this.waitController.dispose();this.listeners.clear();this.retireInteractions();const external=this.external;this.external=undefined;await external?.close().catch(()=>{});await this.orderClosing;await this.psim.dispose();}
}
