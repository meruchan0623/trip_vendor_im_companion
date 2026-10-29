import {ORDER_SUMMARY_CDR_LIMIT,ORDER_SUMMARY_PLAN_LIMIT,type OrderSummary,type OrderSummaryCdr,type OrderSummaryPlan,type OrderSummaryRemaining,type OrderSummaryStatus,type OrderSummaryTone} from '../src/shared/order-summary';

/**
 * Session-bound reads of the allowlisted package-query routes. Each session implementation supplies its own
 * bearer, size limits and stable error codes; this module never sees the token.
 */
export interface OrderSummaryTransport {
  get(path:string):Promise<unknown>;
  post(path:string,body:{order_nums:string}):Promise<unknown>;
}
type Row=Record<string,unknown>;
const record=(value:unknown):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=(code:string)=>new Error(code);
/** Errors that void the whole snapshot; any other failure of an optional section only hides that section. */
const FATAL=new Set(['AUTH_CHANGED','REQUEST_ABORTED','PSIM_LOGIN_REQUIRED','PSIM_HTTP_401','PSIM_HTTP_423','BROWSER_SESSION_DISABLED','OWNED_SERVICE_CLOSED']);
const SAFE_ID=/^[-A-Za-z0-9_]{1,128}$/;
function safeId(value:unknown):string{
  const text=typeof value==='string'?value:typeof value==='number'&&Number.isSafeInteger(value)?String(value):'';
  if(!SAFE_ID.test(text))throw fail('ORDER_RESPONSE_INVALID');return text;
}
const HIDDEN=/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
/**
 * Server text as one bounded display line: control/bidi characters removed, placeholders such as `-` dropped.
 * The bounds sit well above real values; an oversized value is cut without an ellipsis, which the card never shows.
 */
export function displayText(value:unknown,max:number):string|null{
  const raw=typeof value==='string'?value:typeof value==='number'&&Number.isFinite(value)?String(value):null;
  if(raw===null)return null;
  const clean=raw.replace(HIDDEN,' ').replace(/\s+/g,' ').trim();
  if(!clean||/^[-–—/]+$/.test(clean)||/^(?:null|undefined|none|n\/a)$/i.test(clean))return null;
  if(clean.length<=max)return clean;
  let cut=max;if(/[\ud800-\udbff]/.test(clean[cut-1]))cut--;
  return clean.slice(0,cut);
}
const first=(max:number,...values:unknown[])=>{for(const value of values){const text=displayText(value,max);if(text!==null)return text;}return null;};
const truthy=(value:unknown)=>value===true||value===1||value==='1'||value==='true';

// Quota rules follow the TSim operator panel (agent-frontend usage-region-summary-model.ts) so both show the same remainder.
/** `18452.48 MB`, `3 GB`, `20.00(KB)` or a plain MB number → MB. */
export function parseAmountMb(value:unknown):number|null{
  if(typeof value==='number')return Number.isFinite(value)&&value>=0?value:null;
  if(typeof value!=='string')return null;
  const match=/^\s*(\d+(?:\.\d+)?)\s*(?:\(?\s*(KB|MB|GB|TB)\s*\)?)?\s*$/i.exec(value);
  if(!match)return null;
  const factor={KB:1/1024,MB:1,GB:1024,TB:1024*1024}[(match[2]||'MB').toUpperCase() as 'KB'|'MB'|'GB'|'TB'];
  return Number(match[1])*factor;
}
export const formatMb=(mb:number)=>mb>=1024?`${Number((mb/1024).toFixed(2))} GB`:`${Number(mb.toFixed(2))} MB`;
const UNLIMITED=/无限|無限|unlimited|不限量/i;
const DAILY_AMOUNT=/(?:每日|每天|daily|per\s*day)\s*(\d+(?:\.\d+)?)\s*(GB|MB)\b|(\d+(?:\.\d+)?)\s*(GB|MB)\s*\/\s*(?:天|日|day\b)/gi;
const DAILY_MARK=/每日|每天|daily|per\s*day|(GB|MB)\s*\/\s*(?:天|日|day\b)/i;
const AMOUNT=/(\d+(?:\.\d+)?)\s*(GB|MB)\b/gi;
const toMb=(amount:string,unit:string)=>Number(amount)*(unit.toUpperCase()==='GB'?1024:1);
/** The single explicit quota in a spec/plan name; daily plans only accept daily amounts. Unlimited or ambiguous → null. */
export function quotaFromPlanName(name:unknown,daily:boolean):number|null{
  if(typeof name!=='string'||!displayText(name,1000)||UNLIMITED.test(name))return null;
  const values=new Set<number>();
  if(daily){for(const match of name.matchAll(DAILY_AMOUNT))values.add(match[1]?toMb(match[1],match[2]):toMb(match[3],match[4]));}
  else{
    if(DAILY_MARK.test(name))return null;
    for(const match of name.matchAll(AMOUNT))values.add(toMb(match[1],match[2]));
  }
  return values.size===1?[...values][0]:null;
}
export function resolveUsageQuota(detail:Row,live:Row,daily:boolean):{quotaMb:number;scope:'total'|'daily'}|null{
  if(!daily){
    const volume=parseAmountMb(live.volume);
    if(volume&&volume>0)return{quotaMb:volume,scope:'total'};
    const totalData=typeof detail.total_data==='string'&&/[a-z]/i.test(detail.total_data)?parseAmountMb(detail.total_data):null;
    if(totalData&&totalData>0)return{quotaMb:totalData,scope:'total'};
  }
  const scope=daily?'daily':'total';
  const specQuota=quotaFromPlanName(live.spec_name||detail.spec_name,daily);
  if(specQuota)return{quotaMb:specQuota,scope};
  // The channel and source names must agree on one amount.
  const parsed=new Set([detail.dataplan_name,detail.channel_dataplan_name].map(name=>quotaFromPlanName(name,daily)).filter((value):value is number=>value!==null));
  return parsed.size===1?{quotaMb:[...parsed][0],scope}:null;
}
function remainingOf(quota:{quotaMb:number;scope:'total'|'daily'}|null,usedMb:number|null):OrderSummaryRemaining|null{
  if(!quota||usedMb===null)return null;
  const remaining=Math.max(quota.quotaMb-usedMb,0),ratio=remaining/quota.quotaMb;
  return{text:formatMb(remaining),quota:formatMb(quota.quotaMb),scope:quota.scope,percent:Math.max(0,Math.min(100,Math.round(ratio*100))),tone:ratio<=0?'over':ratio<=0.2?'warn':'ok'};
}

