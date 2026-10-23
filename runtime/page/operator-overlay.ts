import type {OperatorIdentifierType,QueryIdentifierEntry} from './identifiers';
import type {OperatorSessionGrant} from '../../src/shared/workbench';
/** The first query boots the original TSim page; later queries reuse that page while the companion session is unchanged. */
/** Configurable TSim base origin; messages from any other origin are ignored. */
export const TSIM_OPERATOR_ORIGIN='https://csagent.tsim.tech';
export const OPERATOR_FRAME_ID='tsim-operator-frame';
export const OPERATOR_LOADING_ID='tsim-operator-loading';
export const OPERATOR_VIEWPORT_ID='tsim-operator-viewport';
/** Separate hidden frame that only opens a TLS connection in the iframe network partition. */
export const OPERATOR_WARM_ID='tsim-operator-warm';
export const WARM_CONNECTION_PATH='/assets/__companion_warm__.txt';
export const WARM_CONNECTION_INTERVAL_MS=30000,WARM_CONNECTION_TIMEOUT_MS=10000,STANDBY_READY_TIMEOUT_MS=8000;
/** Standby boots that time out, reload or fall back to login; after this many prewarm stays off for the overlay's lifetime. */
export const STANDBY_ATTEMPT_LIMIT=3;
export const OPEN_TIMEOUT_MS=8000,FALLBACK_BOUNDS_DELAY_MS=1500,BOUNDS_POLL_INTERVAL_MS=500,BOUNDS_POLL_LIMIT=15,PREWARM_DELAY_MS=1200;
export const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface OperatorRect {x:number;y:number;width:number;height:number}
export interface OperatorRequest {identifier:string;identifierType?:OperatorIdentifierType;requestId:string}
type Capability='requestId'|'basicReady'|'queryTerminal'|'openingDiagnostics'|'hostSession';
const CAPABILITIES:readonly Capability[]=['requestId','basicReady','queryTerminal','openingDiagnostics','hostSession'];
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
/** Host standby page: boots the SPA without a query and waits for SET_IDENTIFIER plus a session handoff. */
export function operatorStandbyURL(origin=TSIM_OPERATOR_ORIGIN){
  const url=new URL('/embed/operator',origin);url.searchParams.set('source','travel-merchant-companion');url.searchParams.set('mode','host');url.searchParams.set('session','handoff');return url.href;
}
export function operatorFrameURL(origin=TSIM_OPERATOR_ORIGIN,request?:OperatorRequest){
  const url=new URL('/embed/operator',origin);url.searchParams.set('source','travel-merchant-companion');
  if(!request){url.searchParams.set('mode','host');return url.href;}
  // Direct loading also works when a file:// parent cannot complete a postMessage handshake.
  // `session=handoff`: the page asks this parent for the companion's verified TSim session before routing to login.
  url.searchParams.set('session','handoff');url.searchParams.set('identifier',request.identifier);if(request.identifierType)url.searchParams.set('identifierType',request.identifierType);if(UUID_RE.test(request.requestId))url.searchParams.set('requestId',request.requestId);return url.href;
}
export interface OperatorOverlay {open(entry:QueryIdentifierEntry):void;close():void;reset():void;prewarm():void;warmConnection():void;dispose():void;readonly frame:HTMLIFrameElement|null;readonly frameURL:string|null;readonly visible:boolean;readonly active:OperatorRequest|null;readonly bounds:OperatorRect|null}
/** Standard TSim query window: 90% of the viewport, centered (same as the agent workbench). */
export const STANDARD_WINDOW_RATIO=0.9;
/** A reused page that does not answer a new identifier within this window is rebuilt from scratch. */
export const REUSE_REVEAL_TIMEOUT_MS=4000;
export function standardOperatorRect(viewportWidth:number,viewportHeight:number):OperatorRect{
  const width=Math.round(viewportWidth*STANDARD_WINDOW_RATIO),height=Math.round(viewportHeight*STANDARD_WINDOW_RATIO);
  return{x:Math.round((viewportWidth-width)/2),y:Math.round((viewportHeight-height)/2),width,height};
}
/**
 * The iframe always spans the whole BrowserView viewport, so the TSim page lays out, drags and resizes its
 * own AgentWindow exactly like the agent workbench. A clipping viewport follows the reported window bounds so
 * only the window area is visible and receives input; the rest of the original page stays usable.
 *
 * Booting the TSim SPA is the expensive part (the vendor client shares one renderer, HTTP/1.1, no GPU), so closing
 * only hides the frame. The next query reuses it via TSIM_OPERATOR_SET_IDENTIFIER, but only after the companion
 * hands out the same bearer the frame adopted; any other answer, a login fallback or a reload rebuilds the frame.
 */
