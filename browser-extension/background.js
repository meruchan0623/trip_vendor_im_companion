/* Fixed operations only. MAIN-world functions are self-contained; token stays in their closures. */
const ORIGIN='https://csagent.tsim.tech',HOST='tech.tsim.travel_merchant_companion';
const orders=new Set(),closedOrders=new Set(),openingOrders=new Map(),createdOrders=new Map(),active=new Map();let port=null,selected=null;
let bridgeStatus={state:'disconnected',error:null};
function status(state,error=null){
  bridgeStatus={state,error};
  const title=state==='ready'?'TSim 会话桥：已连接助手':state==='connecting'?'TSim 会话桥：等待本机助手':`TSim 会话桥未连接${error?`：${error}`:''}`;
  void chrome.action.setTitle?.({title});void chrome.action.setBadgeText?.({text:state==='disconnected'?'!':state==='connecting'?'…':''});
  if(state==='disconnected')void chrome.action.setBadgeBackgroundColor?.({color:'#b42318'});
}
const record=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>record(x)&&Object.keys(x).every(k=>keys.includes(k));
const uuid=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x);
const bounded=x=>record(x)&&['x','y','width','height'].every(k=>Number.isFinite(x[k]))&&x.width>=200&&x.width<=10000&&x.height>=200&&x.height<=10000;
function removedOwnedWindow(id){if(orders.delete(id)){closedOrders.add(id);if(closedOrders.size>512)closedOrders.delete(closedOrders.values().next().value);}for(const [requestId,windowId] of createdOrders)if(windowId===id)createdOrders.delete(requestId);}
function validBody(x){return exact(x,['text','target_lang','source_lang','purpose','draft_request_id','composer_content_version'])&&typeof x.text==='string'&&!!x.text.trim()&&x.text.length<=20000&&x.source_lang==='zh'&&x.purpose==='outbound'&&['zh','en','ja','ko','es','fr','de','ru','pt','it','ar','th','vi','id','ms','zh-TW'].includes(x.target_lang)&&typeof x.draft_request_id==='string'&&/^[-a-z0-9]{1,100}$/.test(x.draft_request_id)&&typeof x.composer_content_version==='string'&&x.composer_content_version.length<=25000;}
async function pageRequest(action,request,expectedHash,id){
  const fail=error=>({ok:false,error});
  if(location.origin!=='https://csagent.tsim.tech')return fail('PSIM_LOGIN_REQUIRED');
  const registry=globalThis[Symbol.for('tech.tsim.companion.requests')]??=new Map();
  if(action==='cancel'){registry.get(id)?.abort();return {ok:true,value:null};}
  if(!['sync','translate'].includes(action))return fail('INVALID_BROWSER_ACTION');
  const token=localStorage.getItem('agent_token')?.trim();
  if(!token||token.length>16000)return fail('PSIM_LOGIN_REQUIRED');
  const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
  const fingerprint=await hash(token);
  if(expectedHash&&fingerprint!==expectedHash)return fail('AUTH_CHANGED');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);registry.set(id,controller);
  const fresh=()=>localStorage.getItem('agent_token')?.trim()===token;
  async function fetchJSON(path,body){
    const response=await fetch(`https://csapi.tsim.tech${path}`,{method:body?'POST':'GET',headers:{Accept:'application/json',Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal,redirect:'error'});
    if(!fresh())throw Error('AUTH_CHANGED');
    if(response.status===401||response.status===423)throw Error('PSIM_LOGIN_REQUIRED');
    if(response.status===403||response.status===422)throw Error('TRANSLATION_PERMISSION_REQUIRED');
    if(response.status===429)throw Error('RATE_LIMITED');
    if(!response.ok)throw Error('SERVICE_UNAVAILABLE');
    if(Number(response.headers.get('content-length'))>200000)throw Error('INVALID_SERVICE_RESPONSE');
    const reader=response.body?.getReader();if(!reader)throw Error('INVALID_SERVICE_RESPONSE');let size=0,chunks=[];
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>200000){await reader.cancel();throw Error('INVALID_SERVICE_RESPONSE');}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  try{
    // Validate account on every request as well as token: a token can outlive an account/permission change.
    const profile=await fetchJSON('/agent/profile'),p=profile?.data;
    if(profile?.success!==true||p?.is_active!==true||!/^[-A-Za-z0-9_]{1,128}$/.test(String(p?.id??''))||!Array.isArray(p.permissions)||p.permissions.length>200||!p.permissions.every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v)))return fail('PROFILE_UNVERIFIED');
    const identity={accountScope:`psim:${p.id}`,permissions:[...new Set(p.permissions)].sort(),hash:fingerprint};
    if(action==='sync'){if(!fresh())return fail('AUTH_CHANGED');return {ok:true,value:identity};}
    if(identity.accountScope!==request.expectedAccount||JSON.stringify(identity.permissions)!==JSON.stringify(request.expectedPermissions))return fail('AUTH_CHANGED');
    const result=await fetchJSON('/agent/translate',request.body),d=result?.data;
    if(!fresh())return fail('AUTH_CHANGED');
    if(result?.success!==true||typeof d?.translated_text!=='string'||!d.translated_text.trim()||d.translated_text.length>50000||d.draft_request_id!==request.body.draft_request_id||d.composer_content_version!==request.body.composer_content_version)return fail('OUTBOUND_ECHO_MISMATCH');
    return {ok:true,value:{success:true,data:{translated_text:d.translated_text,draft_request_id:d.draft_request_id,composer_content_version:d.composer_content_version}}};
  }catch(error){return fail(controller.signal.aborted?'BROWSER_BRIDGE_TIMEOUT':/^[A-Z][A-Z0-9_]{1,80}$/.test(error?.message)?error.message:'SERVICE_UNAVAILABLE');}
  finally{clearTimeout(timer);registry.delete(id);}
}
async function inject(tabId,action,request,expectedHash,id){const [result]=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'MAIN',func:pageRequest,args:[action,request,expectedHash,id]});if(!record(result?.result)||typeof result.result.ok!=='boolean')throw Error('INVALID_BROWSER_RESPONSE');return result.result;}
async function tabs(){return (await chrome.tabs.query({url:`${ORIGIN}/*`})).filter(t=>t.id!=null&&new URL(t.url).origin===ORIGIN).sort((a,b)=>(b.lastAccessed||0)-(a.lastAccessed||0));}
async function sync(id){
  for(const tab of await tabs()){
    let result;try{result=await inject(tab.id,'sync',null,null,id);}catch{continue;}
    if(!result.ok){if(['PSIM_LOGIN_REQUIRED','PROFILE_UNVERIFIED'].includes(result.error))continue;throw Error(result.error);}
    const p=result.value;if(!exact(p,['accountScope','permissions','hash'])||!/^[a-f0-9]{64}$/.test(p.hash))throw Error('INVALID_BROWSER_RESPONSE');
    selected={...p,tabId:tab.id};return {accountScope:p.accountScope,permissions:p.permissions,sessionKey:`${p.hash}:${tab.id}`};
  }
  selected=null;return null;
}
async function execute(message){
  if(!exact(message,['type','id','action','payload'])||message.type!=='request'||!uuid(message.id)||!record(message.payload))throw Error('INVALID_BROWSER_REQUEST');
  const {id,action,payload}=message;
  if(action==='sync'){if(Object.keys(payload).length)throw Error('INVALID_BROWSER_REQUEST');return sync(id);}
  if(action==='translate'){
    if(!exact(payload,['body','sessionKey'])||!validBody(payload.body)||typeof payload.sessionKey!=='string'||!selected||payload.sessionKey!==`${selected.hash}:${selected.tabId}`)throw Error('AUTH_CHANGED');
    const captured={...selected};active.set(id,captured.tabId);
    try{const result=await inject(captured.tabId,'translate',{body:payload.body,expectedAccount:captured.accountScope,expectedPermissions:captured.permissions},captured.hash,id);if(!result.ok)throw Error(result.error);return result.value;}finally{active.delete(id);}
  }
  if(action==='openLogin'){
    if(Object.keys(payload).length)throw Error('INVALID_BROWSER_REQUEST');const [tab]=await tabs();
    if(tab){await chrome.tabs.update(tab.id,{active:true});await chrome.windows.update(tab.windowId,{focused:true});}else await chrome.tabs.create({url:`${ORIGIN}/login`,active:true});return null;
  }
  if(action==='openOrder'){
    if(orders.size+openingOrders.size>=16)throw Error('BROWSER_BRIDGE_BUSY');
    const s=payload.selection,b=payload.bounds;
    if(!exact(payload,['selection','bounds','marker'])||!exact(s,['identifier','identifierType','requestId'])||typeof s.identifier!=='string'||!s.identifier.trim()||s.identifier.length>128||/[\r\n\0]/.test(s.identifier)||!['order_number','iccid','eiccid'].includes(s.identifierType)||typeof s.requestId!=='string'||!/^[\w-]{1,100}$/.test(s.requestId)||!uuid(payload.marker)||!bounded(b))throw Error('INVALID_BROWSER_REQUEST');
    const query=new URLSearchParams({...s,marker:payload.marker}),operation={cancelled:false,port};openingOrders.set(id,operation);
    try{
      const w=await chrome.windows.create({type:'popup',url:chrome.runtime.getURL(`order.html?${query}`),left:Math.round(b.x),top:Math.round(b.y),width:Math.round(b.width),height:Math.round(b.height),focused:false});
      if(!Number.isSafeInteger(w.id))throw Error('INVALID_BROWSER_WINDOW');
      if(operation.cancelled||operation.port!==port){await chrome.windows.remove(w.id).catch(()=>{});throw Error('REQUEST_ABORTED');}
      closedOrders.delete(w.id);orders.add(w.id);createdOrders.set(id,w.id);return {windowId:w.id,marker:payload.marker};
    }finally{openingOrders.delete(id);}
  }
  if(action==='closeOrder'||action==='placeOrder'){
    if(!exact(payload,action==='closeOrder'?['windowId']:['windowId','bounds'])||(!orders.has(payload.windowId)&&!(action==='closeOrder'&&closedOrders.has(payload.windowId))))throw Error('INVALID_BROWSER_WINDOW');
    if(action==='closeOrder'){
      if(closedOrders.has(payload.windowId)){closedOrders.delete(payload.windowId);return null;}
      try{await chrome.windows.remove(payload.windowId);}catch(error){if(!closedOrders.has(payload.windowId))throw error;}
      removedOwnedWindow(payload.windowId);closedOrders.delete(payload.windowId);return null;
    }
    if(!bounded(payload.bounds))throw Error('INVALID_BROWSER_REQUEST');const b=payload.bounds;await chrome.windows.update(payload.windowId,{left:Math.round(b.x),top:Math.round(b.y),width:Math.round(b.width),height:Math.round(b.height)});return null;
  }
  throw Error('INVALID_BROWSER_ACTION');
}
function connect(){
  if(port)return;status('connecting');const current=chrome.runtime.connectNative(HOST);port=current;
  current.onMessage.addListener(message=>{
    if(bridgeStatus.state!=='ready')status('ready');
    if(exact(message,['type','id'])&&message.type==='cancel'&&uuid(message.id)){const tab=active.get(message.id);if(tab!=null)void inject(tab,'cancel',null,null,message.id).catch(()=>{});const opening=openingOrders.get(message.id);if(opening)opening.cancelled=true;const created=createdOrders.get(message.id);if(created!=null&&orders.has(created))void chrome.windows.remove(created).catch(()=>{}).finally(()=>removedOwnedWindow(created));return;}
    void execute(message).then(value=>{if(port===current)current.postMessage({type:'response',id:message.id,ok:true,value});},error=>{if(port===current&&uuid(message?.id))current.postMessage({type:'response',id:message.id,ok:false,error:/^[A-Z][A-Z0-9_]{1,80}$/.test(error?.message)?error.message:'BROWSER_BRIDGE_UNAVAILABLE'});});
  });
  current.onDisconnect.addListener(()=>{const error=chrome.runtime.lastError?.message?.slice(0,500)??'本机助手连接已断开';status('disconnected',error);console.warn('[TSim browser bridge] Native messaging disconnected:',error);port=null;selected=null;for(const opening of openingOrders.values())opening.cancelled=true;for(const [id,tab] of active)void inject(tab,'cancel',null,null,id).catch(()=>{});active.clear();for(const windowId of orders)void chrome.windows.remove(windowId).catch(()=>{});orders.clear();closedOrders.clear();createdOrders.clear();});
}
chrome.runtime.onMessage?.addListener((message,sender,sendResponse)=>{
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('status.html')||!exact(message,['action']))return;
  if(message.action==='getBridgeStatus'){sendResponse({...bridgeStatus});return;}
  if(message.action==='retryBridge'){connect();sendResponse({...bridgeStatus});}
});
chrome.windows.onRemoved.addListener(removedOwnedWindow);
chrome.tabs.onRemoved.addListener(id=>{if(selected?.tabId===id)selected=null;});
chrome.tabs.onUpdated.addListener((id,change)=>{if(selected?.tabId===id&&(change.status==='loading'||change.url))selected=null;});
chrome.runtime.onStartup.addListener(connect);chrome.runtime.onInstalled.addListener(()=>{chrome.alarms.create('bridge-reconnect',{periodInMinutes:.5});connect();});chrome.alarms.onAlarm.addListener(connect);chrome.action.onClicked.addListener(connect);connect();
