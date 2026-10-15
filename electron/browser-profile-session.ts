import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readTsimToken } from './chromium-tsim-storage';
import { WORKBENCH_TARGETS, type OutboundBody, type OutboundResponse, type PsimIdentity } from '../src/shared/workbench';

const API='https://csapi.tsim.tech';
export interface EmbeddedOrderResult {identifier:string;found:boolean;fields:{label:string;value:string}[]}
export interface BrowserProfile {browserPath:string;userDataDir:string;profileDirectory:string}
export interface BrowserProfileSessionOptions {
  enabled?:boolean;
  openExternal?:(url:string)=>Promise<void>;
  discoverProfiles?:()=>Promise<BrowserProfile[]>;
  readToken?:(storageDirectory:string)=>Promise<string|null>;
  fetcher?:typeof fetch;
  syncIntervalMs?:number;
  requestTimeoutMs?:number;
  backgroundPolling?:boolean;
}
const record=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value:object,allowed:string[])=>Object.keys(value).every(key=>allowed.includes(key));
const clone=(value:PsimIdentity|null)=>value&&({...value,permissions:[...value.permissions]});
const same=(a:PsimIdentity|null,b:PsimIdentity|null)=>JSON.stringify(a)===JSON.stringify(b);
const storage=(profile:BrowserProfile)=>join(profile.userDataDir,profile.profileDirectory,'Local Storage','leveldb');
const profileKey=(profile:BrowserProfile)=>JSON.stringify([profile.browserPath,profile.userDataDir,profile.profileDirectory]);
const exists=async(path:string)=>{try{await access(path);return true;}catch{return false;}};
/** Enumerates profile directories and database metadata only; never opens Cookies or Preferences. */
export async function discoverBrowserProfiles(env:NodeJS.ProcessEnv=process.env):Promise<BrowserProfile[]>{
  if(!env.LOCALAPPDATA)return [];
  const result:BrowserProfile[]=[];
  for(const browser of [{parts:['Microsoft','Edge'],exe:['Microsoft','Edge','Application','msedge.exe']},{parts:['Google','Chrome'],exe:['Google','Chrome','Application','chrome.exe']}]){
    let browserPath:string|undefined;
    for(const root of [env['ProgramFiles(x86)'],env.ProgramFiles,env.LOCALAPPDATA])if(root){const path=join(root,...browser.exe);if(await exists(path)){browserPath=path;break;}}
    if(!browserPath)continue;
    const userDataDir=join(env.LOCALAPPDATA,...browser.parts,'User Data');let directories;
    try{directories=await readdir(userDataDir,{withFileTypes:true});}catch{continue;}
    for(const directory of directories.filter(item=>item.isDirectory()&&/^(Default|Profile [1-9]\d*)$/.test(item.name)).sort((a,b)=>a.name==='Default'?-1:b.name==='Default'?1:a.name.localeCompare(b.name))){
      const profile={browserPath,userDataDir,profileDirectory:directory.name};if(await exists(join(storage(profile),'CURRENT')))result.push(profile);
    }
  }
  return result;
}
/** Reads only the allowlisted browser storage key. Secrets remain in this main-process object. */
export class BrowserProfileSessionService {
  private current:PsimIdentity|null=null;
  private token:string|null=null;
  private profile:BrowserProfile|null=null;
  private binding:BrowserProfile|null=null;
  private generation=0;
  private suspended=false;
  private closed=false;
  private syncing:Promise<void>|null=null;
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
  private publish(){try{this.changed(this.identity());}catch{/* subscriber cannot affect revocation */}}
  private revoke(){this.generation++;const hadIdentity=!!this.current;this.current=null;this.token=null;this.profile=null;for(const controller of this.active)controller.abort();this.active.clear();if(hadIdentity)this.publish();}
  private async tokenAt(profile:BrowserProfile):Promise<string|null>{
    const value=await (this.options.readToken??readTsimToken)(storage(profile));
    if(value===null)return null;
    if(typeof value!=='string'||!value.trim()||value.length>16000)throw new Error('BROWSER_SESSION_STORAGE_INVALID');
    return value;
  }
  private async request(path:string,body?:OutboundBody|{order_nums:string},signal?:AbortSignal):Promise<any>{
    const url=new URL(path,API);
    const readPath=url.pathname==='/agent/profile'&&!url.search||url.pathname==='/agent/package-query/dataplan-list'&&[...url.searchParams.keys()].join(',')==='query_id'||url.pathname==='/agent/package-query/detail'&&[...url.searchParams.keys()].join(',')==='card_dataplan_id';
    const postPath=['/agent/translate','/agent/package-query/perform'].includes(url.pathname)&&!url.search;
    if(url.origin!==API||url.hash||url.username||url.password||!(body?postPath:readPath))throw new Error('FORBIDDEN_SERVICE_REQUEST');
    const token=this.token,generation=this.generation;if(!token)throw new Error('PSIM_LOGIN_REQUIRED');
    const controller=new AbortController();this.active.add(controller);
    const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(this.options.requestTimeoutMs??20000),...(signal?[signal]:[])]);
    try{
      const response=await (this.options.fetcher??fetch)(`${API}${path}`,{method:body?'POST':'GET',headers:{Accept:'application/json',Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:combined});
      if(this.closed||this.suspended||generation!==this.generation||token!==this.token)throw new Error('AUTH_CHANGED');
      if(response.status===401||response.status===423){if(path==='/agent/translate')this.revoke();throw new Error('PSIM_LOGIN_REQUIRED');}
      if(response.status===403||response.status===422)throw new Error(path.startsWith('/agent/package-query/')?'ORDER_PERMISSION_REQUIRED':'TRANSLATION_PERMISSION_REQUIRED');
      if(response.status===429)throw new Error('RATE_LIMITED');
      if(!response.ok)throw new Error('SERVICE_UNAVAILABLE');
      if(Number(response.headers.get('content-length'))>200000)throw new Error('INVALID_SERVICE_RESPONSE');
      const reader=response.body?.getReader();if(!reader)throw new Error('INVALID_SERVICE_RESPONSE');
      let length=0;const chunks:Uint8Array[]=[];
      for(;;){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;if(length>200000){await reader.cancel();throw new Error('INVALID_SERVICE_RESPONSE');}chunks.push(next.value);}
      const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new Error('INVALID_SERVICE_RESPONSE');}
    }catch(error){
      if(signal?.aborted)throw new Error('REQUEST_ABORTED');
      if(this.closed||this.suspended||generation!==this.generation)throw new Error('AUTH_CHANGED');
      if(combined.aborted)throw new Error('BROWSER_SESSION_TIMEOUT');
      if(error instanceof Error&&/^[A-Z][A-Z0-9_]{1,80}$/.test(error.message))throw error;
      throw new Error('SERVICE_UNAVAILABLE');
    }finally{this.active.delete(controller);}
  }
  async sync():Promise<void>{
    if(this.options.enabled===false||this.closed||this.suspended)return;
    if(this.syncing)return this.syncing;
    this.syncing=this.synchronize().finally(()=>{this.syncing=null;});return this.syncing;
  }
  private async synchronize():Promise<void>{
    let expectedGeneration=this.generation;
    try{
      const profiles=await (this.options.discoverProfiles??discoverBrowserProfiles)();
      if(this.closed||this.suspended||expectedGeneration!==this.generation)return;
      // Only a successfully verified profile establishes a persistent binding.
      // A bound profile failing later must never cause an implicit account switch.
      const bound=this.binding,candidates=bound?profiles.filter(profile=>profileKey(profile)===profileKey(bound)):profiles;
      for(const selected of candidates){
        const token=await this.tokenAt(selected);
        if(this.closed||this.suspended||expectedGeneration!==this.generation)return;
        if(!token){if(bound){this.revoke();return;}continue;}
        if(token!==this.token||!this.profile||profileKey(selected)!==profileKey(this.profile)){
          this.revoke();this.token=token;this.profile={...selected};expectedGeneration=this.generation;
        }
        try{
          const response=await this.request('/agent/profile');
          if(this.closed||this.suspended||expectedGeneration!==this.generation)return;
          const data=response?.data;
          if(response?.success!==true||data?.is_active!==true||!/^[-A-Za-z0-9_]{1,128}$/.test(String(data?.id??''))||!Array.isArray(data.permissions)||data.permissions.length>200||!data.permissions.every((permission:unknown)=>typeof permission==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(permission)))throw new Error('PROFILE_UNVERIFIED');
          // A disk-side logout/rotation during profile validation cannot publish an old session.
          if(await this.tokenAt(selected)!==token){this.revoke();throw new Error('AUTH_CHANGED');}
          if(this.closed||this.suspended||expectedGeneration!==this.generation)return;
          const accountScope=`psim:${data.id}`,permissions=[...new Set<string>(data.permissions)].sort();
          if(this.current&&(this.current.accountScope!==accountScope||JSON.stringify(this.current.permissions)!==JSON.stringify(permissions))){this.revoke();this.token=token;this.profile={...selected};}
          this.binding={...selected};
          const next={accountScope,permissions,authGeneration:this.generation};if(!same(next,this.current)){this.current=next;this.publish();}
          return;
        }catch(error){
          if(!bound&&!this.closed&&!this.suspended&&expectedGeneration===this.generation&&error instanceof Error&&['PSIM_LOGIN_REQUIRED','PROFILE_UNVERIFIED'].includes(error.message)){
            this.revoke();expectedGeneration=this.generation;continue;
          }
          throw error;
        }
      }
      this.revoke();
    }catch(error){if(expectedGeneration===this.generation&&!this.closed&&!this.suspended)this.revoke();throw error;}
  }
  async translate(body:OutboundBody,expectedIdentity:PsimIdentity,signal:AbortSignal):Promise<OutboundResponse>{
    if(this.options.enabled===false)throw new Error('BROWSER_SESSION_DISABLED');
    if(!record(body)||!keys(body,['text','target_lang','source_lang','purpose','draft_request_id','composer_content_version'])||typeof body.text!=='string'||!body.text.trim()||body.text.length>20000||!WORKBENCH_TARGETS.includes(body.target_lang)||body.source_lang!=='zh'||body.purpose!=='outbound'||typeof body.draft_request_id!=='string'||!/^[-a-z0-9]{1,100}$/.test(body.draft_request_id)||typeof body.composer_content_version!=='string'||body.composer_content_version.length>25000)throw new Error('INVALID_OUTBOUND_REQUEST');
    if(signal.aborted)throw new Error('REQUEST_ABORTED');
    let abort!:()=>void;
    try{await Promise.race([this.sync(),new Promise<never>((_,reject)=>{abort=()=>reject(new Error('REQUEST_ABORTED'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener('abort',abort);}
    if(!this.current||!same(expectedIdentity,this.current)||!this.profile||!this.token)throw new Error('AUTH_CHANGED');
    const generation=this.generation,token=this.token,profile={...this.profile};
    const result=await this.request('/agent/translate',{...body},signal);
    let freshToken:string|null;
    try{freshToken=await this.tokenAt(profile);}catch{this.revoke();throw new Error('AUTH_CHANGED');}
    if(signal.aborted)throw new Error('REQUEST_ABORTED');
    if(freshToken!==token){this.revoke();throw new Error('AUTH_CHANGED');}
    if(generation!==this.generation||!same(expectedIdentity,this.current))throw new Error('AUTH_CHANGED');
    const data=result?.data;
    if(result?.success!==true||typeof data?.translated_text!=='string'||!data.translated_text.trim()||data.translated_text.length>50000||data.draft_request_id!==body.draft_request_id||data.composer_content_version!==body.composer_content_version)throw new Error('OUTBOUND_ECHO_MISMATCH');
    return {success:true,data:{translated_text:data.translated_text,draft_request_id:data.draft_request_id,composer_content_version:data.composer_content_version}};
  }
  async openLogin():Promise<void>{if(this.options.enabled===false)return;if(this.closed)throw new Error('BROWSER_SESSION_DISPOSED');this.suspended=false;this.updatePolling();if(!this.options.openExternal)throw new Error('BROWSER_LOGIN_OPENER_REQUIRED');await this.options.openExternal('https://csagent.tsim.tech/login');void this.sync().catch(()=>{});}
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
      let fresh:string|null;try{fresh=await this.tokenAt(profile);}catch{this.revoke();throw new Error('AUTH_CHANGED');}
      if(fresh!==token){this.revoke();throw new Error('AUTH_CHANGED');}
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
  async logout():Promise<void>{this.suspended=true;this.updatePolling();this.revoke();this.binding=null;}
  dispose(){if(this.closed)return;this.closed=true;this.updatePolling();this.revoke();this.binding=null;}
}