const STATUS:Record<string,[string,OrderSummaryTone]>={
  using:['使用中','ok'],activated:['使用中','ok'],active:['使用中','ok'],
  inactive:['未激活','warn'],not_activated:['未激活','warn'],
  pending:['待处理','warn'],default:['待处理','warn'],
  cancel:['已取消','muted'],cancelled:['已取消','muted'],expired:['已过期','muted'],
  terminated:['已终止','bad'],success:['成功','ok'],fail:['失败','bad'],failed:['失败','bad'],
  refundreview:['退款审核中','warn'],refund:['已退款','muted'],
};
export function projectStatus(raw:unknown,operate:Row|null):OrderSummaryStatus|null{
  const code=displayText(raw,40);if(!code)return null;
  const key=code.toLowerCase();
  // An inactive plan whose supplier reports neither CDRs nor activation callbacks cannot change on its own.
  if((key==='inactive'||key==='not_activated')&&operate&&Number(operate.allow_cdr)!==1&&Number(operate.allow_activation_callback)!==1)return{code,label:'不支持自动同步',tone:'muted'};
  const known=STATUS[key];
  return known?{code,label:known[0],tone:known[1]}:{code,label:displayText(code,20)!,tone:'muted'};
}
/** The English status code only, e.g. `Disabled` from `Disabled` or `已禁用(Disabled)`. */
export function esimCode(value:unknown):string|null{
  const text=displayText(value,200);if(!text)return null;
  const match=/[A-Za-z][A-Za-z0-9_-]*(?: [A-Za-z][A-Za-z0-9_-]*)*/.exec(text);
  return match?displayText(match[0],32):null;
}

const SHANGHAI=/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/;
/** `update_time` in epoch seconds, bounded so it always converts to a valid date. */
function epochSeconds(value:unknown):number|null{
  const seconds=typeof value==='number'?value:typeof value==='string'&&/^\d{9,11}$/.test(value)?Number(value):NaN;
  return Number.isFinite(seconds)&&seconds>0&&seconds<1e11?seconds:null;
}
/** Milliseconds for newest-first ordering; rows without a usable time sort last. */
function cdrTime(row:Row):number{
  const seconds=epochSeconds(row.update_time);
  if(seconds!==null)return seconds*1000;
  const at=typeof row.update_datetime==='string'?SHANGHAI.exec(row.update_datetime):null;
  if(at){const parsed=Date.parse(`${at[1]}T${at[2].length===5?`${at[2]}:00`:at[2]}+08:00`);if(Number.isFinite(parsed))return parsed;}
  const day=typeof row.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row.date)?Date.parse(`${row.date}T00:00:00+08:00`):NaN;
  return Number.isFinite(day)?day:-Infinity;
}
/** `MM-DD HH:mm` in the server's Asia/Shanghai time, or the bare date when only `date` is returned. */
function cdrClock(row:Row):string|null{
  const at=typeof row.update_datetime==='string'?/^\d{4}-(\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(row.update_datetime):null;
  if(at)return `${at[1]} ${at[2]}`;
  const seconds=epochSeconds(row.update_time);
  if(seconds!==null){const local=new Date(seconds*1000+8*3600_000).toISOString();return `${local.slice(5,10)} ${local.slice(11,16)}`;}
  return typeof row.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row.date)?row.date:null;
}
/** Projects only time, place, operator and usage; ICCID/IMSI/MSISDN on the row are never read. */
export function projectCdr(row:Row):OrderSummaryCdr{
  const kb=typeof row.total_usage_kb==='number'||typeof row.total_usage_kb==='string'?parseAmountMb(String(row.total_usage_kb)):null;
  const mb=kb!==null?kb/1024:parseAmountMb(row.total_usage);
  return{
    time:cdrClock(row),
    region:first(40,row.country,row.region),
    operator:first(40,row.operator),
    usage:mb===null?null:formatMb(mb),
  };
}
export function latestCdrs(rows:unknown[]):OrderSummaryCdr[]{
  return rows.slice(0,500).filter(record).map((row,index)=>({row,index,at:cdrTime(row)}))
    .sort((a,b)=>b.at-a.at||a.index-b.index).slice(0,ORDER_SUMMARY_CDR_LIMIT).map(({row})=>projectCdr(row));
}

