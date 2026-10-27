import {RUNTIME_PLATFORM} from '../runtime/build-manifest';
import {isLoginPopoverId} from '../src/shared/owned-login';
import { isOrderWindowIntent, type OrderWindowIntent, isOutboundMode, isPanelTarget, type OutboundMode, type PanelState, type PanelTarget } from '../src/shared/workbench';
import {isCustomerLanguageReport,type CustomerLanguageResolution} from '../src/shared/customer-language';
import type { StandaloneState } from '../src/shared/companion-api';
import type { OperatorSessionGrant } from '../src/shared/workbench';
import type {RuntimeLogEntry} from './runtime-diagnostics';
import {isOrderSummaryIntent,type OrderSummaryIntent,type OrderSummaryResult} from '../src/shared/order-summary';

/** The only state sent to the vendor renderer. Authentication credentials stay in the host. */
export function embeddedPanelState(state:StandaloneState,conversationKey:string|null=null):PanelState {
  const status:PanelState['status']=state.auth==='needs_login'?'needs_login':state.auth==='failed'?'failed':state.auth==='connecting'?'unavailable':!state.attached||state.composerSource!=='verified-editor'?'unavailable':state.phase==='ready'?'ready':state.phase==='translating'?'translating':state.phase==='stale'?'stale':state.phase==='failed'?'failed':'idle';
  let hinted:string|null=null;
  try{const parts=JSON.parse(conversationKey??'null'),hint=state.currentOrderHint;if(Array.isArray(parts)&&parts.length===4&&hint&&hint.conversationId===parts[1]&&/^[A-Za-z0-9_-]{4,80}$/.test(hint.identifier))hinted=hint.identifier;}catch{/* An invalid context cannot admit a hint. */}
  return {...(RUNTIME_PLATFORM==='win32'||state.currentOrderHint!==undefined?{detectedOrder:{identifier:state.messageSurface?.active&&conversationKey?(hinted??(RUNTIME_PLATFORM==='win32'&&state.orderEntries.length===1?state.orderEntries[0].identifier:null)):null}}:{}),auth:state.auth,sessionMode:state.sessionMode,conversationKey:state.messageSurface?.active?conversationKey:null,draft:state.draft?{text:state.draft.text,composing:!state.draft.canReplace}:null,enabled:state.autoTranslate!==false,target:state.language,fallbackTarget:state.fallbackTarget??'en',followCustomer:{lang:state.customerLanguage??'unknown',following:state.followCustomerLanguage!==false,manualEnabled:false,resolution:state.customerLanguageResolution},status,preview:state.preview,error:state.error,busy:['reading','replacing','translating'].includes(state.phase),translationPaused:state.translationPaused===true,outboundMode:state.outboundMode??'send',sendPending:state.sendPending===true};
}

export interface EmbeddedActions {
  getState():StandaloneState;
  getRuntimeLogs?():RuntimeLogEntry[];
  openOrder?(intent:OrderWindowIntent):Promise<void>;
  queryOrder?(identifier:string,conversationKey?:string):Promise<void>;
  operatorSession?(intent:OrderWindowIntent):Promise<OperatorSessionGrant>;
  closeOrder?():Promise<void>;
  orderSummary?(intent:OrderSummaryIntent):Promise<OrderSummaryResult>;
  setTranslationOptions(options:{fallbackTarget?:PanelTarget;language?:PanelTarget;autoTranslate?:boolean;outboundMode?:OutboundMode}):Promise<void>;
  reportCustomerLanguage(language:string,conversationKey:string,resolution?:CustomerLanguageResolution):Promise<void>;
  followCustomerLanguage():Promise<void>;
  translate(language:PanelTarget):Promise<void>;
  replaceDraft():Promise<void>;
  cancelTranslation():Promise<void>;
  resumeTranslation():Promise<void>;
  openLogin():Promise<void>;
  closeLogin(id:string):Promise<void>;
  logout():Promise<void>;
}

/** Fixed intents only: the renderer cannot supply text, snapshots, URLs or a send action. `operatorSession` returns its scoped grant; `getRuntimeLogs` returns sanitized diagnostics; `orderSummary` returns the projected plan card. */
export async function invokeEmbeddedAction(service:EmbeddedActions,action:string,args:unknown[]):Promise<OperatorSessionGrant|RuntimeLogEntry[]|OrderSummaryResult|void> {
  if(!Array.isArray(args))throw new Error('INVALID_ACTION');
  const value=args[0],record=value as Record<string,unknown>;
  const object=(keys:string)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys;
  switch(action){
    case 'getRuntimeLogs':if(args.length||!service.getRuntimeLogs)break;return service.getRuntimeLogs();
    case 'setEnabled':if(args.length!==1||typeof value!=='boolean')break;await service.setTranslationOptions({autoTranslate:value});return;
    case 'setTarget':if(args.length!==1||!object('lang,source')||record.source!=='manual'||!isPanelTarget(record.lang))break;await service.setTranslationOptions({language:record.lang});return;
    case 'setFallbackTarget':if(args.length!==1||!isPanelTarget(value))break;await service.setTranslationOptions({fallbackTarget:value});return;
    case 'followCustomer':if(args.length)break;await service.followCustomerLanguage();return;
    case 'customerLanguage':if(args.length!==1||!isCustomerLanguageReport(record))break;await service.reportCustomerLanguage(record.lang,record.conversationKey,record.resolution);return;
    case 'apply':if(args.length!==1||!object('mode')||record.mode!=='replace')break;await service.replaceDraft();return;
    case 'setOutboundMode':if(args.length!==1||!isOutboundMode(value))break;await service.setTranslationOptions({outboundMode:value});return;
    case 'retry':if(args.length)break;await service.translate(service.getState().language);return;
    case 'closeLogin':if(args.length!==1||!isLoginPopoverId(value))break;await service.closeLogin(value);return;
    case 'openOrder':if(args.length!==1||!isOrderWindowIntent(value)||!service.openOrder)break;await service.openOrder(value);return;
    case 'queryOrder':if(args.length!==1||!isOrderWindowIntent(value)||!service.queryOrder||service.getState().sessionMode!=='owned')break;await service.queryOrder(value.identifier,value.conversationKey);return;
    case 'operatorSession':if(args.length!==1||!isOrderWindowIntent(value)||!service.operatorSession)break;return service.operatorSession(value);
    case 'closeOrder':if(args.length||!service.closeOrder)break;await service.closeOrder();return;
    case 'orderSummary':if(args.length!==1||!isOrderSummaryIntent(value)||!service.orderSummary)break;return service.orderSummary(value);
    case 'openLogin':if(args.length)break;await service.openLogin();return;
    case 'logout':if(args.length)break;await service.logout();return;
    case 'cancel':if(args.length)break;await service.cancelTranslation();return;
    case 'resume':if(args.length)break;await service.resumeTranslation();return;
  }
  throw new Error('INVALID_ACTION');
}
