import {createServer} from 'node:http';
import {randomUUID,randomBytes} from 'node:crypto';
import {operatorURL,type OperatorSelection} from './system-browser';
import type {Bounds} from './layout';
export interface BrowserProfileSelection {browser:'edge'|'chrome';profileDirectory:string}
interface ProfileNativePort {
  launchProfileBrowser(options:{launchId:string;browserKind:'edge'|'chrome';profileDirectory:string;bootstrapURL:string}):Promise<void>;
  adoptProfileBrowser(launchId:string):Promise<void>;
  cleanupProfileBrowser(launchId:string):Promise<{complete:boolean}>;
  heartbeatProfileBrowser(launchId:string):Promise<void>;
  placeBrowser(options:{bounds:Bounds;visible:boolean;restack?:boolean;maximized?:boolean}):Promise<void>;
}
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const validProfile=(value:BrowserProfileSelection|null):value is BrowserProfileSelection=>!!value&&['edge','chrome'].includes(value.browser)&&/^(?:Default|Profile [1-9]\d*)$/.test(value.profileDirectory);
export interface BootstrapServer {url:string;release():void;cancel():void;close():Promise<void>}
/** Own loopback bootstrap only. It never hosts login, reads cookies, or proxies remote responses. */
export async function startProfileBootstrap(launchId:string,destination:string):Promise<BootstrapServer>{
  if(!/^[a-f0-9-]{36}$/i.test(launchId))throw new Error('INVALID_BROWSER_LEASE');
  const target=new URL(destination);
  if(target.origin!=='https://csagent.tsim.tech'||target.pathname!=='/embed/operator'||target.username||target.password||target.hash)throw new Error('INVALID_OPERATOR_URL');
  const keys=[...target.searchParams.keys()];
  if(![4,5].includes(keys.length)||new Set(keys).size!==keys.length||keys.some(key=>!['identifier','identifierType','requestId','source','companionLease'].includes(key))||target.searchParams.has('companionLease')&&target.searchParams.get('companionLease')!==launchId||target.searchParams.get('source')!=='travel-merchant-companion'||!target.searchParams.get('identifier')||!['order_number','iccid','eiccid'].includes(target.searchParams.get('identifierType')??'')||!/^[a-f0-9-]{36}$/i.test(target.searchParams.get('requestId')??''))throw new Error('INVALID_OPERATOR_URL');
  const path=`/bootstrap/${launchId}`,nonce=randomBytes(24).toString('base64');let origin='',ready=false,cancelled=false,closed=false;
  const server=createServer((request,response)=>{
    const denied=request.method!=='GET'||request.headers.host!==origin.slice(7)||(request.headers.origin!==undefined&&request.headers.origin!==origin)||request.headers['sec-fetch-site']==='cross-site';
    response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');response.setHeader('X-Content-Type-Options','nosniff');
    if(denied||![path,`${path}/ready`].includes(request.url??'')){response.writeHead(403);response.end();return;}
    if(request.url===`${path}/ready`){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({ready:ready&&!cancelled,cancelled}));return;}
    response.writeHead(200,{'Content-Type':'text/html;charset=utf-8','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`});
    response.end(`<!doctype html><meta charset="utf-8"><title>TSim Companion Bootstrap ${launchId}</title><script nonce="${nonce}">const target=${JSON.stringify(destination)};async function wait(){try{const r=await fetch(${JSON.stringify(`${path}/ready`)},{cache:'no-store'}),s=await r.json();if(s.ready){location.replace(target);return;}if(s.cancelled)return;}catch{}setTimeout(wait,100);}wait();</script>`);
  });
  server.headersTimeout=5000;server.requestTimeout=5000;server.maxHeadersCount=20;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('BROWSER_BOOTSTRAP_UNAVAILABLE');origin=`http://127.0.0.1:${address.port}`;
  server.unref();
  return{url:origin+path,release:()=>{if(!cancelled)ready=true;},cancel:()=>{cancelled=true;ready=false;},close:async()=>{if(closed)return;closed=true;cancelled=true;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
interface ActiveProfileLease {id:string;bootstrap:BootstrapServer;heartbeat?:ReturnType<typeof setInterval>}
export class ProfileBrowser {
  private generation=0;private adopted=false;private lease:ActiveProfileLease|null=null;
  private queue:Promise<unknown>=Promise.resolve();private pending:{bounds:Bounds;visible:boolean;restackId?:number}|null=null;
  private restackSequence=0;
  private applied='';private placing=false;
  ownsGeometry(launchId:string):boolean{return this.adopted&&this.lease?.id===launchId;}
  constructor(private native:ProfileNativePort,private getProfile:()=>BrowserProfileSelection|null|Promise<BrowserProfileSelection|null>,private failed:(code:'BROWSER_PLACEMENT_FAILED'|'BROWSER_CLEANUP_UNCONFIRMED')=>void=code=>console.error(code)){}
  private async retire():Promise<void>{
    this.adopted=false;this.applied='';const lease=this.lease;if(!lease)return;this.lease=null;
    if(lease.heartbeat)clearInterval(lease.heartbeat);lease.bootstrap.cancel();
    let complete=false;const deadline=Date.now()+2000;
    try{do{complete=(await this.native.cleanupProfileBrowser(lease.id)).complete;if(complete)break;await pause(100);}while(Date.now()<deadline);}catch{}
    if(complete){await lease.bootstrap.close();return;}
    // Keep the nonce page reachable so the native cancelled-lease watch can recognize late windows.
    const timer=setTimeout(()=>{void lease.bootstrap.close();},65000);timer.unref();this.failed('BROWSER_CLEANUP_UNCONFIRMED');
  }
  async open(selection:OperatorSelection,bounds:Bounds,maximized=false):Promise<void>{
    const destination=operatorURL(selection),generation=++this.generation;this.adopted=false;
    const operation=this.queue.then(async()=>{
      await this.retire();if(generation!==this.generation)return;
      const profile=await this.getProfile();if(!validProfile(profile))throw new Error('BROWSER_PROFILE_REQUIRED');
      const id=randomUUID(),target=new URL(destination);target.searchParams.set('companionLease',id);
      const bootstrap=await startProfileBootstrap(id,target.href);this.lease={id,bootstrap};
      try{
        await this.native.launchProfileBrowser({launchId:id,browserKind:profile.browser,profileDirectory:profile.profileDirectory,bootstrapURL:bootstrap.url});
        const deadline=Date.now()+10000;
        for(;;){if(generation!==this.generation){await this.retire();return;}try{await this.native.adoptProfileBrowser(id);break;}catch(error){if(!(error instanceof Error)||error.message!=='browser_window_pending'||Date.now()>=deadline)throw error;await pause(150);}}
        if(generation!==this.generation){await this.retire();return;}
        this.adopted=true;this.pending={bounds:{...bounds},visible:false};await this.native.placeBrowser({...this.pending,maximized});this.applied=JSON.stringify(this.pending);
        if(generation!==this.generation){await this.retire();return;}
        bootstrap.release();
        // Independent window: show once, then let Windows own movement and sizing.
        await this.native.placeBrowser({bounds:{...bounds},visible:true});
        if(generation!==this.generation){await this.retire();return;}
        this.pending={bounds:{...bounds},visible:true};this.applied=JSON.stringify(this.pending);
        const current=this.lease!;current.heartbeat=setInterval(()=>{void this.native.heartbeatProfileBrowser(id).catch(()=>{if(this.lease===current)this.handleLost();});},2000);current.heartbeat.unref();
      }catch(error){await this.retire();if(generation===this.generation)throw error;}
    });this.queue=operation.catch(()=>{});await operation;
  }
  place(bounds:Bounds,visible:boolean,restack=false):void{
    this.pending={bounds:{...bounds},visible,...(restack&&visible?{restackId:++this.restackSequence}:{})};this.flushPlacement();
  }
  private flushPlacement():void{
    if(this.placing||!this.adopted)return;this.placing=true;const generation=this.generation;
    void(async()=>{while(this.adopted&&generation===this.generation&&this.pending){const current=this.pending,key=JSON.stringify(current);if(key===this.applied)return;let success=false;
      for(let attempt=0;attempt<3;attempt++){if(generation!==this.generation||!this.adopted)return;if(this.pending!==current)break;try{await this.native.placeBrowser({bounds:current.bounds,visible:current.visible,...(current.restackId?{restack:true}:{})});success=true;break;}catch{if(attempt<2)await pause(150*(attempt+1));}}
      if(generation!==this.generation)return;if(success)this.applied=key;else if(this.pending===current)throw new Error('BROWSER_PLACEMENT_FAILED');
    }})().catch(async()=>{if(generation!==this.generation)return;this.adopted=false;const operation=this.queue.then(()=>this.retire());this.queue=operation.catch(()=>{});await operation.catch(()=>{});if(generation===this.generation)this.failed('BROWSER_PLACEMENT_FAILED');}).finally(()=>{this.placing=false;if(this.adopted&&this.pending&&JSON.stringify(this.pending)!==this.applied)this.flushPlacement();});
  }
  async close():Promise<void>{++this.generation;this.adopted=false;this.pending=null;const operation=this.queue.then(()=>this.retire());this.queue=operation.catch(()=>{});await operation;}
  handleLost():void{void this.close().catch(()=>{});}
}
