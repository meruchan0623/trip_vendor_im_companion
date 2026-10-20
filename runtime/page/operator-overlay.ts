import type {OperatorIdentifierType,QueryIdentifierEntry} from './identifiers';
import type {OperatorSessionGrant} from '../../src/shared/workbench';
/** Each explicit query opens the original TSim page in a fresh browsing context. */
/** Configurable TSim base origin; messages from any other origin are ignored. */
export const TSIM_OPERATOR_ORIGIN='https://csagent.tsim.tech';
export const OPERATOR_FRAME_ID='tsim-operator-frame';
export const OPERATOR_LOADING_ID='tsim-operator-loading';
export const OPERATOR_VIEWPORT_ID='tsim-operator-viewport';
export const OPEN_TIMEOUT_MS=8000,FALLBACK_BOUNDS_DELAY_MS=1500,BOUNDS_POLL_INTERVAL_MS=500,BOUNDS_POLL_LIMIT=15,PREWARM_DELAY_MS=1200;
export const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface OperatorRect {x:number;y:number;width:number;height:number}
export interface OperatorRequest {identifier:string;identifierType?:OperatorIdentifierType;requestId:string}
type Capability='requestId'|'basicReady'|'queryTerminal'|'openingDiagnostics';
const CAPABILITIES:readonly Capability[]=['requestId','basicReady','queryTerminal','openingDiagnostics'];
export type OperatorChildMessage=
  |{type:'TSIM_OPERATOR_READY';version:2;mode:'host';capabilities?:Capability[]}
  |{type:'TSIM_OPERATOR_NEEDS_LOGIN'}
  |{type:'TSIM_OPERATOR_BOUNDS';version:1;identifier:string;rect:OperatorRect}
  |{type:'TSIM_OPERATOR_CLOSE'|'TSIM_OPERATOR_LOADED'|'TSIM_OPERATOR_FOCUS';version?:1;identifier:string}
  |{type:'TSIM_OPERATOR_NEEDS_LOGIN'|'TSIM_OPERATOR_NEEDS_SESSION'|'TSIM_OPERATOR_FOCUS'|'TSIM_OPERATOR_CLOSE'|'TSIM_OPERATOR_LOADED'|'TSIM_OPERATOR_BASIC_READY';version:2;identifier:string;requestId:string}
  |{type:'TSIM_OPERATOR_BOUNDS';version:2;identifier:string;requestId:string;rect:OperatorRect}
  |{type:'TSIM_OPERATOR_QUERY_TERMINAL';version:2;identifier:string;requestId:string;outcome:'unavailable'|'failed'};
