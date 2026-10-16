import type { NativeWindow } from './types';
import type { PanelTarget } from './workbench';
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
  error:string|null; language:PanelTarget; browserOpen:boolean;
  composerSource:'uia'|'verified-editor'|'unavailable';
  orderEntries:OrderEntry[]; orderViewport:OrderViewport|null;
  messageSurface?:MessageSurface;
}
export interface StandaloneAPI {
  getState():Promise<StandaloneState>;
  onState(listener:(state:StandaloneState)=>void):()=>void;
  listWindows():Promise<NativeWindow[]>;
  bindWindow(id:string):Promise<void>; unbindWindow():Promise<void>;
  startClient():Promise<void>;
  connectComposer():Promise<void>; readDraft():Promise<void>;
  setTranslationOptions(options:{language?:PanelTarget;autoTranslate?:boolean;shortcutEnabled?:boolean}):Promise<void>;
  cancelTranslation():Promise<void>; resumeTranslation():Promise<void>;
  translate(target:PanelTarget):Promise<void>; replaceDraft():Promise<void>;
  openLogin():Promise<void>; logout():Promise<void>;
  openOrder(identifier:string,type:'order_number'|'iccid'|'eiccid'):Promise<void>;
  closeOrder():Promise<void>; minimize():Promise<void>; close():Promise<void>;
  copyTranslation():Promise<void>; openTranslation():Promise<void>;
  openSettings():Promise<void>;
}
declare global { interface Window { standalone:StandaloneAPI } }
