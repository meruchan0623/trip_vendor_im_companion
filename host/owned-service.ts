import type {OutboundBody,OutboundResponse,PsimIdentity} from '../src/shared/workbench';
export const PSIM_API_ORIGIN='https://csapi.tsim.tech';
const READ_PATHS=new Set(['/agent/profile','/agent/package-query/dataplan-list','/agent/package-query/detail','/agent/package-query/live-detail']);
const POST_PATHS=new Set(['/agent/login','/agent/auth/refresh','/agent/logout','/agent/translate','/agent/package-query/perform']);
const fail=(code:string)=>new Error(code);
type Fetcher=(input:string,init:RequestInit)=>Promise<Response>;
export interface OrderProjection {identifier:string;found:boolean;fields:{label:string;value:string}[];source:'旅游商家原编号（未转换）';ownership:'tsim_cs 服务端权限核验'}
function scalar(value:unknown):string|undefined{if(typeof value==='string'&&value.length<=1000)return value;if(typeof value==='number'&&Number.isFinite(value))return String(value);return undefined;}
function id(value:unknown):string{const text=scalar(value);if(!text||!/^[-A-Za-z0-9_]{1,128}$/.test(text))throw fail('INVALID_READ_IDENTIFIER');return text;}
/** Runs inside the owned auth child. Neither tokens nor server response envelopes leave this process. */
export class OwnedPsimService {
  private token:string|null=null;private sessionRef:string|null=null;private accountId:string|null=null;private permissions:string[]=[];private epoch=0;private verified=false;private closed=false;private authQueue=Promise.resolve();
  private active=new Set<AbortController>();
  constructor(private fetcher:Fetcher=fetch,private changed:(identity:PsimIdentity|null)=>void=()=>{}){}
  identity():PsimIdentity|null{return this.verified&&this.token&&this.accountId?{accountScope:`psim:${this.accountId}`,authGeneration:this.epoch,permissions:[...this.permissions]}:null;}
  private revoke(){this.epoch++;this.verified=false;for(const controller of this.active)controller.abort();this.active.clear();this.changed(null);}
  private clear(){this.revoke();this.token=null;this.sessionRef=null;this.accountId=null;this.permissions=[];}
  private serialAuth<T>(operation:()=>Promise<T>):Promise<T>{const result=this.authQueue.then(()=>{if(this.closed)throw fail('OWNED_SERVICE_CLOSED');return operation();});this.authQueue=result.then(()=>{},()=>{});return result;}
  private async request(method:'GET'|'POST',path:string,body:unknown,signal?:AbortSignal,token=this.token):Promise<any>{
    const url=new URL(path,PSIM_API_ORIGIN);if(url.origin!==PSIM_API_ORIGIN||url.hash||url.username||url.password||(method==='GET'?!READ_PATHS.has(url.pathname):!POST_PATHS.has(url.pathname)))throw fail('FORBIDDEN_SERVICE_REQUEST');
    if(method==='POST'&&url.search)throw fail('FORBIDDEN_SERVICE_REQUEST');
    if(method==='GET'){const allowed=url.pathname.endsWith('/dataplan-list')?'query_id':url.pathname.endsWith('/detail')||url.pathname.endsWith('/live-detail')?'card_dataplan_id':null;for(const key of url.searchParams.keys())if(key!==allowed)throw fail('FORBIDDEN_SERVICE_REQUEST');}
    const controller=new AbortController();this.active.add(controller);const combined=signal?AbortSignal.any([signal,controller.signal,AbortSignal.timeout(30000)]):AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]);
    try{const headers:Record<string,string>={'Accept':'application/json'};if(token)headers.Authorization=`Bearer ${token}`;let payload:BodyInit|undefined;if(body instanceof FormData)payload=body;else if(body!==undefined){headers['Content-Type']='application/json';payload=JSON.stringify(body);}
      const response=await this.fetcher(url.href,{method,headers,body:payload,signal:combined,redirect:'error'});
      if(!response.ok){if(response.status===401&&token===this.token)this.clear();throw fail(`PSIM_HTTP_${response.status}`);}
      const text=await response.text();if(text.length>2_000_000)throw fail('SERVICE_RESPONSE_TOO_LARGE');try{return JSON.parse(text);}catch{throw fail('INVALID_SERVICE_RESPONSE');}
    }finally{this.active.delete(controller);}
  }
  login(username:string,password:string):Promise<PsimIdentity>{return this.serialAuth(()=>this.loginInternal(username,password));}
  private async loginInternal(username:string,password:string):Promise<PsimIdentity>{
    if(typeof username!=='string'||username.length<1||username.length>200||typeof password!=='string'||password.length<1||password.length>4096)throw fail('INVALID_LOGIN');
    this.clear();const epoch=this.epoch;const form=new FormData();form.set('username',username);form.set('password',password);
    const response=await this.request('POST','/agent/login',form,undefined,null);if(epoch!==this.epoch)throw fail('AUTH_CHANGED');const data=response?.data;
    if(response?.success!==true||typeof data?.access_token!=='string'||data.access_token.length>16000||data.token_type!=='bearer'||typeof data.session_ref!=='string'||!data.session_ref)throw fail('LOGIN_RESPONSE_INVALID');
    this.token=data.access_token;this.sessionRef=data.session_ref;
    try{await this.validate();}catch(error){if(epoch===this.epoch)this.clear();throw error;}const identity=this.identity();if(!identity)throw fail('LOGIN_RESPONSE_INVALID');return identity;
  }
  async validate():Promise<PsimIdentity>{
    if(!this.token||this.closed)throw fail('PSIM_LOGIN_REQUIRED');const epoch=this.epoch;let response:any;try{response=await this.request('GET','/agent/profile',undefined);}catch(error){if(epoch===this.epoch)this.revoke();throw error;}if(epoch!==this.epoch)throw fail('AUTH_CHANGED');const data=response?.data;
    if(response?.success!==true||data?.is_active!==true||!Array.isArray(data.permissions)||!data.permissions.every((permission:unknown)=>typeof permission==='string'&&permission.length<=100)){this.clear();throw fail('PROFILE_UNVERIFIED');}
    const account=id(data.id),permissions=[...new Set<string>(data.permissions)].sort(),wasVerified=this.verified;let changed=false;if(this.accountId!==account||JSON.stringify(this.permissions)!==JSON.stringify(permissions)){this.epoch++;for(const controller of this.active)controller.abort();this.accountId=account;this.permissions=permissions;changed=true;}this.verified=true;if(changed||!wasVerified)this.changed(this.identity());const identity=this.identity();if(!identity)throw fail('PROFILE_UNVERIFIED');return identity;
  }
  refresh():Promise<PsimIdentity>{return this.serialAuth(async()=>{if(!this.token)throw fail('PSIM_LOGIN_REQUIRED');this.revoke();const epoch=this.epoch;const response=await this.request('POST','/agent/auth/refresh',undefined);if(epoch!==this.epoch)throw fail('AUTH_CHANGED');const data=response?.data;if(response?.success!==true||typeof data?.access_token!=='string'||data.access_token.length>16000||data.token_type!=='bearer'||typeof data.session_ref!=='string')throw fail('REFRESH_RESPONSE_INVALID');this.token=data.access_token;this.sessionRef=data.session_ref;return this.validate();});}
  logout():Promise<void>{return this.serialAuth(async()=>{const token=this.token;this.clear();if(token)await this.request('POST','/agent/logout',undefined,undefined,token);});}
  async translate(body:OutboundBody,identity:PsimIdentity,signal:AbortSignal):Promise<OutboundResponse>{
    const current=this.identity();if(!current||current.accountScope!==identity.accountScope||current.authGeneration!==identity.authGeneration)throw fail('AUTH_CHANGED');
    if(body.purpose!=='outbound'||body.source_lang!=='zh'||typeof body.text!=='string'||!body.text.trim()||body.text.length>20000||!/^[-a-z0-9]{1,100}$/.test(body.draft_request_id)||typeof body.composer_content_version!=='string'||body.composer_content_version.length>25000||!['zh','en','ja','ko','es','fr','de','ru','pt','it','ar','th','vi','id','ms','zh-TW'].includes(body.target_lang))throw fail('INVALID_OUTBOUND_REQUEST');
    const result=await this.request('POST','/agent/translate',body,signal);if(signal.aborted||this.identity()?.authGeneration!==identity.authGeneration)throw fail('AUTH_CHANGED');const data=result?.data;
    if(result?.success!==true||typeof data?.translated_text!=='string'||!data.translated_text.trim()||data.translated_text.length>50000||data.draft_request_id!==body.draft_request_id||data.composer_content_version!==body.composer_content_version)throw fail('OUTBOUND_ECHO_MISMATCH');
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
  dispose(){this.closed=true;this.clear();}
}