/** One plan of the order, from its detail (required), live detail and CDR list (both optional). */
export function projectOrderPlan({detail,live,cdrs}:{detail:Row;live:Row|null;cdrs:unknown[]}):OrderSummaryPlan{
  const current=live??{};
  const operate=record(detail.operate)?detail.operate:null;
  const daily=truthy(detail.is_daily)||truthy(current.is_daily);
  const original=record(current.original_data)?current.original_data:{};
  const totalMb=parseAmountMb(original.data_usage)??parseAmountMb(current.data_usage)??parseAmountMb(detail.data_usage);
  // `can_check_daily_usage: 0` means the supplier has no per-day figure; a returned 0 would read as "no usage".
  const todayMb=current.can_check_daily_usage!==undefined&&!truthy(current.can_check_daily_usage)?null:parseAmountMb(current.today_usage)??parseAmountMb(detail.today_usage);
  const quota=resolveUsageQuota(detail,current,daily);
  const spec=current.spec_name||detail.spec_name;
  const iccid=first(24,detail.iccid);
  return{
    // 业务流水号 is the plan's EICCID, as the operator panel labels it.
    serialNumber:first(64,detail.eiccid,current.eiccid),
    iccid:iccid&&/^[0-9A-Fa-f]{18,22}$/.test(iccid)?iccid:null,
    supplier:first(120,detail.supplier_name),
    apn:first(100,detail.apn,operate?.apn),
    channelPlanName:first(200,detail.channel_dataplan_name),
    sourcePlanName:first(200,detail.dataplan_name),
    status:projectStatus(first(40,current.package_status,detail.package_status,detail.status),operate),
    totalUsage:totalMb===null?null:formatMb(totalMb),
    todayUsage:todayMb===null?null:formatMb(todayMb),
    remaining:remainingOf(quota,daily?todayMb:totalMb),
    unlimited:!quota&&typeof spec==='string'&&UNLIMITED.test(spec),
    esimStatus:esimCode(current.esim_status)??esimCode(detail.esim_status),
    eid:first(64,current.esim_eid,detail.esim_eid,detail.eid),
    deviceModel:first(80,current.device_model,detail.device_model),
    cdrs:latestCdrs(cdrs),
  };
}

const optional=(request:Promise<unknown>)=>request.then(envelope=>record(envelope)&&envelope.code===1?envelope.result:null,(error:unknown)=>{
  if(error instanceof Error&&FATAL.has(error.message))throw error;
  return null;
});
const cdrRows=(result:unknown):unknown[]|null=>Array.isArray(result)?result:record(result)&&Array.isArray(result.list)?result.list:null;
/**
 * perform → dataplan-list → per plan (detail ∥ live-detail ∥ cdr-more). Plans run one after another so a
 * large order stays within the package-query rate limit; only the first ORDER_SUMMARY_PLAN_LIMIT are read.
 */
export async function collectOrderSummary(identifier:string,transport:OrderSummaryTransport):Promise<OrderSummary>{
  const started=await transport.post('/agent/package-query/perform',{order_nums:identifier});
  if(!record(started)||started.code!==1&&started.code!==2)throw fail('ORDER_QUERY_FAILED');
  const queryId=safeId(record(started.result)?started.result.query_id:undefined);
  const listed=await transport.get(`/agent/package-query/dataplan-list?${new URLSearchParams({query_id:queryId})}`);
  if(!record(listed)||listed.code!==1||!Array.isArray(listed.result)||listed.result.length>100)throw fail('ORDER_RESPONSE_INVALID');
  const plans:OrderSummaryPlan[]=[];
  for(const row of listed.result.slice(0,ORDER_SUMMARY_PLAN_LIMIT)){
    const card=new URLSearchParams({card_dataplan_id:safeId(record(row)?row.card_dataplan_id:undefined)});
    const [detail,live,more]=await Promise.all([
      transport.get(`/agent/package-query/detail?${card}`),
      optional(transport.get(`/agent/package-query/live-detail?${card}`)),
      optional(transport.get(`/agent/package-query/cdr-more?${card}`)),
    ]);
    if(!record(detail)||detail.code!==1||!record(detail.result))throw fail('ORDER_RESPONSE_INVALID');
    const fromMore=cdrRows(more),fromDetail=cdrRows(detail.result.cdr_list);
    plans.push(projectOrderPlan({detail:detail.result,live:record(live)?live:null,cdrs:fromMore?.length?fromMore:fromDetail??[]}));
  }
  return{identifier,plans,total:listed.result.length};
}
