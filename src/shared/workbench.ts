import type {LoginPopover} from './owned-login';
import type {CustomerLanguageResolution} from './customer-language';
/** C-end consumer workbench outbound contract; no send capability is represented. */
export const OUTBOUND_CONTRACT_VERSION='deepseek:outbound:v1' as const;
export const WORKBENCH_TARGETS=['zh','en','ja','ko','es','fr','de','ru','pt','it','ar','th','vi','id','ms','zh-TW','tr'] as const;
export type WorkbenchTarget=typeof WORKBENCH_TARGETS[number];
export interface ComposerSnapshot {text:string;conversationId:string;revision:number;composing:boolean;scopeGeneration:number;authGeneration:number;editorIdentity:string;docFingerprint:string;isPlainText:boolean}
export interface VerifiedComposerSnapshot extends ComposerSnapshot {platformAccountScope:string;composerId:string;documentGeneration:number}
export interface PsimIdentity {accountScope:string;authGeneration:number;permissions:string[]}
export interface OutboundBody {text:string;target_lang:WorkbenchTarget;source_lang:'zh';purpose:'outbound';draft_request_id:string;composer_content_version:string}
export interface OutboundResponse {success:true;data:{translated_text:string;draft_request_id:string;composer_content_version:string;source_language?:string;target_language?:string}}
export function outboundFingerprint(snapshot:ComposerSnapshot,target:string){return JSON.stringify([snapshot.conversationId,snapshot.text,target.toLowerCase(),OUTBOUND_CONTRACT_VERSION]);}
export function sameVerifiedDraft(a:VerifiedComposerSnapshot,b:VerifiedComposerSnapshot){return a.text===b.text&&a.conversationId===b.conversationId&&a.revision===b.revision&&a.scopeGeneration===b.scopeGeneration&&a.platformAccountScope===b.platformAccountScope&&a.composerId===b.composerId&&a.documentGeneration===b.documentGeneration&&a.authGeneration===b.authGeneration&&a.editorIdentity===b.editorIdentity&&a.docFingerprint===b.docFingerprint&&a.isPlainText===true&&b.isPlainText===true&&!a.composing&&!b.composing;}
export interface SupplierOrderSelection {sourceIdentifier:string;sourceType:'unverified';conversationId:string;scopeGeneration:number;supplierIdentifier?:string;confirmedSupplier:'tsim'|null}
export interface ReadOnlyOrderField {label:string;value:string}
export interface ReadOnlyOrderDetail {identifier:string;source:'tsim_cs';ownership:'server-authorized';fields:ReadOnlyOrderField[]}
export interface PsimServiceClient {
  identity():PsimIdentity|null;
  translate(body:OutboundBody,signal:AbortSignal):Promise<OutboundResponse>;
  querySupplierOrder(identifier:string,signal:AbortSignal):Promise<ReadOnlyOrderDetail>;
  openLogin():Promise<void>;
}
export interface VerifiedComposerPort {
  readCurrent():Promise<VerifiedComposerSnapshot>;
  /** A compare-and-swap on the exact verified native editor; never emits keyboard or send events. */
  replaceDraft(expected:VerifiedComposerSnapshot,text:string):Promise<void>;
  writeVerified:boolean;
}
/** Outbound panel targets; zh is the agent's own language and never a target. */
export const PANEL_TARGETS=['en','ja','ko','th','vi','id','ms','es','fr','de','ru','ar','zh-TW','pt','it','tr'] as const;
export type PanelTarget=typeof PANEL_TARGETS[number];
export const isPanelTarget=(value:unknown):value is PanelTarget=>typeof value==='string'&&(PANEL_TARGETS as readonly string[]).includes(value);
/** Recognized originals also include Chinese and Greek, which are not outbound panel targets. */
export const CUSTOMER_LANGUAGES=['unknown','zh','el',...PANEL_TARGETS] as const;
export const isCustomerLanguage=(value:unknown):value is typeof CUSTOMER_LANGUAGES[number]=>typeof value==='string'&&(CUSTOMER_LANGUAGES as readonly string[]).includes(value);
export type PanelStatus='unavailable'|'idle'|'translating'|'ready'|'stale'|'failed'|'needs_login';
export type PanelAuth='ready'|'needs_login'|'connecting'|'failed';
/** Host-verified Windows order read, bound to the surrounding PanelState conversation. */
export interface DetectedOrderState {identifier:string|null}
export interface PanelOrderState {identifier:string;status:'idle'|'loading'|'ready'|'empty'|'failed';error:string|null;fields:ReadOnlyOrderField[]}
/** Node -> page state. Text only; no credentials, tokens or editor handles. */
/** Agent bearer handed to the TSim operator iframe inside the merchant page. Never part of PanelState. */
export interface OperatorSessionGrant {accessToken:string;sessionRef:string|null}
export interface OrderWindowIntent {identifier:string;identifierType:'order_number'|'iccid'|'eiccid';conversationKey:string}
export function isOrderWindowIntent(value:unknown):value is OrderWindowIntent {if(!value||typeof value!=='object'||Array.isArray(value))return false;const v=value as Record<string,unknown>;return Object.keys(v).sort().join(',')==='conversationKey,identifier,identifierType'&&typeof v.identifier==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v.identifier)&&['order_number','iccid','eiccid'].includes(String(v.identifierType))&&typeof v.conversationKey==='string'&&v.conversationKey.length>0&&v.conversationKey.length<=2048;}
export interface PanelState {detectedOrder?:DetectedOrderState;sessionMode?:'owned'|'browser';orderWindowMode?:'browser'|'owned';loginPopover?:LoginPopover;translationPaused?:boolean;order?:PanelOrderState;auth:PanelAuth;conversationKey:string|null;draft:{text:string;composing:boolean}|null;enabled:boolean;target:PanelTarget;followCustomer:{lang:string|null;following:boolean;manualEnabled:boolean;resolution?:CustomerLanguageResolution};fallbackTarget?:PanelTarget;status:PanelStatus;preview:string|null;error:string|null;busy:boolean;outboundMode?:OutboundMode;sendPending?:boolean}
export type PanelApplyMode='replace';
export type OutboundMode='send'|'replace';
export const isOutboundMode=(value:unknown):value is OutboundMode=>value==='send'||value==='replace';