export function createOperatorOverlay(document:Document,options:{origin?:string;prewarmDelayMs?:number;randomUUID?:()=>string;now?:()=>number;requestSession?:(request:OperatorRequest)=>Promise<OperatorSessionGrant>}={}):OperatorOverlay{
  const view=document.defaultView!,parsed=new URL(options.origin??TSIM_OPERATOR_ORIGIN),now=options.now??(()=>Date.now());
  if(parsed.protocol!=='https:')throw new Error('OPERATOR_HTTPS_REQUIRED');
  const origin=parsed.origin;
  let frame:HTMLIFrameElement|null=null,clip:HTMLElement|null=null,active:OperatorRequest|null=null,visible=false,disposed=false,timer:number|undefined,revealTimer:number|undefined,status:HTMLElement|null=null,statusText:HTMLElement|null=null,reported:OperatorRect|null=null,bounds:OperatorRect|null=null;
  // Warm frame: the URL it booted with, the companion bearer it adopted (undefined: not handed over, null: refused),
  // whether it has rendered a query since, and whether it still shows the previous request.
  let frameURL:string|null=null,frameGrant:string|null|undefined,reusable=false,pendingReveal=false,generation=0;
  // A reused frame is revealed only once the grant matched (`awaitingGrant` false) and the page answered the new request.
  let awaitingGrant=false,answered=false;
  // The active request's grant, started at click time; it never rejects (null: unavailable).
  let inflight:{request:OperatorRequest;grant:Promise<OperatorSessionGrant|null>}|null=null;
  // Host standby frame (never adopted a bearer), whether this TSim lacks the hostSession capability, and failed standby boots.
  let standby:'booting'|'ready'|null=null,standbyTimer:number|undefined,hostSessionUnsupported=false,standbyFailures=0;
  let warmFrame:HTMLIFrameElement|null=null,warmTimer:number|undefined,warmAt=-Infinity;
  const clearTimer=()=>{view.clearTimeout(timer);timer=undefined;};
  const clearReveal=()=>{view.clearTimeout(revealTimer);revealTimer=undefined;};
  const message=(text:string)=>{if(statusText)statusText.textContent=text;};
  const post=(value:Record<string,unknown>)=>frame?.contentWindow?.postMessage(value,origin);
  const startGrant=(request:OperatorRequest)=>{
    const pending=options.requestSession?options.requestSession({...request}):Promise.reject(new Error('SESSION_UNAVAILABLE'));
    const grant=pending.then(value=>value&&typeof value.accessToken==='string'&&value.accessToken?value:null,()=>null);
    inflight={request,grant};return grant;
  };
  /** Window bounds from the page, or the standard centered window until the page reports one (loading/login). */
  function layout(){
    if(!clip||!frame||!visible)return;const width=view.innerWidth,height=view.innerHeight;
    // Bounds reported while a reused page is still hidden are remembered but not shown yet.
    const shown=pendingReveal?null:reported;
    const rect=(shown&&clampOperatorRect(shown,width,height))??standardOperatorRect(width,height);bounds=rect;
    Object.assign(clip.style,{visibility:'visible',left:`${rect.x}px`,top:`${rect.y}px`,width:`${rect.width}px`,height:`${rect.height}px`});
    // Placeholder chrome only while the page has not drawn its own window.
    Object.assign(clip.style,shown?{background:'transparent',boxShadow:'none',borderRadius:'0'}:{background:'#fff',boxShadow:'0 6px 24px rgba(0,0,0,.18)',borderRadius:'8px'});
    // A reused page stays invisible until it answers for the new request, so the previous order never flashes.
    Object.assign(frame.style,{visibility:pendingReveal?'hidden':'visible',left:`${-rect.x}px`,top:`${-rect.y}px`,width:`${width}px`,height:`${height}px`});
    // The window has its own close button once drawn; the host control stays for loading, login and failures.
    if(status)status.style.display=shown?'none':'flex';
  }
  function destroyFrame(){clearReveal();view.clearTimeout(standbyTimer);standbyTimer=undefined;standby=null;frame?.remove();frame=null;frameURL=null;frameGrant=undefined;reusable=false;pendingReveal=false;awaitingGrant=false;answered=false;}
  /** Hides the order window; the TSim page stays loaded for the next query. */
  function close(){
    generation++;clearTimer();clearReveal();visible=false;active=null;inflight=null;reported=null;bounds=null;pendingReveal=false;awaitingGrant=false;answered=false;status?.remove();status=null;statusText=null;
    if(frame&&document.activeElement===frame)frame.blur();
    if(frame)frame.style.visibility='hidden';if(clip)clip.style.visibility='hidden';
  }
  /** Drops the TSim page too (including a standby page): account or authorization changes must never reach a warm frame. */
  function reset(){close();destroyFrame();clip?.remove();clip=null;}
  const revealed=()=>{answered=true;if(!pendingReveal||awaitingGrant)return;pendingReveal=false;clearReveal();layout();};
  function ensureClip(){
    if(!clip){clip=document.createElement('div');clip.id=OPERATOR_VIEWPORT_ID;clip.setAttribute('data-tsim-owned','1');clip.style.cssText='position:fixed;overflow:hidden;z-index:2147483000;margin:0;padding:0;border:0;visibility:hidden';document.body.append(clip);}
    return clip;
  }
  function createFrame(url:string){
    const ownFrame=document.createElement('iframe');frame=ownFrame;ownFrame.id=OPERATOR_FRAME_ID;ownFrame.setAttribute('data-tsim-owned','1');ownFrame.title='TSim 订单查询';ownFrame.referrerPolicy='no-referrer';ownFrame.style.cssText='position:absolute;display:block;margin:0;padding:0;border:0;background:transparent;color-scheme:normal';ownFrame.src=url;frameURL=ownFrame.src;
    return ownFrame;
  }
  function boot(request:OperatorRequest){
    destroyFrame();if(!clip)return;
    const ownFrame=createFrame(operatorFrameURL(origin,request));
    let loads=0;
    ownFrame.addEventListener('load',()=>{if(frame!==ownFrame)return;
      // A second load means the page navigated or reloaded itself; it no longer serves this request protocol.
      if(++loads>1){reusable=false;return;}
      if(!active)return;clearTimer();message('TSim 页面已打开；登录和查询结果以页面显示为准。');});
    ownFrame.addEventListener('error',()=>{if(frame!==ownFrame)return;reusable=false;if(!active)return;clearTimer();message('TSim 页面加载异常，请查看页面或关闭后重试。');});
    clip.append(ownFrame);layout();
  }
  /** Old TSim builds without the host session protocol: never prewarm again during this overlay's lifetime. */
  function standbyUnsupported(){hostSessionUnsupported=true;if(standby)destroyFrame();}
  /** A slow, reloading or logged-out standby boot is dropped; prewarm may try again a bounded number of times. */
  function standbyFailed(){standbyFailures++;if(standby)destroyFrame();}
  function prewarm(){
    if(disposed||document.visibilityState==='hidden')return;
    warmConnection();
    if(frame||active||hostSessionUnsupported||standbyFailures>=STANDBY_ATTEMPT_LIMIT||!options.requestSession)return;
    const own=ensureClip(),ownFrame=createFrame(operatorStandbyURL(origin));standby='booting';
    // Lay out at viewport size while invisible, so the SPA renders as it will when shown.
    Object.assign(ownFrame.style,{visibility:'hidden',left:'0px',top:'0px',width:`${view.innerWidth}px`,height:`${view.innerHeight}px`});
    let loads=0;
    ownFrame.addEventListener('load',()=>{if(frame!==ownFrame||++loads<=1)return;reusable=false;
      if(standby&&!active){standbyFailed();return;}
      // The adopted standby reloaded itself (e.g. TSim chunk recovery): its new document is an empty standby that
      // no longer knows the active request, so rebuild a handoff frame for it.
      if(active)boot(active);});
    ownFrame.addEventListener('error',()=>{if(frame===ownFrame&&standby&&!active)standbyFailed();});
    standbyTimer=view.setTimeout(()=>{standbyTimer=undefined;if(frame===ownFrame&&standby==='booting')standbyFailed();},STANDBY_READY_TIMEOUT_MS);
    own.append(ownFrame);
  }
  function warmConnection(){
    if(disposed||document.visibilityState==='hidden'||warmFrame||!document.body)return;
    const at=now();if(at-warmAt<WARM_CONNECTION_INTERVAL_MS)return;warmAt=at;
    // No sandbox: an opaque-origin frame would use a different network partition than the operator frame.
    const own=document.createElement('iframe');warmFrame=own;own.id=OPERATOR_WARM_ID;own.setAttribute('data-tsim-owned','1');own.setAttribute('aria-hidden','true');own.tabIndex=-1;own.referrerPolicy='no-referrer';own.style.display='none';
    const done=()=>{if(warmFrame!==own)return;view.clearTimeout(warmTimer);warmTimer=undefined;own.remove();warmFrame=null;};
    own.addEventListener('load',done);own.addEventListener('error',done);warmTimer=view.setTimeout(done,WARM_CONNECTION_TIMEOUT_MS);
    own.src=new URL(WARM_CONNECTION_PATH,origin).href;document.body.append(own);
  }
  const setIdentifier=(request:OperatorRequest)=>post({type:'TSIM_OPERATOR_SET_IDENTIFIER',version:2,identifier:request.identifier,...(request.identifierType?{identifierType:request.identifierType}:{}),requestId:request.requestId});
  const open=(entry:QueryIdentifierEntry)=>{
    if(disposed||document.visibilityState==='hidden')return;
    const identifier=entry.identifier.trim();if(!/^[A-Za-z0-9_-]{1,100}$/.test(identifier))return;
    close();const requestId=options.randomUUID?.()??view.crypto.randomUUID();if(!UUID_RE.test(requestId))return;
    const request:OperatorRequest={identifier,identifierType:entry.identifierType,requestId},current=generation;active=request;visible=true;
    ensureClip();
    status=document.createElement('div');status.id=OPERATOR_LOADING_ID;status.setAttribute('data-tsim-owned','1');status.style.cssText='position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:2147483001;display:flex;align-items:center;gap:12px;padding:6px 12px;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.12);color:#333;font:13px sans-serif;max-width:calc(100vw - 32px)';
    statusText=document.createElement('span');statusText.setAttribute('role','status');const closeButton=document.createElement('button');closeButton.type='button';closeButton.textContent='关闭订单';closeButton.addEventListener('click',close);status.append(statusText,closeButton);
    for(const type of ['click','keydown','keyup','mousedown','pointerdown'])status.addEventListener(type,e=>e.stopPropagation());
    message('正在打开 TSim 订单页，请在页面内查看加载、登录和查询结果。');document.body.append(status);
    timer=view.setTimeout(()=>{if(active===request)message('TSim 页面仍在加载，请查看下方页面或关闭后重试。');},OPEN_TIMEOUT_MS);
    // The authorization gate starts at click time; the bearer itself is posted only in reply to this request's NEEDS_SESSION.
    const grant=startGrant(request);
    if(frame&&standby==='ready'){
      // A ready standby page shows no previous order: show it now and hand it the identifier.
      standby=null;view.clearTimeout(standbyTimer);standbyTimer=undefined;layout();setIdentifier(request);return;
    }
    if(!frame||!reusable||!frameGrant||!options.requestSession){boot(request);return;}
    const warm=frame,adopted=frameGrant;pendingReveal=true;awaitingGrant=true;answered=false;layout();
    const stale=()=>disposed||generation!==current||active!==request||frame!==warm;
    // The old page still holds its adopted bearer: authorize before sending another order to it.
    revealTimer=view.setTimeout(()=>{if(!stale()&&pendingReveal)boot(request);},REUSE_REVEAL_TIMEOUT_MS);
    void grant.then(value=>{
      if(stale())return;const token=value?.accessToken??null;
      // A refused grant is asked again by the rebuilt frame; a different bearer is reused for its handoff.
      if(!token){if(inflight?.grant===grant)inflight=null;boot(request);return;}
      if(token!==adopted||!reusable){boot(request);return;}
      setIdentifier(request);
      // Reopening the same identifier keeps the page's bounds bridge, which only republishes on request.
      post({type:'TSIM_OPERATOR_REQUEST_BOUNDS',version:1,identifier});
      awaitingGrant=false;if(answered)revealed();
    });
  };
  const onMessage=(event:MessageEvent)=>{
    if(disposed||!frame||event.origin!==origin||event.source!==frame.contentWindow)return;
    const type=(event.data as {type?:unknown}|null)?.type;
    if(standby&&!active){
      // The standby page proves the host session protocol before any query can use it.
      if(type==='TSIM_OPERATOR_READY'&&standby==='booting'){const m=parseOperatorChildMessage(event.data,null);if(m?.type==='TSIM_OPERATOR_READY'&&m.capabilities?.includes('hostSession')){standby='ready';view.clearTimeout(standbyTimer);standbyTimer=undefined;}else standbyUnsupported();}
      else if(type==='TSIM_OPERATOR_NEEDS_LOGIN')standbyFailed();
      return;
    }
    // A hidden frame that falls back to TSim's own login must never be reused: a manual login may be another account.
    if(!active){if(type==='TSIM_OPERATOR_NEEDS_LOGIN'){reusable=false;frameGrant=null;}return;}
    if(document.visibilityState==='hidden')return;
    const m=parseOperatorChildMessage(event.data,active);if(!m)return;
    switch(m.type){
      case 'TSIM_OPERATOR_CLOSE':close();break;
      case 'TSIM_OPERATOR_BOUNDS':if(clampOperatorRect(m.rect,view.innerWidth,view.innerHeight)){reported={...m.rect};reusable=true;revealed();layout();}break;
      case 'TSIM_OPERATOR_NEEDS_SESSION':{
        // The bearer is posted only to this request's frame and only to the fixed TSim origin.
        const request=active,ownFrame=frame,reply=(value:Record<string,unknown>)=>{if(frame===ownFrame&&active===request)ownFrame.contentWindow?.postMessage({version:2,identifier:request.identifier,requestId:request.requestId,...value},origin);};
        message('正在使用助手的 TSim 登录态打开订单…');
        // The click already started this request's grant; a repeated request asks again.
        const pending=inflight?.request===request?inflight.grant:startGrant(request);inflight=null;
        // Every outcome answers the frame: an unanswered request leaves TSim waiting for its own timeout.
        void pending.then(grant=>{
          if(!grant){if(frame===ownFrame)frameGrant=null;reply({type:'TSIM_OPERATOR_SESSION_UNAVAILABLE'});if(frame===ownFrame&&active===request)message('助手未能提供 TSim 登录态，请先在助手面板登录，或在下方页面登录。');return;}
          // A frame that already fell back to login or was refused (null) keeps no reusable grant.
          if(frame===ownFrame&&active===request&&frameGrant!==null)frameGrant=grant.accessToken;
          reply({type:'TSIM_OPERATOR_SESSION',accessToken:grant.accessToken,sessionRef:typeof grant.sessionRef==='string'?grant.sessionRef:null});
        });
        break;
      }
      case 'TSIM_OPERATOR_NEEDS_LOGIN':clearTimer();reusable=false;frameGrant=null;reported=null;revealed();layout();message('请在下方 TSim 页面完成登录。');break;
      case 'TSIM_OPERATOR_BASIC_READY':case 'TSIM_OPERATOR_LOADED':clearTimer();reusable=true;revealed();message('请在下方 TSim 页面查看订单详情。');break;
      case 'TSIM_OPERATOR_QUERY_TERMINAL':clearTimer();reusable=true;revealed();message('订单查询未完成，请查看下方 TSim 页面的提示。');break;
    }
  };
  const onVisibility=()=>{if(document.visibilityState==='hidden')close();};
  const onResize=()=>layout();
  const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'&&active){event.preventDefault();event.stopPropagation();close();}};
  view.addEventListener('message',onMessage);view.addEventListener('keydown',onKey,true);view.addEventListener('resize',onResize);document.addEventListener('visibilitychange',onVisibility);
  return{open,close,reset,prewarm,warmConnection,get frame(){return frame;},get frameURL(){return frameURL;},get visible(){return visible;},get active(){return active?{...active}:null;},get bounds(){return bounds?{...bounds}:null;},dispose(){if(disposed)return;disposed=true;reset();view.clearTimeout(warmTimer);warmFrame?.remove();warmFrame=null;view.removeEventListener('message',onMessage);view.removeEventListener('keydown',onKey,true);view.removeEventListener('resize',onResize);document.removeEventListener('visibilitychange',onVisibility);}};
}
