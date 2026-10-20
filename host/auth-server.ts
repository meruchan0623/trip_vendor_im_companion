import{createServer,type IncomingMessage,type ServerResponse}from'node:http';
import{randomBytes,timingSafeEqual}from'node:crypto';
import type{OwnedPsimService}from'./owned-service';
export type OwnedLoginService=Pick<OwnedPsimService,'login'|'logout'|'refresh'|'identity'|'dispose'>;
function equal(value:unknown,secret:string){if(typeof value!=='string')return false;const a=Buffer.from(value),b=Buffer.from(secret);return a.length===b.length&&timingSafeEqual(a,b);}
async function body(request:IncomingMessage){if(request.headers['content-type']!=='application/json'||Number(request.headers['content-length'])>16000)throw new Error('INVALID_AUTH_REQUEST');const chunks:Buffer[]=[];let bytes=0;for await(const chunk of request){const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=part.length;if(bytes>16000)throw new Error('AUTH_BODY_TOO_LARGE');chunks.push(part);}let value:unknown;try{value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));}catch{throw new Error('INVALID_AUTH_REQUEST');}if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_AUTH_REQUEST');return value as Record<string,unknown>;}
const json=(response:ServerResponse,status:number,value:unknown)=>{response.writeHead(status,{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(value));};
// Never echo arbitrary provider, filesystem or network error messages into the
// login document. These fixed codes are sufficient to diagnose the safe stage.
function loginFailureCode(error:unknown){
  const code=error instanceof Error?error.message:'';
  if(['INVALID_LOGIN','INVALID_AUTH_REQUEST','LOGIN_RESPONSE_INVALID','PROFILE_UNVERIFIED','PSIM_HTTP_400','PSIM_HTTP_401','PSIM_HTTP_403','PSIM_HTTP_423','PSIM_HTTP_429','PSIM_HTTP_500','PSIM_HTTP_502','PSIM_HTTP_503','PSIM_HTTP_504'].includes(code))return code;
  if(code==='AUTH_BODY_TOO_LARGE')return'INVALID_AUTH_REQUEST';
  if(['AUTH_CHANGED','OWNED_LOGIN_REVOKED','OWNED_SERVICE_CLOSED'].includes(code))return'LOGIN_REQUEST_REJECTED';
  if(['PSIM_SESSION_CLEAR_FAILED','PSIM_SESSION_SAVE_FAILED','SESSION_STORAGE_ENCRYPTION_UNAVAILABLE','SESSION_STORAGE_WRITE_FAILED','SESSION_STORAGE_CLEAR_FAILED','SESSION_STORAGE_LOCKED'].includes(code))return'LOGIN_SESSION_STORAGE_FAILED';
  return'LOGIN_SERVICE_UNAVAILABLE';
}
function page(csrf:string,nonce:string,authenticated:boolean,persistent:boolean,embedded:boolean,origin:string){
  const success=persistent?'登录态已加密保存，下次启动会自动恢复。可直接关闭此页面，关闭不会退出登录。':'可直接关闭此页面，关闭不会退出当前登录。';
  return`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TSim 助手登录</title><style nonce="${nonce}">
*{box-sizing:border-box}body{font:14px system-ui;background:${embedded?'#fff':'#f5f7fb'};color:#172b4d;margin:0 auto;max-width:420px;padding:${embedded?'16px':'24px'}}h1{font-size:21px;letter-spacing:-.4px;margin:0 0 10px}form{display:grid;gap:12px;margin-top:16px}label{display:grid;gap:7px;font-size:13px;font-weight:600}[hidden]{display:none!important}input,button{width:100%;font:inherit;padding:11px 12px;border:1px solid #ccd7e8;border-radius:9px}input{background:#fff;color:#172b4d;outline:none}input:focus{border-color:#3a5bd9;box-shadow:0 0 0 3px #3a5bd918}button{background:#3a5bd9;color:white;cursor:pointer;font-weight:600}button:disabled{opacity:.6;cursor:wait}p{line-height:1.7;color:#64748b;margin:0}#status{min-height:24px;margin-top:14px;font-size:13px}.secondary{background:transparent;color:#344563;margin-top:10px}
</style><h1 id="heading">${authenticated?'切换 TSim 账号':'登录 TSim 账号'}</h1>
<p id="intro">登录用于助手翻译。${persistent?'登录态加密保存，下次启动自动恢复；':''}不会保存密码。</p>
<form><label>TSim 账号<input name="username" autocomplete="username" autofocus required maxlength="200"></label><label>密码<input name="password" type="password" autocomplete="current-password" required maxlength="4096"></label><button type="submit">登录并返回客户端</button></form>
<p role="status" aria-live="polite" id="status"></p><button type="button" class="secondary" id="switch-account" hidden>切换账号</button>
<script nonce="${nonce}">
const form=document.querySelector('form'),status=document.getElementById('status'),heading=document.getElementById('heading'),intro=document.getElementById('intro'),switchAccount=document.getElementById('switch-account');
const csrf=${JSON.stringify(csrf)},embedded=${embedded},endpoint=${JSON.stringify(origin)}+location.pathname+'/login';
const notify=type=>{if(embedded)parent.postMessage({type},'*');};
const failureMessage=code=>{
  const messages={LOGIN_REQUEST_REJECTED:'登录页面已失效或安全隔离不可用，请重启客户端后重试。',LOGIN_REQUEST_BUSY:'正在处理登录，请稍候再试。',INVALID_AUTH_REQUEST:'登录请求格式无效，请重新打开登录页。',INVALID_LOGIN:'请输入有效的账号和密码。',PSIM_HTTP_400:'账号或密码未通过核验，请重新输入。',PSIM_HTTP_401:'账号或密码未通过核验，请重新输入。',PSIM_HTTP_403:'当前账号无法登录，请核对账号权限。',PSIM_HTTP_423:'当前账号已停用或锁定，请联系管理员。',PSIM_HTTP_429:'登录尝试过于频繁，请稍后重试。',LOGIN_SESSION_STORAGE_FAILED:'登录态无法加密保存，请检查本机权限后重试。',PROFILE_UNVERIFIED:'账号状态未通过核验，请联系管理员。',LOGIN_RESPONSE_INVALID:'登录服务返回异常，请稍后重试。'};
  return Object.prototype.hasOwnProperty.call(messages,code)?messages[code]+'（'+code+'）':'登录服务暂不可用，请稍后重试。（LOGIN_SERVICE_UNAVAILABLE）';
};
document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();form.elements.password.value='';notify('TSIM_LOGIN_CLOSE');}});
form.addEventListener('submit',async event=>{
  event.preventDefault();const submit=form.querySelector('button');if(submit.disabled)return;submit.disabled=true;form.setAttribute('aria-busy','true');status.textContent='正在核对账号…';
  try{
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:form.elements.username.value,password:form.elements.password.value})});
    const result=await response.json();
    if(response.ok&&result.ok&&result.authenticated){form.elements.password.value='';form.hidden=true;intro.hidden=true;switchAccount.hidden=false;heading.textContent='登录已完成';status.textContent=${JSON.stringify(success)};if(embedded)notify('TSIM_LOGIN_DONE');else window.close();}
    else status.textContent=failureMessage(result.code);
  }catch{status.textContent='无法连接登录服务，请检查连接后重试。（LOGIN_NETWORK_UNAVAILABLE）';}
  finally{form.elements.password.value='';submit.disabled=false;form.setAttribute('aria-busy','false');}
});
switchAccount.addEventListener('click',()=>{form.hidden=false;intro.hidden=false;switchAccount.hidden=true;heading.textContent='切换 TSim 账号';status.textContent='';form.elements.username.focus();});
</script></html>`;
}
/** Random loopback capability; only the isolated login document handles credentials. */
export async function startOwnedLoginServer(service:OwnedLoginService,options:{persistent?:boolean;embedded?:boolean}={}){
  const pathNonce=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex'),scriptNonce=randomBytes(24).toString('base64');let port=0,busy=false;
  const path=`/auth/${pathNonce}`;
  const server=createServer((request,response)=>{void(async()=>{
    if(request.headers.host!==`127.0.0.1:${port}`||!request.url||!request.url.startsWith(path)||request.url.includes('?')||request.url.includes('#')){json(response,403,{ok:false,code:'LOGIN_REQUEST_REJECTED'});return;}
    const origin=`http://127.0.0.1:${port}`,embedded=options.embedded===true;
    const opaqueLogin=embedded&&request.url===path+'/login'&&request.headers.origin==='null';
    if(request.method==='OPTIONS'){
      const requested=String(request.headers['access-control-request-headers']??'').toLowerCase().split(',').map(value=>value.trim()).filter(Boolean);
      if(!opaqueLogin||request.headers['access-control-request-method']!=='POST'||requested.some(value=>!['content-type','x-csrf-token'].includes(value))){json(response,403,{ok:false,code:'LOGIN_REQUEST_REJECTED'});return;}
      response.writeHead(204,{'Access-Control-Allow-Origin':'null','Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type, X-CSRF-Token','Cache-Control':'no-store','Vary':'Origin'});response.end();return;
    }
    // webSecurity is disabled by some vendor builds: CORS alone cannot protect the CSRF document.
    // Fetch metadata is browser-controlled; only an actual iframe navigation receives the form.
    if(request.method==='GET'&&request.url===path&&embedded&&(request.headers['sec-fetch-dest']!=='iframe'||request.headers['sec-fetch-mode']!=='navigate')){json(response,403,{ok:false,code:'LOGIN_REQUEST_REJECTED'});return;}
    if(request.method==='GET'&&request.url===path){response.writeHead(200,{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':`${embedded?'sandbox allow-scripts allow-forms; ':''}default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'nonce-${scriptNonce}'; connect-src ${embedded?origin:"'self'"}; form-action 'none'; frame-ancestors ${embedded?'file:':"'none'"}; base-uri 'none'`});response.end(page(csrf,scriptNonce,service.identity()!==null,options.persistent===true,embedded,origin));return;}
    if(opaqueLogin&&request.method==='POST'){response.setHeader('Access-Control-Allow-Origin','null');response.setHeader('Vary','Origin');}
    if(request.method!=='POST'||(request.headers.origin!==origin&&!opaqueLogin)||!equal(request.headers['x-csrf-token'],csrf)){json(response,403,{ok:false,code:'LOGIN_REQUEST_REJECTED'});return;}
    if(busy){json(response,409,{ok:false,code:'LOGIN_REQUEST_BUSY'});return;}
    const operation=request.url.slice(path.length);if(!['/login','/logout','/refresh'].includes(operation)){json(response,404,{ok:false,code:'LOGIN_REQUEST_REJECTED'});return;}
    busy=true;
    try{const value=await body(request);if(operation==='/login'){if(Object.keys(value).sort().join(',')!=='password,username'||typeof value.username!=='string'||typeof value.password!=='string')throw new Error('INVALID_AUTH_REQUEST');await service.login(value.username,value.password);}else{if(Object.keys(value).length)throw new Error('INVALID_AUTH_REQUEST');if(operation==='/logout')await service.logout();else await service.refresh();}json(response,200,{ok:true,authenticated:service.identity()!==null});}finally{busy=false;}
  })().catch(error=>{if(!response.headersSent)json(response,400,{ok:false,code:loginFailureCode(error)});else response.end();});});
  server.headersTimeout=10000;server.requestTimeout=35000;server.maxHeadersCount=40;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();if(!address||typeof address==='string'){server.close();throw new Error('LOGIN_SERVER_UNAVAILABLE');}port=address.port;
  return{loginURL:`http://127.0.0.1:${port}${path}`,close:async()=>{service.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