function parseCapabilities(value:unknown):Capability[]|undefined|null{if(value===undefined)return undefined;if(!Array.isArray(value)||value.some(item=>!CAPABILITIES.includes(item)))return null;return new Set(value).size===value.length?value as Capability[]:null;}
/** V2 result events echo requestId; legacy viewport events require a unique per-open source at the caller. */
export function parseOperatorChildMessage(value:unknown,current:{identifier:string;requestId?:string}|null):OperatorChildMessage|null{
  if(!value||typeof value!=='object')return null;const m=value as Record<string,unknown>;
  if(m.type==='TSIM_OPERATOR_READY'&&m.version===2&&m.mode==='host'){const capabilities=parseCapabilities(m.capabilities);if(capabilities===null)return null;return{type:m.type,version:2,mode:'host',...(capabilities?{capabilities}:{})};}
  // Legacy viewport events are accepted only inside the unique per-open iframe source.
  if(current&&m.identifier===current.identifier&&(m.version===1||m.version===undefined)){if(m.type==='TSIM_OPERATOR_BOUNDS'&&m.version===1){const rect=m.rect as OperatorRect;if(rect&&Object.values(rect).length===4&&[rect.x,rect.y,rect.width,rect.height].every(Number.isFinite))return{type:m.type,version:1,identifier:current.identifier,rect};}if(['TSIM_OPERATOR_CLOSE','TSIM_OPERATOR_LOADED','TSIM_OPERATOR_FOCUS'].includes(String(m.type)))return{type:m.type as 'TSIM_OPERATOR_CLOSE',identifier:current.identifier};}
  if(current&&m.type==='TSIM_OPERATOR_NEEDS_LOGIN'&&m.version===undefined)return{type:m.type};
  if(!current?.requestId||m.version!==2||m.identifier!==current.identifier||m.requestId!==current.requestId)return null;
  const base={version:2 as const,identifier:current.identifier,requestId:current.requestId};
  if(m.type==='TSIM_OPERATOR_BOUNDS'){const rect=m.rect as OperatorRect;if(!rect||!['x','y','width','height'].every(k=>typeof (rect as unknown as Record<string,unknown>)[k]==='number'&&Number.isFinite((rect as unknown as Record<string,number>)[k])))return null;return{type:m.type,...base,rect};}
  if(m.type==='TSIM_OPERATOR_QUERY_TERMINAL'&&(m.outcome==='unavailable'||m.outcome==='failed'))return{type:m.type,...base,outcome:m.outcome};
  if(['TSIM_OPERATOR_NEEDS_LOGIN','TSIM_OPERATOR_NEEDS_SESSION','TSIM_OPERATOR_FOCUS','TSIM_OPERATOR_CLOSE','TSIM_OPERATOR_LOADED','TSIM_OPERATOR_BASIC_READY'].includes(String(m.type)))return{type:m.type as 'TSIM_OPERATOR_CLOSE',...base};
  return null;
}
/** Clip a rect into the viewport; null when invalid or fully outside. */
export function clampOperatorRect(value:unknown,viewportWidth:number,viewportHeight:number):OperatorRect|null{
  if(!value||typeof value!=='object')return null;const rect=value as OperatorRect;
  if(![rect.x,rect.y,rect.width,rect.height,viewportWidth,viewportHeight].every(Number.isFinite)||rect.width<=0||rect.height<=0||viewportWidth<=0||viewportHeight<=0)return null;
  const left=Math.max(0,rect.x),top=Math.max(0,rect.y),right=Math.min(viewportWidth,rect.x+rect.width),bottom=Math.min(viewportHeight,rect.y+rect.height);
  return right>left&&bottom>top?{x:left,y:top,width:right-left,height:bottom-top}:null;
}
export function operatorFrameURL(origin=TSIM_OPERATOR_ORIGIN,request?:OperatorRequest){
  const url=new URL('/embed/operator',origin);url.searchParams.set('source','travel-merchant-companion');
  if(!request){url.searchParams.set('mode','host');return url.href;}
  // Direct loading also works when a file:// parent cannot complete a postMessage handshake.
  // `session=handoff`: the page asks this parent for the companion's verified TSim session before routing to login.
  url.searchParams.set('session','handoff');url.searchParams.set('identifier',request.identifier);if(request.identifierType)url.searchParams.set('identifierType',request.identifierType);if(UUID_RE.test(request.requestId))url.searchParams.set('requestId',request.requestId);return url.href;
}
export interface OperatorOverlay {open(entry:QueryIdentifierEntry):void;close():void;prewarm():void;dispose():void;readonly frame:HTMLIFrameElement|null;readonly visible:boolean;readonly active:OperatorRequest|null;readonly bounds:OperatorRect|null}
/** Standard TSim query window: 90% of the viewport, centered (same as the agent workbench). */
export const STANDARD_WINDOW_RATIO=0.9;
export function standardOperatorRect(viewportWidth:number,viewportHeight:number):OperatorRect{
  const width=Math.round(viewportWidth*STANDARD_WINDOW_RATIO),height=Math.round(viewportHeight*STANDARD_WINDOW_RATIO);
  return{x:Math.round((viewportWidth-width)/2),y:Math.round((viewportHeight-height)/2),width,height};
}
/**
 * The iframe always spans the whole BrowserView viewport, so the TSim page lays out, drags and resizes its
 * own AgentWindow exactly like the agent workbench. A clipping viewport follows the reported window bounds so
 * only the window area is visible and receives input; the rest of the original page stays usable.
 */
