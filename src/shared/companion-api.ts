import type { NativeWindow } from './types';
import type { OutboundMode, PanelTarget } from './workbench';
export interface SurfaceRect {x:number;y:number;width:number;height:number}
export interface MessageSurface {active:boolean;composerRect:SurfaceRect|null;toolbarRect:SurfaceRect|null}
export interface OrderViewport {width:number;height:number;dpr:number;clientOffset?:{x:number;y:number}}
export interface OrderEntry {identifier:string;identifierType:'order_number'|'iccid'|'eiccid';rect:{x:number;y:number;width:number;height:number}}
export interface StandaloneState {
  attached:boolean; targetInstanceId:string|null; nativeStatus:string;
  auth:'ready'|'needs_login'|'connecting'|'failed'; accountScope:string;
  draft:{text:string;canReplace:boolean}|null; preview:string|null;
  phase:'idle'|'reading'|'translating'|'ready'|'stale'|'failed'|'replaced'|'waiting'|'replacing';
  customerLanguage?:string; followCustomerLanguage?:boolean;
  autoTranslate?:boolean; shortcutEnabled?:boolean; translationPaused?:boolean;
  /** `send`: Enter sends the reviewed translation; `replace`: Enter is left to the vendor and translations only replace the draft. */
  outboundMode?:OutboundMode; sendPending?:boolean;
  error:string|null; language:PanelTarget; browserOpen:boolean;
  composerSource:'uia'|'verified-editor'|'unavailable';
  orderEntries:OrderEntry[]; orderViewport:OrderViewport|null;
  messageSurface?:MessageSurface;
}
export interface StandaloneAPI {
  /** Installed helpers attach through the vendor bootstrap and cannot launch the standalone path. */
  readonly canStartClient:boolean;
  getState():Promise<StandaloneState>;
  onState(listener:(state:StandaloneState)=>void):()=>void;
  listWindows():Promise<NativeWindow[]>;
  bindWindow(id:string):Promise<void>; unbindWindow():Promise<void>;
  startClient():Promise<void>;
  connectComposer():Promise<void>; readDraft():Promise<void>;
  setTranslationOptions(options:{language?:PanelTarget;autoTranslate?:boolean;shortcutEnabled?:boolean;outboundMode?:OutboundMode}):Promise<void>;
  cancelTranslation():Promise<void>; resumeTranslation():Promise<void>;
  translate(target:PanelTarget):Promise<void>; replaceDraft():Promise<void>;
  openLogin():Promise<void>; logout():Promise<void>;
  openOrder(identifier:string,type:'order_number'|'iccid'|'eiccid'):Promise<void>;
  closeOrder():Promise<void>; minimize():Promise<void>; close():Promise<void>;
  copyTranslation():Promise<void>; openTranslation():Promise<void>;
  openSettings():Promise<void>;
}
declare global { interface Window { standalone:StandaloneAPI } }
