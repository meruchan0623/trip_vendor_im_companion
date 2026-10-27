import {addTelemetry,setTelemetry,timeTelemetry,startHttpTelemetry} from './translation-telemetry';
import {parseOutboundWaitBounds} from '../runtime/outbound-wait-bounds';
import type {OutboundWaitBounds} from '../runtime/outbound-wait-controller';
import { access, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readTsimToken } from './chromium-tsim-storage';
import { WORKBENCH_TARGETS, type OperatorSessionGrant, type OutboundBody, type OutboundResponse, type PsimIdentity } from '../src/shared/workbench';

const API='https://csapi.tsim.tech';
const LOGIN_URL='https://csagent.tsim.tech/login';
export interface EmbeddedOrderResult {identifier:string;found:boolean;fields:{label:string;value:string}[]}
export interface BrowserProfile {browserPath:string;userDataDir:string;profileDirectory:string}
export type BrowserSessionStatus='connecting'|'needs_login'|'ready'|'failed';
export interface BrowserProfileSessionOptions {
  onStatus?:(status:BrowserSessionStatus,errorCode?:string)=>void;
  enabled?:boolean;
  openExternal?:(url:string)=>Promise<void>;
  openProfile?:(profile:BrowserProfile,url:string)=>Promise<void>;
  /** Invoked only after an explicit login attempt is denied, never by background polling. */
  onAccessDenied?:()=>Promise<void>;
  discoverProfiles?:(onReadError?:(error:Error)=>void)=>Promise<BrowserProfile[]>;
  readToken?:(storageDirectory:string)=>Promise<string|null>;
  fetcher?:typeof fetch;
  syncIntervalMs?:number;
  requestTimeoutMs?:number;
  backgroundPolling?:boolean;
  /** Monotonic milliseconds for the outbound reuse window; tests inject a fake clock. */
  now?:()=>number;
}
/**
 * How long one successful full session check may stand in for the checks an outbound translation runs
 * before its POST (CompanionService's pre-flight sync, then this service's own). Background polling
 * (`syncIntervalMs`, 4 s by default) already re-verifies the attached session; 3 s keeps every reused check
 * younger than one polling period, with margin for timer jitter and the check's own duration, while still
 * covering the gap between the two pre-flight checks (one editor read). Measured from the check's start.
 * The reused check must belong to the current auth generation; failed, revoked or in-flight checks are never
 * reused. Server 401/423, the post-response token re-read and the authGeneration comparisons still run on
 * every request.
 *
 * CompanionService.replaceDraft() uses the same window for its check before writing the reviewed translation
 * and for each write/send authorization. Writes make no TSim request, so there is no post-response token
 * re-read: a browser account switch inside the window is caught by the identity comparisons only once a
 * check (background poll or an expired window) has observed it.
 */
