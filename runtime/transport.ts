import {get,type ClientRequest,type IncomingMessage} from 'node:http';
import {VERIFIED_RUNTIME_BUILD} from './build-manifest';
import type {CDPTransport} from './cdp-policy';
export interface CDPEvent {method:string;params:Record<string,unknown>;sessionId?:string}
export interface EventCDPTransport extends CDPTransport {onEvent(listener:(event:CDPEvent)=>void):()=>void;onDisconnect(listener:()=>void):()=>void}
const METHODS=new Set(['Target.getTargets','Target.attachToTarget','Target.detachFromTarget','Target.getTargetInfo','Page.enable','Page.getFrameTree','Page.getResourceContent','Page.createIsolatedWorld','Runtime.enable','Runtime.addBinding','Runtime.removeBinding','Runtime.evaluate','Runtime.callFunctionOn','Runtime.releaseObject','Runtime.releaseObjectGroup','Debugger.enable','Debugger.disable','Debugger.getScriptSource','DOMDebugger.getEventListeners','DOM.describeNode']);
interface Socket {readyState:number;send(data:string):void;close():void;addEventListener(type:string,listener:(event:any)=>void):void;removeEventListener(type:string,listener:(event:any)=>void):void}
/** Internal product transport, never exposed to the renderer or to a general IPC bridge. */
export class LoopbackCDPTransport implements EventCDPTransport {
  private serial=0;private closed=false;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;sessionId?:string;method:string;started:number}>();
  private events=new Set<(event:CDPEvent)=>void>();private disconnects=new Set<()=>void>();
  constructor(private socket:Socket,private timeoutMs=4000){socket.addEventListener('message',this.message);socket.addEventListener('close',this.lost);socket.addEventListener('error',this.lost);}
  private message=(event:{data:unknown})=>{
    if(this.closed)return;
    if(typeof event.data!=='string'||event.data.length>12_000_000){this.fail();return;}
    let value:any;try{value=JSON.parse(event.data);}catch{this.fail();return;}
    if(!value||typeof value!=='object'){this.fail();return;}
    if(Number.isSafeInteger(value.id)){
      const request=this.pending.get(value.id);if(!request)return;if(value.sessionId!==request.sessionId){this.fail();return;}this.pending.delete(value.id);clearTimeout(request.timer);
      const elapsedMs=Date.now()-request.started;if(elapsedMs>=250)console.log(JSON.stringify({event:'cdp-slow-command',method:request.method,elapsedMs}));
      // Do not include upstream exception/error text which may contain business data.
      if(value.error||!('result' in value)){
        console.log(JSON.stringify({event:'cdp-command-rejected',method:request.method,...(Number.isSafeInteger(value.error?.code)?{errorCode:value.error.code}:{})}));
        request.reject(new Error('CDP_COMMAND_REJECTED'));
      }else request.resolve(value.result);
    }else if(typeof value.method==='string'&&value.params&&typeof value.params==='object'){
      const item:CDPEvent={method:value.method,params:value.params,...(typeof value.sessionId==='string'?{sessionId:value.sessionId}:{})};for(const listener of [...this.events])listener(item);
    }
  };
  private lost=()=>this.fail();
  private fail(){if(this.closed)return;this.closed=true;for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new Error('CDP_DISCONNECTED'));}this.pending.clear();this.socket.removeEventListener('message',this.message);this.socket.removeEventListener('close',this.lost);this.socket.removeEventListener('error',this.lost);this.socket.close();for(const listener of [...this.disconnects])listener();this.events.clear();this.disconnects.clear();}
  send(method:string,params:Record<string,unknown>,sessionId?:string):Promise<unknown>{
    if(!METHODS.has(method))return Promise.reject(new Error('FORBIDDEN_CDP_METHOD'));
    if(this.closed||this.socket.readyState!==1)return Promise.reject(new Error('CDP_DISCONNECTED'));
    const id=++this.serial;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{console.log(JSON.stringify({event:'cdp-command-timeout',method,timeoutMs:this.timeoutMs}));this.fail();},this.timeoutMs);this.pending.set(id,{resolve,reject,timer,sessionId,method,started:Date.now()});try{this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}catch{this.fail();}});
  }
  onEvent(listener:(event:CDPEvent)=>void){this.events.add(listener);return()=>this.events.delete(listener);}
  onDisconnect(listener:()=>void){if(this.closed){listener();return()=>{};}this.disconnects.add(listener);return()=>this.disconnects.delete(listener);}
  async disconnect(){this.fail();}
}
function versionJSON(port:number):Promise<unknown>{return new Promise((resolve,reject)=>{
  let request:ClientRequest|undefined,response:IncomingMessage|undefined,settled=false,size=0;
  const chunks:Buffer[]=[];
  // Socket inactivity timeouts reset on each chunk; discovery needs a total deadline.
  const timer=setTimeout(()=>finish(new Error('DEBUG_ENDPOINT_TIMEOUT')),4000);
  const unavailable=()=>finish(new Error('DEBUG_ENDPOINT_UNAVAILABLE'));
  const closed=()=>unavailable();
  const data=(part:Buffer)=>{size+=part.length;if(size>16000)finish(new Error('DEBUG_ENDPOINT_INVALID'));else chunks.push(part);};
  const end=()=>{try{const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));finish(undefined,value);}catch{finish(new Error('DEBUG_ENDPOINT_INVALID'));}};
  function finish(error?:Error,value?:unknown){
    if(settled)return;settled=true;clearTimeout(timer);
    request?.removeListener('error',unavailable);
    response?.removeListener('data',data);response?.removeListener('end',end);
    response?.removeListener('aborted',unavailable);response?.removeListener('error',unavailable);response?.removeListener('close',closed);
    if(error){
      // Destruction can deliver an already queued I/O error after cleanup.
      request?.once('error',()=>{});response?.once('error',()=>{});
      response?.destroy();request?.destroy();reject(error);
    }else resolve(value);
  }
  try{
    request=get({hostname:'127.0.0.1',port,path:'/json/version',agent:false},incoming=>{
      response=incoming;
      if(settled){incoming.on('error',()=>{});incoming.destroy();return;}
      response.on('error',unavailable);response.on('aborted',unavailable);response.on('close',closed);
      if(response.statusCode!==200){unavailable();return;}
      response.on('data',data);response.on('end',end);
    });
    request.on('error',unavailable);
  }catch{unavailable();}
});}
export function approvedSocketURL(value:unknown,port:number):value is string{if(typeof value!=='string')return false;try{const url=new URL(value);return url.protocol==='ws:'&&url.hostname==='127.0.0.1'&&Number(url.port)===port&&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/devtools\/browser\/[a-z0-9-]+$/i.test(url.pathname);}catch{return false;}}
/** The owning process/listener is checked before discovery, before socket open and after open. */
export async function connectOwnedLoopback(port:number,verifyOwner:()=>Promise<void>):Promise<LoopbackCDPTransport>{
  if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('INVALID_DEBUG_PORT');
  await verifyOwner();const version=await versionJSON(port) as {webSocketDebuggerUrl?:unknown;Browser?:unknown};
  if(!version||!approvedSocketURL(version.webSocketDebuggerUrl,port)||typeof version.Browser!=='string'||!version.Browser.startsWith(`Chrome/${VERIFIED_RUNTIME_BUILD.chromiumMajor}.`))throw new Error('UNVERIFIED_DEBUG_ENDPOINT');
  await verifyOwner();const socket=new WebSocket(version.webSocketDebuggerUrl);
  try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{socket.close();reject(new Error('CDP_CONNECT_TIMEOUT'));},4000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP_CONNECT_FAILED'));},{once:true});});await verifyOwner();return new LoopbackCDPTransport(socket);}catch(error){socket.close();throw error;}
}


