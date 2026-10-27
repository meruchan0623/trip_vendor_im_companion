import {mountPageFeatures,type PageFeatures,type PageGeometry} from './page/index';
import type {PanelState} from '../src/shared/workbench';
import {VERIFIED_RUNTIME_BUILD,RUNTIME_PLATFORM,WINDOWS_DYNAMIC_RUNTIME,validateWindowsRuntimeBuild,validateMacRuntimeBuild,type RuntimeBuild} from './build-manifest';
export interface RuntimeUiMetadata {leaseId:string;aresVersion:typeof VERIFIED_RUNTIME_BUILD.aresVersion;htmlSha256:string;rendererSha256:string;keyboardBoundary:'isolated-world-shadow';windowsBuild?:RuntimeBuild;macBuild?:RuntimeBuild}
export interface RuntimeUiHandle {heartbeat(sequence:number):void;detach():Promise<void>;geometry():RuntimeGeometry;boundary():true;updateWorkbench(state:PanelState):boolean;respondWorkbench(id:string,ok:boolean,value?:unknown):void}
export type RuntimeGeometry=PageGeometry;
/** Factory only. Loading this runtime artifact never mounts anything by itself; the page features live in ./page. */
export function mountRuntimeUi(metadata:RuntimeUiMetadata,document:Document=window.document,bridge?:{bindingName:string;state:PanelState}|null,options:{origin?:string;prewarmDelayMs?:number}={}):RuntimeUiHandle {
  const view=document.defaultView;const location=view?.location;
  let build=VERIFIED_RUNTIME_BUILD;
  // Only the owned Node policy supplies this per-installation identity, after validating loaded resource bytes.
  if(RUNTIME_PLATFORM==='win32'&&metadata.windowsBuild){try{build=validateWindowsRuntimeBuild(metadata.windowsBuild);}catch{throw new Error('UNAPPROVED_METADATA');}}
  else if(RUNTIME_PLATFORM==='win32'&&WINDOWS_DYNAMIC_RUNTIME)throw new Error('UNAPPROVED_METADATA');
  if(RUNTIME_PLATFORM==='darwin'){if(!metadata.macBuild||metadata.windowsBuild)throw new Error('UNAPPROVED_METADATA');try{build=validateMacRuntimeBuild(metadata.macBuild);}catch{throw new Error('UNAPPROVED_METADATA');}}
  else if(metadata.macBuild)throw new Error('UNAPPROVED_METADATA');
  const documentPath=decodeURIComponent(new URL(build.documentURL).pathname),rendererPath=decodeURIComponent(new URL(build.rendererURL).pathname);
  if(!location||location.protocol!=='file:'||location.host||location.search||location.hash||decodeURIComponent(location.pathname).toLowerCase()!==documentPath.toLowerCase())throw new Error('UNAPPROVED_DOCUMENT');
  // Panel attachment intentionally pauses while hidden. Refuse before reserving a lease or adding listeners.
  if(document.visibilityState!=='visible')throw new Error('IM_TARGET_INACTIVE');
  if(metadata.aresVersion!==build.aresVersion||metadata.htmlSha256!==build.htmlSha256||metadata.rendererSha256!==build.rendererSha256||metadata.keyboardBoundary!=='isolated-world-shadow'||Object.keys(metadata).length!==(metadata.windowsBuild||metadata.macBuild?6:5)||!/^[a-z0-9-]{16,100}$/i.test(metadata.leaseId))throw new Error('UNAPPROVED_METADATA');
  if(![...document.scripts].some(script=>{try{const url=new URL(script.src);return url.protocol==='file:'&&!url.host&&!url.search&&!url.hash&&decodeURIComponent(url.pathname).toLowerCase()===rendererPath.toLowerCase();}catch{return false;}}))throw new Error('UNAPPROVED_RENDERER');
  if(!document.getElementById('root')||document.documentElement.hasAttribute('data-tsim-runtime-lease'))throw new Error('UNAPPROVED_LAYOUT_OR_ALREADY_ATTACHED');
  const binding=bridge&&/^tsim_[a-f0-9]{32}$/.test(bridge.bindingName)?(view as unknown as Record<string,unknown>)[bridge.bindingName]:undefined;
  if(bridge&&typeof binding!=='function')throw new Error('OWNED_BINDING_MISSING');
  let disposed=false,lastHeartbeat=Date.now(),lastSequence=0,counter=0,features:PageFeatures|undefined,watchdog:number|undefined,detachment:Promise<void>|undefined;
  const pending=new Map<string,{resolve:(value:unknown)=>void;reject:()=>void;timer:number}>();
  /** Page -> Node intents travel only through the owned CDP binding; replies come back via respondWorkbench. */
  const invoke=(action:string,args:unknown[]=[])=>new Promise<unknown>((resolve,reject)=>{if(disposed||typeof binding!=='function'){reject(new Error('SERVICE_DISCONNECTED'));return;}const id=String(++counter);const timer=view.setTimeout(()=>{pending.delete(id);reject(new Error('ACTION_TIMEOUT'));},35000);pending.set(id,{resolve,reject:()=>reject(new Error('ACTION_FAILED')),timer});(binding as (value:string)=>void)(JSON.stringify({id,action,args}));});
  const detach=async():Promise<void>=>{if(detachment)return detachment;disposed=true;if(watchdog!==undefined)view.clearInterval(watchdog);view.removeEventListener('pagehide',pagehide);for(const request of pending.values()){view.clearTimeout(request.timer);request.reject();}pending.clear();try{features?.dispose();}finally{features=undefined;if(document.documentElement.getAttribute('data-tsim-runtime-lease')===metadata.leaseId)document.documentElement.removeAttribute('data-tsim-runtime-lease');if(window.tsimRuntimeFactory?.mount===mountRuntimeUi)delete window.tsimRuntimeFactory;}detachment=Promise.resolve();return detachment;};
  const pagehide=()=>{void detach().catch(()=>{});};
  const boundary=():true=>{try{if(disposed||!features||document.documentElement.getAttribute('data-tsim-runtime-lease')!==metadata.leaseId)throw new Error('OWNED_FRAME_BOUNDARY_FAILED');return features.boundary();}catch{void detach().catch(()=>{});throw new Error('OWNED_FRAME_BOUNDARY_FAILED');}};
  // Arm self cleanup before touching the original page.
  try{
    watchdog=view.setInterval(()=>{try{boundary();if(Date.now()-lastHeartbeat>=6000)void detach().catch(()=>{});}catch{/* boundary already revoked its lease */}},1000);view.addEventListener('pagehide',pagehide);
    document.documentElement.setAttribute('data-tsim-runtime-lease',metadata.leaseId);
    features=mountPageFeatures(document,{...(bridge?{bridge:{invoke},state:bridge.state}:{}),...options});boundary();
  }catch(error){void detach().catch(()=>{});throw error;}
  return{detach,boundary,
    updateWorkbench(next){boundary();features!.update(next);const host=features!.panel?.host,preview=host?.shadowRoot?.querySelector<HTMLElement>('.preview'),body=host?.shadowRoot?.querySelector<HTMLElement>('.body');return !!next.preview&&next.enabled&&next.auth==='ready'&&next.status==='ready'&&!next.translationPaused&&document.visibilityState!=='hidden'&&!!host?.isConnected&&!!preview&&!preview.hidden&&!body?.hidden&&preview.textContent===next.preview&&host.getClientRects().length>0;},
    respondWorkbench(id,ok,value){const request=pending.get(id);if(!request)return;pending.delete(id);view.clearTimeout(request.timer);if(ok)request.resolve(value);else request.reject();},
    geometry(){if(disposed)throw new Error('LEASE_ENDED');boundary();return features!.geometry();},
    heartbeat(sequence){if(disposed)throw new Error('LEASE_ENDED');boundary();if(!Number.isSafeInteger(sequence)||sequence<=lastSequence)throw new Error('STALE_HEARTBEAT');lastSequence=sequence;lastHeartbeat=Date.now();},
  };
}
declare global {interface Window {tsimRuntimeFactory?:{mount:typeof mountRuntimeUi}}}
if(typeof window!=='undefined')Object.defineProperty(window,'tsimRuntimeFactory',{value:Object.freeze({mount:mountRuntimeUi}),configurable:true});
