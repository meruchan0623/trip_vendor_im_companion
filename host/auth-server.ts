import{createServer,type IncomingMessage,type ServerResponse}from'node:http';
import{randomBytes,timingSafeEqual}from'node:crypto';
import type{OwnedPsimService}from'./owned-service';
export type OwnedLoginService=Pick<OwnedPsimService,'login'|'logout'|'refresh'|'identity'|'dispose'>;
function equal(value:unknown,secret:string){if(typeof value!=='string')return false;const a=Buffer.from(value),b=Buffer.from(secret);return a.length===b.length&&timingSafeEqual(a,b);}
async function body(request:IncomingMessage){if(request.headers['content-type']!=='application/json'||Number(request.headers['content-length'])>16000)throw new Error('INVALID_AUTH_REQUEST');const chunks:Buffer[]=[];let bytes=0;for await(const chunk of request){const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=part.length;if(bytes>16000)throw new Error('AUTH_BODY_TOO_LARGE');chunks.push(part);}let value:unknown;try{value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));}catch{throw new Error('INVALID_AUTH_REQUEST');}if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_AUTH_REQUEST');return value as Record<string,unknown>;}
const json=(response:ServerResponse,status:number,value:unknown)=>{response.writeHead(status,{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(value));};
function page(csrf:string,nonce:string,authenticated:boolean,persistent:boolean){
  const success=persistent?'登录态已加密保存，下次启动会自动恢复。可直接关闭此页面，关闭不会退出登录。':'可直接关闭此页面，关闭不会退出当前登录。';
  return`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TSim 助手登录</title><style nonce="${nonce}">
body{font:16px system-ui;background:#f5f7fb;color:#172b4d;margin:8vh auto;max-width:420px;padding:24px}form,label{display:grid;gap:12px}[hidden]{display:none!important}input,button{font:inherit;padding:10px;border:1px solid #ccd7e8;border-radius:6px}button{background:#1769df;color:white}button:disabled{opacity:.6}p{line-height:1.6}.secondary{background:transparent;color:#344563}
</style><h1 id="heading">${authenticated?'登录已完成':'登录 TSim 账号'}</h1>
<p id="intro"${authenticated?' hidden':''}>登录用于助手翻译。${persistent?'登录态会加密保存，下次启动自动恢复；':''}不会保存密码。</p>
<form${authenticated?' hidden':''}><label>TSim 账号<input name="username" autocomplete="username" required maxlength="200"></label><label>密码<input name="password" type="password" autocomplete="current-password" required maxlength="4096"></label><button type="submit">登录并返回客户端</button></form>
<p role="status" id="status">${authenticated?success:''}</p><button type="button" class="secondary" id="switch-account"${authenticated?'':' hidden'}>切换账号</button>
<script nonce="${nonce}">
const form=document.querySelector('form'),status=document.getElementById('status'),heading=document.getElementById('heading'),intro=document.getElementById('intro'),switchAccount=document.getElementById('switch-account');
const csrf=${JSON.stringify(csrf)};
form.addEventListener('submit',async event=>{
  event.preventDefault();const submit=form.querySelector('button');submit.disabled=true;status.textContent='正在核对账号…';
  try{
    const response=await fetch(location.pathname+'/login',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({username:form.elements.username.value,password:form.elements.password.value})});
    const result=await response.json();
    if(response.ok&&result.ok&&result.authenticated){form.hidden=true;intro.hidden=true;switchAccount.hidden=false;heading.textContent='登录已完成';status.textContent=${JSON.stringify(success)};}
    else status.textContent='登录未完成，请核对账号或稍后重试。';
  }catch{status.textContent='服务暂不可用，请稍后重试。';}
  finally{form.elements.password.value='';submit.disabled=false;}
});
switchAccount.addEventListener('click',()=>{form.hidden=false;intro.hidden=false;switchAccount.hidden=true;heading.textContent='切换 TSim 账号';status.textContent='';form.elements.username.focus();});
</script></html>`;
}
/** Separate login capability; never placed in the file page or sent through its messages. */
export async function startOwnedLoginServer(service:OwnedLoginService,options:{persistent?:boolean}={}){
  const pathNonce=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex'),scriptNonce=randomBytes(24).toString('base64');let port=0,busy=false;
  const path=`/auth/${pathNonce}`;
  const server=createServer((request,response)=>{void(async()=>{
    if(request.headers.host!==`127.0.0.1:${port}`||!request.url||!request.url.startsWith(path)||request.url.includes('?')||request.url.includes('#')){json(response,403,{ok:false});return;}
    if(request.method==='GET'&&request.url===path){response.writeHead(200,{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'nonce-${scriptNonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`});response.end(page(csrf,scriptNonce,service.identity()!==null,options.persistent===true));return;}
    if(request.method!=='POST'||request.headers.origin!==`http://127.0.0.1:${port}`||!equal(request.headers['x-csrf-token'],csrf)){json(response,403,{ok:false});return;}
    if(busy){json(response,409,{ok:false});return;}
    const operation=request.url.slice(path.length);if(!['/login','/logout','/refresh'].includes(operation)){json(response,404,{ok:false});return;}
    busy=true;
    try{const value=await body(request);if(operation==='/login'){if(Object.keys(value).sort().join(',')!=='password,username'||typeof value.username!=='string'||typeof value.password!=='string')throw new Error('INVALID_AUTH_REQUEST');await service.login(value.username,value.password);}else{if(Object.keys(value).length)throw new Error('INVALID_AUTH_REQUEST');if(operation==='/logout')await service.logout();else await service.refresh();}json(response,200,{ok:true,authenticated:service.identity()!==null});}finally{busy=false;}
  })().catch(()=>{if(!response.headersSent)json(response,400,{ok:false});else response.end();});});
  server.headersTimeout=10000;server.requestTimeout=35000;server.maxHeadersCount=40;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();if(!address||typeof address==='string'){server.close();throw new Error('LOGIN_SERVER_UNAVAILABLE');}port=address.port;
  return{loginURL:`http://127.0.0.1:${port}${path}`,close:async()=>{service.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