export function createOperatorOverlay(document:Document,options:{origin?:string;prewarmDelayMs?:number;randomUUID?:()=>string;requestSession?:(request:OperatorRequest)=>Promise<OperatorSessionGrant>}={}):OperatorOverlay{
  const view=document.defaultView!,parsed=new URL(options.origin??TSIM_OPERATOR_ORIGIN);
  if(parsed.protocol!=='https:')throw new Error('OPERATOR_HTTPS_REQUIRED');
  const origin=parsed.origin;
  let frame:HTMLIFrameElement|null=null,clip:HTMLElement|null=null,active:OperatorRequest|null=null,visible=false,disposed=false,timer:number|undefined,status:HTMLElement|null=null,statusText:HTMLElement|null=null,reported:OperatorRect|null=null,bounds:OperatorRect|null=null;
  const clearTimer=()=>{view.clearTimeout(timer);timer=undefined;};
  const message=(text:string)=>{if(statusText)statusText.textContent=text;};
  /** Window bounds from the page, or the standard centered window until the page reports one (loading/login). */
  function layout(){
    if(!clip||!frame)return;const width=view.innerWidth,height=view.innerHeight;
    const rect=(reported&&clampOperatorRect(reported,width,height))??standardOperatorRect(width,height);bounds=rect;
    Object.assign(clip.style,{left:`${rect.x}px`,top:`${rect.y}px`,width:`${rect.width}px`,height:`${rect.height}px`});
    // Placeholder chrome only while the page has not drawn its own window.
    Object.assign(clip.style,reported?{background:'transparent',boxShadow:'none',borderRadius:'0'}:{background:'#fff',boxShadow:'0 6px 24px rgba(0,0,0,.18)',borderRadius:'8px'});
    Object.assign(frame.style,{left:`${-rect.x}px`,top:`${-rect.y}px`,width:`${width}px`,height:`${height}px`});
    // The window has its own close button once drawn; the host control stays for loading, login and failures.
    if(status)status.style.display=reported?'none':'flex';
  }
  function close(){clearTimer();visible=false;active=null;reported=null;bounds=null;frame?.remove();frame=null;clip?.remove();clip=null;status?.remove();status=null;statusText=null;}
  const open=(entry:QueryIdentifierEntry)=>{
    if(disposed||document.visibilityState==='hidden')return;
    const identifier=entry.identifier.trim();if(!/^[A-Za-z0-9_-]{1,100}$/.test(identifier))return;
    close();const requestId=options.randomUUID?.()??view.crypto.randomUUID();if(!UUID_RE.test(requestId))return;
    active={identifier,identifierType:entry.identifierType,requestId};
    clip=document.createElement('div');clip.id=OPERATOR_VIEWPORT_ID;clip.setAttribute('data-tsim-owned','1');clip.style.cssText='position:fixed;overflow:hidden;z-index:2147483000;margin:0;padding:0;border:0';
    const ownFrame=document.createElement('iframe');frame=ownFrame;frame.id=OPERATOR_FRAME_ID;frame.setAttribute('data-tsim-owned','1');frame.title='TSim 订单查询';frame.referrerPolicy='no-referrer';frame.style.cssText='position:absolute;display:block;margin:0;padding:0;border:0;background:transparent;color-scheme:normal';frame.src=operatorFrameURL(origin,active);
    status=document.createElement('div');status.id=OPERATOR_LOADING_ID;status.setAttribute('data-tsim-owned','1');status.style.cssText='position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:2147483001;display:flex;align-items:center;gap:12px;padding:6px 12px;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.12);color:#333;font:13px sans-serif;max-width:calc(100vw - 32px)';
    statusText=document.createElement('span');statusText.setAttribute('role','status');const closeButton=document.createElement('button');closeButton.type='button';closeButton.textContent='关闭订单';closeButton.addEventListener('click',close);status.append(statusText,closeButton);
    for(const type of ['click','keydown','keyup','mousedown','pointerdown'])status.addEventListener(type,e=>e.stopPropagation());
    message('正在打开 TSim 订单页，请在页面内查看加载、登录和查询结果。');
    ownFrame.addEventListener('load',()=>{if(frame!==ownFrame)return;clearTimer();message('TSim 页面已打开；登录和查询结果以页面显示为准。');});
    ownFrame.addEventListener('error',()=>{if(frame!==ownFrame)return;clearTimer();message('TSim 页面加载异常，请查看页面或关闭后重试。');});
    visible=true;clip.append(frame);document.body.append(clip,status);layout();
    timer=view.setTimeout(()=>{if(frame===ownFrame)message('TSim 页面仍在加载，请查看下方页面或关闭后重试。');},OPEN_TIMEOUT_MS);
  };
  const onMessage=(event:MessageEvent)=>{
    if(disposed||!frame||!active||event.origin!==origin||event.source!==frame.contentWindow||document.visibilityState==='hidden')return;
    const m=parseOperatorChildMessage(event.data,active);if(!m)return;
    switch(m.type){
      case 'TSIM_OPERATOR_CLOSE':close();break;
      case 'TSIM_OPERATOR_BOUNDS':if(clampOperatorRect(m.rect,view.innerWidth,view.innerHeight)){reported={...m.rect};layout();}break;
      case 'TSIM_OPERATOR_NEEDS_SESSION':{
        // The bearer is posted only to this request's frame and only to the fixed TSim origin.
        const request=active,ownFrame=frame,reply=(value:Record<string,unknown>)=>{if(frame===ownFrame&&active===request)ownFrame.contentWindow?.postMessage({version:2,identifier:request.identifier,requestId:request.requestId,...value},origin);};
        message('正在使用助手的 TSim 登录态打开订单…');
        const pending=options.requestSession?options.requestSession({...request}):Promise.reject(new Error('SESSION_UNAVAILABLE'));
        pending.then(grant=>{if(!grant||typeof grant.accessToken!=='string'||!grant.accessToken)throw new Error('SESSION_UNAVAILABLE');reply({type:'TSIM_OPERATOR_SESSION',accessToken:grant.accessToken,sessionRef:typeof grant.sessionRef==='string'?grant.sessionRef:null});},
          ()=>{reply({type:'TSIM_OPERATOR_SESSION_UNAVAILABLE'});if(frame===ownFrame&&active===request)message('助手未能提供 TSim 登录态，请先在助手面板登录，或在下方页面登录。');});
        break;
      }
      case 'TSIM_OPERATOR_NEEDS_LOGIN':clearTimer();reported=null;layout();message('请在下方 TSim 页面完成登录。');break;
      case 'TSIM_OPERATOR_BASIC_READY':case 'TSIM_OPERATOR_LOADED':clearTimer();message('请在下方 TSim 页面查看订单详情。');break;
      case 'TSIM_OPERATOR_QUERY_TERMINAL':clearTimer();message('订单查询未完成，请查看下方 TSim 页面的提示。');break;
    }
  };
  const onVisibility=()=>{if(document.visibilityState==='hidden')close();};
  const onResize=()=>layout();
  const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'&&active){event.preventDefault();event.stopPropagation();close();}};
  view.addEventListener('message',onMessage);view.addEventListener('keydown',onKey,true);view.addEventListener('resize',onResize);document.addEventListener('visibilitychange',onVisibility);
  return{open,close,prewarm(){/* Explicit open only. */},get frame(){return frame;},get visible(){return visible;},get active(){return active?{...active}:null;},get bounds(){return bounds?{...bounds}:null;},dispose(){if(disposed)return;disposed=true;close();view.removeEventListener('message',onMessage);view.removeEventListener('keydown',onKey,true);view.removeEventListener('resize',onResize);document.removeEventListener('visibilitychange',onVisibility);}};
}
