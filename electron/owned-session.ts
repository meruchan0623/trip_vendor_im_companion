import {addTelemetry,setTelemetry} from './translation-telemetry';
import { OwnedPsimService, type OwnedSessionStore } from '../host/owned-service';
import { startOwnedLoginServer, type OwnedLoginService } from '../host/auth-server';
import type { BrowserProfileSessionOptions, BrowserSessionStatus } from './browser-profile-session';
import type { OutboundBody, PsimIdentity } from '../src/shared/workbench';

export interface OwnedSessionOptions extends BrowserProfileSessionOptions {embeddedLogin?:boolean;closeLogin?:()=>void}
/** Desktop-owned account. Only encrypted persistence and the loopback login page handle credentials. */
export class PersistentSessionService {
  private service:OwnedPsimService;
  private status:BrowserSessionStatus='connecting';
  private errorCode:string|undefined;
  private closed=false;
  private suspended=false;
  private pollingWanted=false;
  private poll:ReturnType<typeof setInterval>|undefined;
  private syncing:Promise<void>|undefined;
  private loginServerGeneration=0;
  private loginServer:ReturnType<typeof startOwnedLoginServer>|undefined;
  constructor(changed:(identity:PsimIdentity|null)=>void,private options:OwnedSessionOptions,store:OwnedSessionStore){
    this.service=new OwnedPsimService(options.fetcher,identity=>{if(!this.closed){changed(identity);if(!identity)this.publish('connecting');}},store);
    this.setBackgroundPolling(options.backgroundPolling!==false);
  }
  identity(){return this.service.identity();}
  outboundWaitBounds(){return this.service.outboundWaitBounds();}
  getBrowserProfile(){return null;}
  operatorGrant(identity:PsimIdentity){return this.closed||this.suspended?null:this.service.operatorGrant(identity);}
  private publish(status:BrowserSessionStatus,code?:string){
    if(this.closed||this.status===status&&this.errorCode===code)return;
    this.status=status;this.errorCode=code;this.options.onStatus?.(status,code);
  }
  private failure(error:unknown){
    const raw=error instanceof Error?error.message:'';
    const code=/^[A-Z][A-Z0-9_]{1,80}$/.test(raw)?raw:'SERVICE_UNAVAILABLE';
    if(['PSIM_LOGIN_REQUIRED','PSIM_HTTP_401','PSIM_HTTP_423','PROFILE_UNVERIFIED','SESSION_STORAGE_CORRUPT'].includes(code))this.publish('needs_login');
    else this.publish('failed',code);
  }
  setBackgroundPolling(enabled:boolean){
    this.pollingWanted=enabled;
    if(this.poll){clearInterval(this.poll);this.poll=undefined;}
    if(enabled&&!this.closed&&!this.suspended){this.poll=setInterval(()=>{void this.sync().catch(()=>{});},this.options.syncIntervalMs??60000);this.poll.unref();}
  }
  async sync():Promise<void>{
    if(this.closed||this.suspended||this.options.enabled===false)return;
    const started=performance.now();addTelemetry('authChecks',1);setTelemetry({sessionMode:'owned',authStateBefore:this.status,authCheckMode:this.syncing?'joined':'owned'});
    try{
      if(this.syncing)return await this.syncing;
      if(!this.identity())this.publish('connecting');
      this.syncing=(async()=>{
        try{const identity=await this.service.ensureSession();if(!this.suspended)this.publish(identity?'ready':'needs_login');}
        catch(error){if(!this.suspended)this.failure(error);throw error;}
      })().finally(()=>{this.syncing=undefined;});return await this.syncing;
    }finally{addTelemetry('authMs',performance.now()-started);setTelemetry({authStateAfter:this.status,authGeneration:this.identity()?.authGeneration});}
  }
  async translate(body:OutboundBody,identity:PsimIdentity,signal:AbortSignal){
    try{return await this.service.translate(body,identity,signal);}catch(error){if(!this.suspended&&!this.identity())this.failure(error);throw error;}
  }
  async queryOriginalIdentifier(identifier:string,signal:AbortSignal){
    const identity=this.identity();if(!identity)throw new Error('PSIM_LOGIN_REQUIRED');
    try{return await this.service.queryOriginalIdentifier(identifier,identity,signal);}catch(error){if(!this.suspended&&!this.identity())this.failure(error);throw error;}
  }
  async openLogin(){
    if(this.closed)throw new Error('OWNED_SERVICE_CLOSED');
    if(!this.options.openExternal)throw new Error('BROWSER_LOGIN_OPENER_REQUIRED');
    if(!this.loginServer){
      const generation=++this.loginServerGeneration;
      const current=()=>!this.closed&&generation===this.loginServerGeneration;
      const authorized=()=>{if(!current())throw new Error('OWNED_LOGIN_REVOKED');};
      const facade:OwnedLoginService={
        identity:()=>current()?this.identity():null,
        login:async(username,password)=>{authorized();this.suspended=false;this.setBackgroundPolling(this.pollingWanted);this.publish('connecting');try{const identity=await this.service.login(username,password);authorized();if(!this.suspended)this.publish('ready');return identity;}catch(error){if(current()&&!this.suspended)this.failure(error);throw error;}},
        logout:async()=>{authorized();await this.logout();},
        refresh:async()=>{authorized();try{const identity=await this.service.refresh();authorized();if(!this.suspended)this.publish('ready');return identity;}catch(error){if(current()&&!this.suspended)this.failure(error);throw error;}},
        dispose:()=>{},
      };
      const starting=startOwnedLoginServer(facade,{persistent:true,embedded:this.options.embeddedLogin!==false});this.loginServer=starting;
      void starting.catch(()=>{if(this.loginServer===starting)this.loginServer=undefined;});
    }
    const starting=this.loginServer,generation=this.loginServerGeneration,server=await starting;
    if(this.closed||generation!==this.loginServerGeneration||this.loginServer!==starting)return;
    await this.options.openExternal(server.loginURL);
  }

  async logout(){
    this.options.closeLogin?.();
    this.suspended=true;++this.loginServerGeneration;const previous=this.loginServer;this.loginServer=undefined;
    const wanted=this.pollingWanted;this.setBackgroundPolling(false);this.pollingWanted=wanted;
    // Revoke the owned service immediately; closing a server that is still starting must not delay logout.
    const logout=this.service.logout(),closing=previous?.then(server=>server.close()).catch(()=>{});
    try{await Promise.all([logout,closing]);}finally{if(this.suspended)this.publish('needs_login');}
  }
  async dispose(){
    if(this.closed)return;this.closed=true;++this.loginServerGeneration;const previous=this.loginServer;this.loginServer=undefined;
    this.options.closeLogin?.();
    this.setBackgroundPolling(false);this.service.dispose();
    const server=await previous?.catch(()=>undefined);await server?.close();
  }
}