export const OUTBOUND_SYNC_REUSE_MS=3000;
export interface SessionSyncOptions {
  /** Accept a successful check started within OUTBOUND_SYNC_REUSE_MS under the current auth generation. */
  reuseRecent?:boolean;
}
const record=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value:object,allowed:string[])=>Object.keys(value).every(key=>allowed.includes(key));
const clone=(value:PsimIdentity|null)=>value&&({...value,permissions:[...value.permissions]});
const same=(a:PsimIdentity|null,b:PsimIdentity|null)=>JSON.stringify(a)===JSON.stringify(b);
const storage=(profile:BrowserProfile)=>join(profile.userDataDir,profile.profileDirectory,'Local Storage','leveldb');
const profileKey=(profile:BrowserProfile)=>JSON.stringify([profile.browserPath,profile.userDataDir,profile.profileDirectory]);
const sessionReadError=(error:unknown):Error=>new Error(['EACCES','EPERM'].includes((error as NodeJS.ErrnoException)?.code??'')?'BROWSER_SESSION_ACCESS_DENIED':'BROWSER_SESSION_STORAGE_INVALID');
const exists=async(path:string)=>{try{await access(path);return true;}catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')return false;throw sessionReadError(error);}};
/** Windows only: launch the browser profile whose localStorage will be verified. */
export async function openBrowserProfile(profile:BrowserProfile,url:string):Promise<void>{
  if(url!==LOGIN_URL)throw new Error('BROWSER_LOGIN_URL_INVALID');
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(profile.browserPath,[`--user-data-dir=${profile.userDataDir}`,`--profile-directory=${profile.profileDirectory}`,url],{shell:false,detached:true,windowsHide:false,stdio:'ignore'});
    child.once('error',()=>reject(new Error('BROWSER_LOGIN_OPEN_FAILED')));
    child.once('spawn',()=>{child.unref();resolve();});
  });
}
function browserInstalls(env:NodeJS.ProcessEnv,platform:NodeJS.Platform):{executables:string[];userDataDir:string}[]{
  // macOS never enumerates another application's profile or login storage.
  if(platform==='darwin')return [];
  const local=env.LOCALAPPDATA;if(!local)return [];
  return [{parts:['Microsoft','Edge'],exe:['Microsoft','Edge','Application','msedge.exe']},{parts:['Google','Chrome'],exe:['Google','Chrome','Application','chrome.exe']}].map(browser=>({executables:[env['ProgramFiles(x86)'],env.ProgramFiles,local].filter((root):root is string=>!!root).map(root=>join(root,...browser.exe)),userDataDir:join(local,...browser.parts,'User Data')}));
}
/** Enumerates profile directories and database metadata only; never opens Cookies or Preferences. */
export async function discoverBrowserProfiles(env:NodeJS.ProcessEnv=process.env,platform:NodeJS.Platform=process.platform,onReadError?:(error:Error)=>void):Promise<BrowserProfile[]>{
  const result:BrowserProfile[]=[],errors:Error[]=[];
  const report=(error:unknown)=>{errors.push(error instanceof Error&&error.message.startsWith('BROWSER_SESSION_')?error:sessionReadError(error));};
  for(const {executables,userDataDir} of browserInstalls(env,platform)){
    let browserPath:string|undefined;
    for(const path of executables){try{if(await exists(path)){browserPath=path;break;}}catch(error){report(error);}}
    if(!browserPath)continue;
    let directories;
    try{directories=await readdir(userDataDir,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException)?.code!=='ENOENT')report(error);continue;}
    for(const directory of directories.filter(item=>item.isDirectory()&&/^(Default|Profile [1-9]\d*)$/.test(item.name)).sort((a,b)=>a.name==='Default'?-1:b.name==='Default'?1:a.name.localeCompare(b.name))){
      const profile={browserPath,userDataDir,profileDirectory:directory.name};
      try{if(await exists(join(storage(profile),'CURRENT')))result.push(profile);}catch(error){report(error);}
    }
  }
  if(onReadError)errors.forEach(onReadError);else if(errors.length)throw errors.find(error=>error.message==='BROWSER_SESSION_ACCESS_DENIED')??errors[0];
  return result;
}
/** Reads only the allowlisted browser storage key. Secrets remain in this main-process object. */
export class BrowserProfileSessionService {
  private waitBounds:OutboundWaitBounds|null=null;
  outboundWaitBounds(){return this.waitBounds?{...this.waitBounds}:null;}
  private status:BrowserSessionStatus='connecting';
  private statusError:string|undefined;
  private setStatus(status:BrowserSessionStatus,errorCode?:string){
    if(this.status===status&&this.statusError===errorCode)return;
    this.status=status;this.statusError=errorCode;
    try{this.options.onStatus?.(status,errorCode);}catch{/* subscriber cannot affect validation */}
  }
  private current:PsimIdentity|null=null;
  private token:string|null=null;
  private profile:BrowserProfile|null=null;
  private binding:BrowserProfile|null=null;
  private generation=0;
  private suspended=false;
  private closed=false;
  private syncing:Promise<void>|null=null;
  /** The last fully successful check: when it started and under which auth generation. Revocation and failure clear it. */
  private verified:{startedAt:number;generation:number}|undefined;
  private opening:Promise<void>|null=null;
  private loginIntent=0;
  private active=new Set<AbortController>();
  private poll:ReturnType<typeof setInterval>|null=null;
  private backgroundPolling:boolean;
  constructor(private changed:(identity:PsimIdentity|null)=>void=()=>{},private options:BrowserProfileSessionOptions={}){
    this.backgroundPolling=options.backgroundPolling!==false;
    if(options.enabled===false)return;
    this.updatePolling();
    void this.sync().catch(()=>{});
  }
  /** Only controls idle observation; explicit operations still validate the browser session. */
  setBackgroundPolling(enabled:boolean){this.backgroundPolling=enabled;this.updatePolling();}
  private updatePolling(){
    if(!this.backgroundPolling||this.suspended||this.closed||this.options.enabled===false){if(this.poll)clearInterval(this.poll);this.poll=null;return;}
    if(this.poll)return;
    this.poll=setInterval(()=>{void this.sync().catch(()=>{});},this.options.syncIntervalMs??4000);this.poll.unref();
  }
  identity(){return clone(this.current);}
  getBrowserProfile():BrowserProfile|null{return this.current&&this.profile?{...this.profile}:null;}
  /** The verified bearer for the TSim operator iframe, only while `identity` is still current. */
  operatorGrant(identity:PsimIdentity):OperatorSessionGrant|null{return same(identity,this.current)&&this.token&&!this.suspended&&!this.closed?{accessToken:this.token,sessionRef:null}:null;}
  private publish(){try{this.changed(this.identity());}catch{/* subscriber cannot affect revocation */}}
  private revoke(){this.waitBounds=null;this.generation++;this.verified=undefined;const hadIdentity=!!this.current;this.current=null;this.token=null;this.profile=null;for(const controller of this.active)controller.abort();this.active.clear();if(hadIdentity)this.publish();}
  private async tokenAt(profile:BrowserProfile):Promise<string|null>{
    addTelemetry('authTokenReads',1);
    const value=await timeTelemetry('authTokenReadMs',()=>(this.options.readToken??((directory:string)=>readTsimToken(directory,{throwOnFailure:true})))(storage(profile)));
    if(value===null)return null;
    if(typeof value!=='string'||!value.trim()||value.length>16000)throw new Error('BROWSER_SESSION_STORAGE_INVALID');
    return value;
  }
  private async checkedTokenAt(profile:BrowserProfile):Promise<string|null>{
    try{return await this.tokenAt(profile);}catch(error){
      this.revoke();
      const code=error instanceof Error&&/^BROWSER_SESSION_[A-Z_]+$/.test(error.message)?error.message:'BROWSER_SESSION_STORAGE_INVALID';
      this.setStatus('failed',code);throw new Error(code);
    }
  }
  private diskChanged(token:string|null){this.revoke();this.setStatus(token?'connecting':'needs_login');}
  private async request(path:string,body?:(OutboundBody&{client_source:'travel_merchant_companion'})|{order_nums:string},signal?:AbortSignal):Promise<any>{
    const url=new URL(path,API);
    const readPath=url.pathname==='/agent/profile'&&!url.search||url.pathname==='/agent/package-query/dataplan-list'&&[...url.searchParams.keys()].join(',')==='query_id'||url.pathname==='/agent/package-query/detail'&&[...url.searchParams.keys()].join(',')==='card_dataplan_id';
    const postPath=['/agent/translate','/agent/package-query/perform'].includes(url.pathname)&&!url.search;
    if(url.origin!==API||url.hash||url.username||url.password||!(body?postPath:readPath))throw new Error('FORBIDDEN_SERVICE_REQUEST');
    const token=this.token,generation=this.generation;if(!token)throw new Error('PSIM_LOGIN_REQUIRED');
    const controller=new AbortController();this.active.add(controller);
    const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(this.options.requestTimeoutMs??20000),...(signal?[signal]:[])]);
    let telemetry:ReturnType<typeof startHttpTelemetry>;
    try{
      const payload=body?JSON.stringify(body):undefined;
      telemetry=startHttpTelemetry(url.pathname,this.options.requestTimeoutMs??20000,payload);
      const response=await (this.options.fetcher??fetch)(`${API}${path}`,{method:body?'POST':'GET',headers:{Accept:'application/json',Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:payload}:{}),redirect:'error',signal:combined});
      telemetry?.headers(response);
      if(this.closed||this.suspended||generation!==this.generation||token!==this.token)throw new Error('AUTH_CHANGED');
      // Any auth or permission refusal makes the next outbound translation run a full check first.
      if([401,403,422,423].includes(response.status))this.verified=undefined;
      if(response.status===401||response.status===423){if(path==='/agent/translate'){this.revoke();this.setStatus('needs_login');}throw new Error('PSIM_LOGIN_REQUIRED');}
      if(response.status===403||response.status===422)throw new Error(path.startsWith('/agent/package-query/')?'ORDER_PERMISSION_REQUIRED':'TRANSLATION_PERMISSION_REQUIRED');
      if(response.status===429)throw new Error('RATE_LIMITED');
      if(!response.ok)throw new Error('SERVICE_UNAVAILABLE');
      if(Number(response.headers.get('content-length'))>200000)throw new Error('INVALID_SERVICE_RESPONSE');
      telemetry?.body();
      const reader=response.body?.getReader();if(!reader)throw new Error('INVALID_SERVICE_RESPONSE');
      let length=0;const chunks:Uint8Array[]=[];
      for(;;){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;telemetry?.progress(length);if(length>200000){await reader.cancel();throw new Error('INVALID_SERVICE_RESPONSE');}chunks.push(next.value);}
      const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      telemetry?.bodyDone(length);
      const parseStarted=performance.now();telemetry?.parsing();
      try{const result=JSON.parse(new TextDecoder().decode(bytes));telemetry?.parsed(result,parseStarted);return result;}catch{throw new Error('INVALID_SERVICE_RESPONSE');}
    }catch(error){
      telemetry?.failed();
      if(signal?.aborted)throw new Error('REQUEST_ABORTED');
      if(this.closed||this.suspended||generation!==this.generation)throw new Error('AUTH_CHANGED');
      if(combined.aborted)throw new Error('BROWSER_SESSION_TIMEOUT');
      if(error instanceof Error&&/^[A-Z][A-Z0-9_]{1,80}$/.test(error.message))throw error;
      throw new Error('SERVICE_UNAVAILABLE');
    }finally{telemetry?.done();this.active.delete(controller);}
  }
  async sync(options:SessionSyncOptions={}):Promise<void>{
    if(this.options.enabled===false||this.closed||this.suspended)return;
    const telemetryStarted=performance.now();
    addTelemetry('authChecks',1);setTelemetry({sessionMode:'browser',authStateBefore:this.status});
    try{
      // An in-flight check is always joined, never skipped: it may observe an account change.
      if(this.syncing){setTelemetry({authCheckMode:'joined'});return await this.syncing;}
      if(options.reuseRecent&&this.recentlyVerified()){setTelemetry({authCheckMode:'reused'});return;}
      setTelemetry({authCheckMode:'fresh'});
      if(!this.current)this.setStatus('connecting');
      const startedAt=this.now();
      this.syncing=this.synchronize(startedAt).finally(()=>{this.syncing=null;});return await this.syncing;
    }finally{addTelemetry('authMs',performance.now()-telemetryStarted);setTelemetry({authStateAfter:this.status,authGeneration:this.generation});}
  }
  private now(){return this.options.now?this.options.now():performance.now();}
  /** Only a completed, successful check of the still-current session counts; failures and revocations never do. */
  private recentlyVerified(){
    const verified=this.verified;
    if(!verified||this.status!=='ready'||!this.current||!this.token||!this.profile)return false;
    if(verified.generation!==this.generation||this.current.authGeneration!==this.generation)return false;
    const age=this.now()-verified.startedAt;
    return age>=0&&age<=OUTBOUND_SYNC_REUSE_MS;
  }
  private async synchronize(startedAt:number):Promise<void>{
    let expectedGeneration=this.generation;
    try{
      const readErrors:Error[]=[];
      const collect=(error:Error)=>{readErrors.push(error);};
      const profiles=await (this.options.discoverProfiles?this.options.discoverProfiles(collect):discoverBrowserProfiles(process.env,process.platform,collect));
      if(this.closed||this.suspended||expectedGeneration!==this.generation)return;
      // Only a successfully verified profile establishes a persistent binding.
      // A bound profile failing later must never cause an implicit account switch.
      const bound=this.binding,candidates=bound?profiles.filter(profile=>profileKey(profile)===profileKey(bound)):profiles;
      for(const selected of candidates){
        let token:string|null;
        try{token=await this.tokenAt(selected);}catch(error){if(bound)throw error;readErrors.push(error instanceof Error?error:new Error('BROWSER_SESSION_STORAGE_INVALID'));continue;}
        if(this.closed||this.suspended||expectedGeneration!==this.generation)return;
        if(!token)continue;
        if(token!==this.token||!this.profile||profileKey(selected)!==profileKey(this.profile)){
          this.revoke();this.token=token;this.profile={...selected};expectedGeneration=this.generation;
        }
        try{
          const response=await this.request('/agent/profile');
          if(this.closed||this.suspended||expectedGeneration!==this.generation)return;
          const data=response?.data;
          if(response?.success!==true||data?.is_active!==true||!/^[-A-Za-z0-9_]{1,128}$/.test(String(data?.id??''))||!Array.isArray(data.permissions)||data.permissions.length>200||!data.permissions.every((permission:unknown)=>typeof permission==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(permission)))throw new Error('PROFILE_UNVERIFIED');
          // A disk-side logout/rotation during profile validation cannot publish an old session.
          const checked=await this.checkedTokenAt(selected);
          if(checked!==token){this.diskChanged(checked);throw new Error('AUTH_CHANGED');}
          if(this.closed||this.suspended||expectedGeneration!==this.generation)return;
          const accountScope=`psim:${data.id}`,permissions=[...new Set<string>(data.permissions)].sort();
          if(this.current&&(this.current.accountScope!==accountScope||JSON.stringify(this.current.permissions)!==JSON.stringify(permissions))){this.revoke();this.token=token;this.profile={...selected};}
          this.waitBounds=parseOutboundWaitBounds(data.outbound_wait);
          this.binding={...selected};
          const next={accountScope,permissions,authGeneration:this.generation};if(!same(next,this.current)){this.current=next;this.publish();}
          if(!this.closed&&!this.suspended&&this.current?.authGeneration===this.generation)this.verified={startedAt,generation:this.generation};
          this.setStatus('ready');return;
        }catch(error){
          if(!bound&&!this.closed&&!this.suspended&&expectedGeneration===this.generation&&error instanceof Error&&['PSIM_LOGIN_REQUIRED','PROFILE_UNVERIFIED'].includes(error.message)){
            this.revoke();expectedGeneration=this.generation;continue;
          }
          throw error;
        }
      }
      if(readErrors.length)throw readErrors.find(error=>error.message==='BROWSER_SESSION_ACCESS_DENIED')??readErrors[0];
      this.revoke();this.setStatus('needs_login');
    }catch(error){this.verified=undefined;if(expectedGeneration===this.generation&&!this.closed&&!this.suspended){this.revoke();const code=error instanceof Error?error.message:'SERVICE_UNAVAILABLE';this.setStatus(code==='PSIM_LOGIN_REQUIRED'?'needs_login':'failed',code==='PSIM_LOGIN_REQUIRED'?undefined:code);}throw error;}
  }
  /**
   * `superseded` is aborted when a newer revision of the same draft replaces this request. Before the POST
   * it drops the request (`REQUEST_SUPERSEDED`); once sent, only `signal` aborts it, so the caller can let
   * it finish and discard the result by its own version check.
   */
  async translate(body:OutboundBody,expectedIdentity:PsimIdentity,signal:AbortSignal,superseded?:AbortSignal):Promise<OutboundResponse>{
    if(this.options.enabled===false)throw new Error('BROWSER_SESSION_DISABLED');
    if(!record(body)||!keys(body,['text','target_lang','source_lang','purpose','draft_request_id','composer_content_version'])||typeof body.text!=='string'||!body.text.trim()||body.text.length>20000||!WORKBENCH_TARGETS.includes(body.target_lang)||body.source_lang!=='zh'||body.purpose!=='outbound'||typeof body.draft_request_id!=='string'||!/^[-a-z0-9]{1,100}$/.test(body.draft_request_id)||typeof body.composer_content_version!=='string'||body.composer_content_version.length>25000)throw new Error('INVALID_OUTBOUND_REQUEST');
    if(signal.aborted)throw new Error('REQUEST_ABORTED');
    const dropSuperseded=()=>{if(superseded?.aborted)throw new Error('REQUEST_SUPERSEDED');};dropSuperseded();
    let abort!:()=>void,supersede!:()=>void;
    // Usually reuses the check CompanionService ran just before this call (see OUTBOUND_SYNC_REUSE_MS).
    try{await Promise.race([this.sync({reuseRecent:true}),new Promise<never>((_,reject)=>{abort=()=>reject(new Error('REQUEST_ABORTED'));supersede=()=>reject(new Error('REQUEST_SUPERSEDED'));signal.addEventListener('abort',abort,{once:true});superseded?.addEventListener('abort',supersede,{once:true});if(signal.aborted)abort();else if(superseded?.aborted)supersede();})]);}finally{signal.removeEventListener('abort',abort);superseded?.removeEventListener('abort',supersede);}
    if(!this.current||!same(expectedIdentity,this.current)||!this.profile||!this.token)throw new Error('AUTH_CHANGED');
    dropSuperseded();
    const generation=this.generation,token=this.token,profile={...this.profile};
    const result=await this.request('/agent/translate',{...body,client_source:'travel_merchant_companion'},signal);
    try{
      const freshToken=await timeTelemetry('postReadTokenMs',()=>this.checkedTokenAt(profile));
      if(signal.aborted)throw new Error('REQUEST_ABORTED');
      if(freshToken!==token){this.diskChanged(freshToken);throw new Error('AUTH_CHANGED');}
      if(generation!==this.generation||!same(expectedIdentity,this.current))throw new Error('AUTH_CHANGED');
    }catch(error){setTelemetry({httpFailurePhase:'auth'});throw error;}
    const data=result?.data;
    if(result?.success!==true||typeof data?.translated_text!=='string'||!data.translated_text.trim()||data.translated_text.length>50000||data.draft_request_id!==body.draft_request_id||data.composer_content_version!==body.composer_content_version){setTelemetry({httpFailurePhase:'validation'});throw new Error('OUTBOUND_ECHO_MISMATCH');}
    return {success:true,data:{translated_text:data.translated_text,draft_request_id:data.draft_request_id,composer_content_version:data.composer_content_version}};
  }
  async openLogin():Promise<void>{
    if(this.options.enabled===false)return;if(this.closed)throw new Error('BROWSER_SESSION_DISPOSED');
    if(this.opening)return this.opening;
    const intent=++this.loginIntent;
    const operation=this.openLoginTarget(intent).catch(async error=>{
      if(!this.closed&&intent===this.loginIntent&&error instanceof Error&&error.message==='BROWSER_SESSION_ACCESS_DENIED'){
        // Keep the original permission failure if the OS settings app cannot be opened.
        try{await this.options.onAccessDenied?.();}catch{/* The next explicit login can retry the guide. */}
      }
      throw error;
    });this.opening=operation;
    try{await operation;}finally{if(this.opening===operation)this.opening=null;}
  }
  private async openLoginTarget(intent:number):Promise<void>{
    const wasSuspended=this.suspended;
    // Reconnect to an existing website login before opening another login page.
    // An already connected user can still explicitly open the bound browser to manage it.
    if(!this.current){
      this.suspended=false;
      try{
        await this.sync();
        if(this.closed)throw new Error('BROWSER_SESSION_DISPOSED');
        if(intent!==this.loginIntent||this.suspended)throw new Error('AUTH_CHANGED');
        if(this.current){this.updatePolling();return;}
      }catch(error){
        if(this.closed)throw new Error('BROWSER_SESSION_DISPOSED');
        if(intent!==this.loginIntent||this.suspended)throw new Error('AUTH_CHANGED');
        // Confirmed auth loss needs the website; network/storage failures keep their specific error.
        if(!(error instanceof Error&&['PSIM_LOGIN_REQUIRED','PROFILE_UNVERIFIED'].includes(error.message))){this.suspended=wasSuspended;this.updatePolling();throw error;}
      }
    }
    this.suspended=true;this.updatePolling();this.revoke();
    const generation=this.generation;
    const assertCurrent=()=>{if(this.closed)throw new Error('BROWSER_SESSION_DISPOSED');if(generation!==this.generation)throw new Error('AUTH_CHANGED');};
    try{
      // Finish an old scan before choosing the explicit login target; it must not restore an old binding later.
      await this.syncing?.catch(()=>{});
      const profiles=await (this.options.discoverProfiles??discoverBrowserProfiles)();
      assertCurrent();
      const selected=profiles.find(profile=>this.binding&&profileKey(profile)===profileKey(this.binding))??profiles[0];
      if(selected){
        await (this.options.openProfile??openBrowserProfile)({...selected},LOGIN_URL);
        assertCurrent();
        // Only an explicit login may select another profile after the previous one disappears.
        if(!this.binding||profileKey(selected)!==profileKey(this.binding))this.binding={...selected};
      }else{
        if(!this.options.openExternal)throw new Error('BROWSER_LOGIN_OPENER_REQUIRED');
        await this.options.openExternal(LOGIN_URL);
      }
      assertCurrent();
      this.suspended=false;this.updatePolling();await this.sync();
    }catch(error){
      // A failed opener must not permanently disable observation. A later explicit logout still wins.
      if(!this.closed&&generation===this.generation){this.suspended=wasSuspended;this.updatePolling();this.setStatus('failed',error instanceof Error?error.message:'BROWSER_LOGIN_OPEN_FAILED');}
      throw error;
    }
  }
  /** Explicit lookup only. Projects allowlisted scalar fields; no business-write endpoint or remote UI. */
  async queryOriginalIdentifier(identifier:string,signal:AbortSignal):Promise<EmbeddedOrderResult>{
    if(this.options.enabled===false)throw new Error('BROWSER_SESSION_DISABLED');
    if(typeof identifier!=='string'||!/^[-A-Za-z0-9_]{1,128}$/.test(identifier))throw new Error('INVALID_ORDER_IDENTIFIER');
    if(signal.aborted)throw new Error('REQUEST_ABORTED');
    const identity=this.identity();if(!identity)throw new Error('PSIM_LOGIN_REQUIRED');
    await this.sync();
    if(!same(identity,this.current)||!this.profile||!this.token)throw new Error('AUTH_CHANGED');
    if(!identity.permissions.includes('complaint_records'))throw new Error('ORDER_PERMISSION_REQUIRED');
    const token=this.token,profile={...this.profile};
    const check=async()=>{
      if(signal.aborted)throw new Error('REQUEST_ABORTED');
      if(!same(identity,this.current))throw new Error('AUTH_CHANGED');
      const fresh=await this.checkedTokenAt(profile);
      if(fresh!==token){this.diskChanged(fresh);throw new Error('AUTH_CHANGED');}
      if(signal.aborted)throw new Error('REQUEST_ABORTED');
      if(!same(identity,this.current))throw new Error('AUTH_CHANGED');
    };
    const query=async(path:string,body?:{order_nums:string})=>{await check();const result=await this.request(path,body,signal);await check();return result;};
    const safeId=(value:unknown)=>{const s=typeof value==='string'?value:typeof value==='number'&&Number.isSafeInteger(value)?String(value):'';if(!/^[-A-Za-z0-9_]{1,128}$/.test(s))throw new Error('ORDER_RESPONSE_INVALID');return s;};
    const started=await query('/agent/package-query/perform',{order_nums:identifier});
    if(![1,2].includes(started?.code))throw new Error('ORDER_QUERY_FAILED');
    const queryId=safeId(started?.result?.query_id);
    const listed=await query('/agent/package-query/dataplan-list?'+new URLSearchParams({query_id:queryId}));
    if(listed?.code!==1||!Array.isArray(listed.result)||listed.result.length>100)throw new Error('ORDER_RESPONSE_INVALID');
    const fields:{label:string;value:string}[]=[];
    const labels:Record<string,string>={status:'状态',package_status:'套餐状态',iccid:'ICCID',eiccid:'eICCID',channel_name:'渠道',supplier_name:'供应商',channel_dataplan_name:'套餐名称',type:'类型',out_order_identifier:'渠道订单号',custom_order_id:'订单号'};
    for(const [index,row] of listed.result.slice(0,20).entries()){
      const detail=await query('/agent/package-query/detail?'+new URLSearchParams({card_dataplan_id:safeId(row?.card_dataplan_id)}));
      if(detail?.code!==1||!record(detail.result))throw new Error('ORDER_RESPONSE_INVALID');
      for(const [key,label] of Object.entries(labels)){
        const value=detail.result[key];if(typeof value!=='string'&&!(typeof value==='number'&&Number.isFinite(value)))continue;
        const rendered=String(value);if(rendered.length>1000)continue;
        fields.push({label:`套餐 ${index+1} · ${label}`,value:rendered});
      }
    }
    if(listed.result.length>20)fields.push({label:'展示范围',value:`共 ${listed.result.length} 个套餐，当前展示前 20 个`});
    await check();return{identifier,found:listed.result.length>0,fields};
  }
  async logout():Promise<void>{this.loginIntent++;this.suspended=true;this.updatePolling();this.revoke();this.binding=null;this.setStatus('needs_login');}
  dispose(){if(this.closed)return;this.loginIntent++;this.closed=true;this.updatePolling();this.revoke();this.binding=null;}
}
