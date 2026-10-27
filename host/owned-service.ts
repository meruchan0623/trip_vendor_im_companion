import {startHttpTelemetry,setTelemetry} from '../electron/translation-telemetry';
import {parseOutboundWaitBounds} from '../runtime/outbound-wait-bounds';
import type {OutboundWaitBounds} from '../runtime/outbound-wait-controller';
import {WORKBENCH_TARGETS,type OperatorSessionGrant,type OutboundBody,type OutboundResponse,type PsimIdentity} from '../src/shared/workbench';
import type {OrderSummary} from '../src/shared/order-summary';
import {collectOrderSummary} from '../electron/order-summary-query';
export const PSIM_API_ORIGIN='https://csapi.tsim.tech';
const READ_PATHS=new Set(['/agent/profile','/agent/package-query/dataplan-list','/agent/package-query/detail','/agent/package-query/live-detail','/agent/package-query/cdr-more']);
const POST_PATHS=new Set(['/agent/login','/agent/auth/refresh','/agent/logout','/agent/translate','/agent/package-query/perform']);
const fail=(code:string)=>new Error(code);
type Fetcher=(input:string,init:RequestInit)=>Promise<Response>;
export interface OwnedSessionStore {
  load():Promise<{accessToken:string;sessionRef:string}|null>;
  save(value:{accessToken:string;sessionRef:string}):Promise<void>;
  clear():Promise<void>;
}
type StoredSession={accessToken:string;sessionRef:string};
function storageError(error:unknown,fallback:string):Error {const code=error instanceof Error?error.message:'';return fail(/^SESSION_STORAGE_[A-Z_]{1,60}$/.test(code)?code:fallback);}
const REFRESH_WINDOW_MS=5*60_000,OPAQUE_REFRESH_MS=30*60_000;
function storedSession(value:unknown):StoredSession|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const candidate=value as Record<string,unknown>;
  if(Object.keys(candidate).sort().join(',')!=='accessToken,sessionRef'||typeof candidate.accessToken!=='string'||!candidate.accessToken||candidate.accessToken.length>16000||/[\s\u0000-\u001f\u007f]/.test(candidate.accessToken)||typeof candidate.sessionRef!=='string'||!candidate.sessionRef||candidate.sessionRef.length>2048||/[\u0000-\u001f\u007f]/.test(candidate.sessionRef))return null;
  return{accessToken:candidate.accessToken,sessionRef:candidate.sessionRef};
}
function tokenExpiry(token:string):number|null {
  try{const parts=token.split('.');if(parts.length!==3)return null;const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));return typeof payload.exp==='number'&&Number.isFinite(payload.exp)&&payload.exp>0?payload.exp*1000:null;}catch{return null;}
}
export interface OrderProjection {identifier:string;found:boolean;fields:{label:string;value:string}[];source:'旅游商家原编号（未转换）';ownership:'tsim_cs 服务端权限核验'}
function scalar(value:unknown):string|undefined{if(typeof value==='string'&&value.length<=1000)return value;if(typeof value==='number'&&Number.isFinite(value))return String(value);return undefined;}
function id(value:unknown):string{const text=scalar(value);if(!text||!/^[-A-Za-z0-9_]{1,128}$/.test(text))throw fail('INVALID_READ_IDENTIFIER');return text;}
/** Runs inside the owned auth child. Server response envelopes never leave this process; the bearer leaves only via `operatorGrant`. */
export class OwnedPsimService {
  private waitBounds:OutboundWaitBounds|null=null;
  outboundWaitBounds(){return this.waitBounds?{...this.waitBounds}:null;}
  private token:string|null=null;private sessionRef:string|null=null;private accountId:string|null=null;private permissions:string[]=[];private epoch=0;private verified=false;private closed=false;private authQueue=Promise.resolve();
  private active=new Set<AbortController>();
  private revision=0;private storeQueue:Promise<void>=Promise.resolve();private refreshedAt=0;private dirty=false;
  constructor(private fetcher:Fetcher=fetch,private changed:(identity:PsimIdentity|null)=>void=()=>{},private store?:OwnedSessionStore){}
  private assertCurrent(revision:number){if(this.closed||revision!==this.revision)throw fail('AUTH_CHANGED');}
  private storage<T>(operation:()=>Promise<T>):Promise<T>{const result=this.storeQueue.then(operation);this.storeQueue=result.then(()=>{},()=>{});return result;}
  private async forgetStored(){if(!this.store)return;try{await this.storage(()=>this.store!.clear());}catch(error){throw storageError(error,'PSIM_SESSION_CLEAR_FAILED');}}
  private async persist(revision:number){
    if(!this.store||!this.dirty)return;this.assertCurrent(revision);const value=storedSession({accessToken:this.token,sessionRef:this.sessionRef});if(!value)throw fail('INVALID_STORED_SESSION');
    try{await this.storage(async()=>{this.assertCurrent(revision);await this.store!.save(value);});}catch(error){if(error instanceof Error&&error.message==='AUTH_CHANGED')throw error;if(revision===this.revision)this.revoke();throw storageError(error,'PSIM_SESSION_SAVE_FAILED');}this.assertCurrent(revision);this.dirty=false;
  }
  private async rejectSession(){this.clear();await this.forgetStored();}
  identity():PsimIdentity|null{return this.verified&&this.token&&this.accountId?{accountScope:`psim:${this.accountId}`,authGeneration:this.epoch,permissions:[...this.permissions]}:null;}
  private revoke(){this.waitBounds=null;this.epoch++;this.verified=false;for(const controller of this.active)controller.abort();this.active.clear();this.changed(null);}
  private clear(){this.revoke();this.token=null;this.sessionRef=null;this.accountId=null;this.permissions=[];this.dirty=false;}
  private serialAuth<T>(operation:()=>Promise<T>):Promise<T>{const result=this.authQueue.then(()=>{if(this.closed)throw fail('OWNED_SERVICE_CLOSED');return operation();});this.authQueue=result.then(()=>{},()=>{});return result;}
  private async request(method:'GET'|'POST',path:string,body:unknown,signal?:AbortSignal,token=this.token):Promise<any>{
    const url=new URL(path,PSIM_API_ORIGIN);if(url.origin!==PSIM_API_ORIGIN||url.hash||url.username||url.password||(method==='GET'?!READ_PATHS.has(url.pathname):!POST_PATHS.has(url.pathname)))throw fail('FORBIDDEN_SERVICE_REQUEST');
    if(method==='POST'&&url.search)throw fail('FORBIDDEN_SERVICE_REQUEST');
    if(method==='GET'){const allowed=url.pathname.endsWith('/dataplan-list')?'query_id':url.pathname.endsWith('/detail')||url.pathname.endsWith('/live-detail')||url.pathname.endsWith('/cdr-more')?'card_dataplan_id':null;for(const key of url.searchParams.keys())if(key!==allowed)throw fail('FORBIDDEN_SERVICE_REQUEST');}
    const requestEpoch=this.epoch;const controller=new AbortController();this.active.add(controller);const combined=signal?AbortSignal.any([signal,controller.signal,AbortSignal.timeout(30000)]):AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]);
    let telemetry:ReturnType<typeof startHttpTelemetry>;
    try{const headers:Record<string,string>={'Accept':'application/json'};if(token)headers.Authorization=`Bearer ${token}`;let payload:BodyInit|undefined;if(body instanceof FormData)payload=body;else if(body!==undefined){headers['Content-Type']='application/json';payload=JSON.stringify(body);}
      telemetry=startHttpTelemetry(url.pathname,30000,payload);
      const response=await this.fetcher(url.href,{method,headers,body:payload,signal:combined,redirect:'error'});
      telemetry?.headers(response);
      if(!response.ok){if((response.status===401||response.status===423)&&token&&token===this.token&&requestEpoch===this.epoch)await this.rejectSession();throw fail(`PSIM_HTTP_${response.status}`);}
      telemetry?.body();const text=await response.text();telemetry?.bodyDone(Buffer.byteLength(text,'utf8'));if(text.length>2_000_000)throw fail('SERVICE_RESPONSE_TOO_LARGE');const parseStarted=performance.now();telemetry?.parsing();try{const result=JSON.parse(text);telemetry?.parsed(result,parseStarted);return result;}catch{throw fail('INVALID_SERVICE_RESPONSE');}
    }catch(error){telemetry?.failed();throw error;}finally{telemetry?.done();this.active.delete(controller);}
  }
  login(username:string,password:string):Promise<PsimIdentity>{
    // Invalidate in-flight restoration immediately, even when this login waits in the queue.
    this.revision++;this.clear();const revision=this.revision;
    return this.serialAuth(()=>this.loginInternal(username,password,revision));
  }
  private async loginInternal(username:string,password:string,revision:number):Promise<PsimIdentity>{
    this.assertCurrent(revision);
    if(typeof username!=='string'||username.length<1||username.length>200||typeof password!=='string'||password.length<1||password.length>4096)throw fail('INVALID_LOGIN');
    await this.forgetStored();this.assertCurrent(revision);const form=new FormData();form.set('username',username);form.set('password',password);
    const response=await this.request('POST','/agent/login',form,undefined,null);this.assertCurrent(revision);
    const session=storedSession({accessToken:response?.data?.access_token,sessionRef:response?.data?.session_ref});
    if(response?.success!==true||response?.data?.token_type!=='bearer'||!session)throw fail('LOGIN_RESPONSE_INVALID');
    this.token=session.accessToken;this.sessionRef=session.sessionRef;this.refreshedAt=Date.now();this.dirty=true;
    const identity=await this.validate();this.assertCurrent(revision);await this.persist(revision);return identity;
  }
  async validate():Promise<PsimIdentity>{
    if(!this.token||this.closed)throw fail('PSIM_LOGIN_REQUIRED');const epoch=this.epoch;let response:any;
    try{response=await this.request('GET','/agent/profile',undefined);}catch(error){if(epoch===this.epoch)this.revoke();throw error;}
    if(epoch!==this.epoch||this.closed)throw fail('AUTH_CHANGED');const data=response?.data;
    let account:string;try{account=id(data?.id);}catch{await this.rejectSession();throw fail('PROFILE_UNVERIFIED');}
    if(response?.success!==true||data?.is_active!==true||!Array.isArray(data.permissions)||!data.permissions.every((permission:unknown)=>typeof permission==='string'&&permission.length<=100)){await this.rejectSession();throw fail('PROFILE_UNVERIFIED');}
    const permissions=[...new Set<string>(data.permissions)].sort(),wasVerified=this.verified;let changed=false;
    if(this.accountId!==account||JSON.stringify(this.permissions)!==JSON.stringify(permissions)){this.epoch++;for(const controller of this.active)controller.abort();this.accountId=account;this.permissions=permissions;changed=true;}
    this.waitBounds=parseOutboundWaitBounds(data.outbound_wait);
    this.verified=true;if(changed||!wasVerified)this.changed(this.identity());const identity=this.identity();if(!identity)throw fail('PROFILE_UNVERIFIED');return identity;
  }
  restore():Promise<PsimIdentity|null>{return this.serialAuth(()=>this.restoreInternal(this.revision));}
  private async restoreInternal(revision:number):Promise<PsimIdentity|null>{
    this.assertCurrent(revision);if(this.token)return this.validate();if(!this.store)return null;
    let value:unknown;try{value=await this.storage(()=>this.store!.load());}catch(error){throw storageError(error,'PSIM_SESSION_LOAD_FAILED');}this.assertCurrent(revision);
    if(value===null)return null;const session=storedSession(value);if(!session){await this.forgetStored();this.assertCurrent(revision);throw fail('INVALID_STORED_SESSION');}
    this.token=session.accessToken;this.sessionRef=session.sessionRef;this.refreshedAt=Date.now();
    return this.validate();
  }
  ensureSession():Promise<PsimIdentity|null>{return this.serialAuth(async()=>{
    const revision=this.revision;let identity=this.token?await this.validate():await this.restoreInternal(revision);this.assertCurrent(revision);
    if(!identity||!this.token)return null;const expiry=tokenExpiry(this.token);
    if(expiry===null?Date.now()-this.refreshedAt>=OPAQUE_REFRESH_MS:expiry-Date.now()<=REFRESH_WINDOW_MS)identity=await this.refreshInternal(revision);
    else await this.persist(revision);
    return identity;
  });}
  refresh():Promise<PsimIdentity>{return this.serialAuth(()=>this.refreshInternal(this.revision));}
  private async refreshInternal(revision:number):Promise<PsimIdentity>{
    this.assertCurrent(revision);if(!this.token)throw fail('PSIM_LOGIN_REQUIRED');this.revoke();
    const response=await this.request('POST','/agent/auth/refresh',undefined);this.assertCurrent(revision);
    const session=storedSession({accessToken:response?.data?.access_token,sessionRef:response?.data?.session_ref});
    if(response?.success!==true||response?.data?.token_type!=='bearer'||!session){await this.rejectSession();throw fail('REFRESH_RESPONSE_INVALID');}
    this.token=session.accessToken;this.sessionRef=session.sessionRef;this.refreshedAt=Date.now();this.dirty=true;
    const identity=await this.validate();this.assertCurrent(revision);await this.persist(revision);return identity;
  }
  logout():Promise<void>{
    const token=this.token;this.revision++;this.clear();
    // Queue durable deletion now, after any write that has already begun.
    const cleared=this.forgetStored().then(()=>null,error=>error as Error);
    return this.serialAuth(async()=>{
      const clearError=await cleared;let remoteError:unknown;
      // A failed disk deletion must not leave the server session active.
      try{if(token)await this.request('POST','/agent/logout',undefined,undefined,token);}catch(error){remoteError=error;}
      if(clearError)throw clearError;if(remoteError)throw remoteError;
    });
  }
  async translate(body:OutboundBody,identity:PsimIdentity,signal:AbortSignal):Promise<OutboundResponse>{
    const current=this.identity();if(!current||current.accountScope!==identity.accountScope||current.authGeneration!==identity.authGeneration)throw fail('AUTH_CHANGED');
    if(body.purpose!=='outbound'||body.source_lang!=='zh'||typeof body.text!=='string'||!body.text.trim()||body.text.length>20000||!/^[-a-z0-9]{1,100}$/.test(body.draft_request_id)||typeof body.composer_content_version!=='string'||body.composer_content_version.length>25000||!WORKBENCH_TARGETS.includes(body.target_lang))throw fail('INVALID_OUTBOUND_REQUEST');
    const result=await this.request('POST','/agent/translate',body,signal);if(signal.aborted||this.identity()?.authGeneration!==identity.authGeneration){setTelemetry({httpFailurePhase:'auth'});throw fail('AUTH_CHANGED');}const data=result?.data;
    if(result?.success!==true||typeof data?.translated_text!=='string'||!data.translated_text.trim()||data.translated_text.length>50000||data.draft_request_id!==body.draft_request_id||data.composer_content_version!==body.composer_content_version){setTelemetry({httpFailurePhase:'validation'});throw fail('OUTBOUND_ECHO_MISMATCH');}
    return{success:true,data:{translated_text:data.translated_text,draft_request_id:data.draft_request_id,composer_content_version:data.composer_content_version}};
  }
  async queryOriginalIdentifier(identifier:string,identity:PsimIdentity,signal:AbortSignal):Promise<OrderProjection>{
    if(typeof identifier!=='string'||!identifier.trim()||identifier.length>128||/[\r\n\u0000]/.test(identifier))throw fail('INVALID_ORDER_IDENTIFIER');
    const fresh=await this.validate();if(fresh.accountScope!==identity.accountScope||fresh.authGeneration!==identity.authGeneration)throw fail('AUTH_CHANGED');if(!fresh.permissions.includes('complaint_records'))throw fail('ORDER_PERMISSION_REQUIRED');
    const result=await this.request('POST','/agent/package-query/perform',{order_nums:identifier.trim()},signal);if(result?.code!==1&&result?.code!==2)throw fail('ORDER_QUERY_FAILED');const queryId=id(result?.result?.query_id);
    const listed=await this.request('GET',`/agent/package-query/dataplan-list?${new URLSearchParams({query_id:queryId})}`,undefined,signal);const rows=Array.isArray(listed?.result)?listed.result:Array.isArray(listed?.data)?listed.data:null;if(!rows||rows.length>100)throw fail('ORDER_LIST_RESPONSE_INVALID');
    const fields:{label:string;value:string}[]=[];const details=['status','package_status','iccid','eiccid','topup_id','channel_name','supplier_name','channel_dataplan_name','type','out_order_identifier','custom_order_id'];
    for(const row of rows.slice(0,20)){const card=id(row?.card_dataplan_id);const detail=await this.request('GET',`/agent/package-query/detail?${new URLSearchParams({card_dataplan_id:card})}`,undefined,signal);const value=detail?.result??detail?.data;if(!value||typeof value!=='object')throw fail('ORDER_DETAIL_RESPONSE_INVALID');for(const key of details){const text=scalar(value[key]);if(text!==undefined)fields.push({label:key,value:text});}}
    if(signal.aborted||this.identity()?.authGeneration!==identity.authGeneration)throw fail('AUTH_CHANGED');return{identifier:identifier.trim(),found:rows.length>0,fields,source:'旅游商家原编号（未转换）',ownership:'tsim_cs 服务端权限核验'};
  }
  /**
   * Automatic read for the order card under 用户信息. It never re-validates the profile (a failed validate()
   * revokes the session); the identity must stay the verified one from before the first request to the last.
   */
  async queryOrderSummary(identifier:string,identity:PsimIdentity,signal:AbortSignal):Promise<OrderSummary>{
    if(typeof identifier!=='string'||!/^[-A-Za-z0-9_]{1,128}$/.test(identifier))throw fail('INVALID_ORDER_IDENTIFIER');
    const current=()=>{
      if(signal.aborted)throw fail('REQUEST_ABORTED');
      const now=this.identity();if(!now||now.accountScope!==identity.accountScope||now.authGeneration!==identity.authGeneration)throw fail('AUTH_CHANGED');
      return now;
    };
    if(!current().permissions.includes('complaint_records'))throw fail('ORDER_PERMISSION_REQUIRED');
    const summary=await collectOrderSummary(identifier,{get:path=>this.request('GET',path,undefined,signal),post:(path,body)=>this.request('POST',path,body,signal)});
    current();return summary;
  }
  /** Explicit handoff to the TSim operator iframe for the same verified identity. */
  operatorGrant(identity:PsimIdentity):OperatorSessionGrant|null{const current=this.identity();return current&&this.token&&current.accountScope===identity.accountScope&&current.authGeneration===identity.authGeneration?{accessToken:this.token,sessionRef:this.sessionRef}:null;}
  dispose(){this.closed=true;this.revision++;this.clear();}
}
