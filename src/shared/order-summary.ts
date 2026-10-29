/**
 * Read-only plan snapshot for the order card under the vendor's 用户信息. The host projects it from allowlisted
 * TSim fields (`electron/order-summary-query.ts`); raw envelopes, IMSI/MSISDN and install credentials never reach
 * the page. ICCID and the business serial (`topup_id`) are shown on request of the support team. The page re-validates the shape before rendering it as text.
 */
export const ORDER_SUMMARY_PLAN_LIMIT=5;
export const ORDER_SUMMARY_CDR_LIMIT=10;
export type OrderSummaryTone='ok'|'warn'|'bad'|'muted';
export type OrderRemainingTone='ok'|'warn'|'over';
export interface OrderSummaryStatus {code:string;label:string;tone:OrderSummaryTone}
/** Remaining quota of the whole plan (`total`) or of today's daily allowance (`daily`). */
export interface OrderSummaryRemaining {text:string;quota:string;scope:'total'|'daily';percent:number;tone:OrderRemainingTone}
export interface OrderSummaryCdr {time:string|null;region:string|null;operator:string|null;usage:string|null}
/** `null` means the server did not return the field. */
export interface OrderSummaryPlan {
  serialNumber:string|null;iccid:string|null;
  supplier:string|null;apn:string|null;channelPlanName:string|null;sourcePlanName:string|null;
  status:OrderSummaryStatus|null;totalUsage:string|null;todayUsage:string|null;
  remaining:OrderSummaryRemaining|null;unlimited:boolean;
  esimStatus:string|null;eid:string|null;deviceModel:string|null;cdrs:OrderSummaryCdr[];
}
export interface OrderSummary {identifier:string;plans:OrderSummaryPlan[];total:number}
export type OrderSummaryFailure='login'|'permission'|'rate_limited'|'context'|'unavailable';
export type OrderSummaryResult=
  |{status:'ready';summary:OrderSummary;fetchedAt:number}
  |{status:'empty';identifier:string}
  |{status:'failed';identifier:string;reason:OrderSummaryFailure};
/** Page intent: the order shown for the visible conversation. `refresh` skips the host's short cache. */
export interface OrderSummaryIntent {identifier:string;conversationKey:string;refresh:boolean}

const IDENTIFIER=/^[A-Za-z0-9_-]{1,100}$/;
const keys=(...names:string[])=>names.sort().join(',');
const exact=(value:unknown,expected:string):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===expected;
const PLAN_KEYS=keys('serialNumber','iccid','supplier','apn','channelPlanName','sourcePlanName','status','totalUsage','todayUsage','remaining','unlimited','esimStatus','eid','deviceModel','cdrs');
const CDR_KEYS=keys('time','region','operator','usage');
const STATUS_KEYS=keys('code','label','tone');
const REMAINING_KEYS=keys('text','quota','scope','percent','tone');
const FAILURES:readonly OrderSummaryFailure[]=['login','permission','rate_limited','context','unavailable'];

export function isOrderSummaryIntent(value:unknown):value is OrderSummaryIntent {
  return exact(value,keys('identifier','conversationKey','refresh'))&&typeof value.identifier==='string'&&IDENTIFIER.test(value.identifier)&&typeof value.conversationKey==='string'&&value.conversationKey.length>0&&value.conversationKey.length<=2048&&typeof value.refresh==='boolean';
}
/** Display text only: bounded, single-line, no control characters. */
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const optional=(value:unknown,max:number)=>value===null||text(value,max);
function validStatus(value:unknown){return value===null||exact(value,STATUS_KEYS)&&text(value.code,40)&&text(value.label,20)&&['ok','warn','bad','muted'].includes(String(value.tone));}
function validRemaining(value:unknown){return value===null||exact(value,REMAINING_KEYS)&&text(value.text,24)&&text(value.quota,24)&&(value.scope==='total'||value.scope==='daily')&&Number.isInteger(value.percent)&&(value.percent as number)>=0&&(value.percent as number)<=100&&['ok','warn','over'].includes(String(value.tone));}
function validCdr(value:unknown){return exact(value,CDR_KEYS)&&optional(value.time,16)&&optional(value.region,40)&&optional(value.operator,40)&&optional(value.usage,24);}
function validPlan(value:unknown){
  return exact(value,PLAN_KEYS)&&optional(value.serialNumber,64)&&(value.iccid===null||text(value.iccid,24)&&/^[0-9A-Fa-f]{18,22}$/.test(value.iccid))&&optional(value.supplier,120)&&optional(value.apn,100)&&optional(value.channelPlanName,200)&&optional(value.sourcePlanName,200)&&validStatus(value.status)&&optional(value.totalUsage,24)&&optional(value.todayUsage,24)&&validRemaining(value.remaining)&&typeof value.unlimited==='boolean'&&optional(value.esimStatus,32)&&optional(value.eid,64)&&optional(value.deviceModel,80)&&Array.isArray(value.cdrs)&&value.cdrs.length<=ORDER_SUMMARY_CDR_LIMIT&&value.cdrs.every(validCdr);
}
/** The page accepts only the projected shape; anything else renders as an unavailable result. */
export function parseOrderSummaryResult(value:unknown):OrderSummaryResult|null {
  if(exact(value,keys('status','identifier','reason')))return value.status==='failed'&&typeof value.identifier==='string'&&IDENTIFIER.test(value.identifier)&&FAILURES.includes(value.reason as OrderSummaryFailure)?value as OrderSummaryResult:null;
  if(exact(value,keys('status','identifier')))return value.status==='empty'&&typeof value.identifier==='string'&&IDENTIFIER.test(value.identifier)?value as OrderSummaryResult:null;
  if(!exact(value,keys('status','summary','fetchedAt'))||value.status!=='ready'||typeof value.fetchedAt!=='number'||!Number.isFinite(value.fetchedAt))return null;
  const summary=value.summary;
  if(!exact(summary,keys('identifier','plans','total'))||typeof summary.identifier!=='string'||!IDENTIFIER.test(summary.identifier)||!Number.isInteger(summary.total)||!Array.isArray(summary.plans)||!summary.plans.length||summary.plans.length>ORDER_SUMMARY_PLAN_LIMIT||(summary.total as number)<summary.plans.length||(summary.total as number)>100||!summary.plans.every(validPlan))return null;
  return value as OrderSummaryResult;
}
