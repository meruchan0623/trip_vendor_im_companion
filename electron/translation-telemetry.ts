import {AsyncLocalStorage} from 'node:async_hooks';
import {randomBytes,randomUUID} from 'node:crypto';
import {translationDiagnosticsFromResponse} from '../src/shared/translation-response-diagnostics';
import {sanitizeTelemetry} from '../src/shared/runtime-telemetry';
export interface TelemetryTrace {fields:Record<string,unknown>;started:number;finished:boolean;httpCompletedAt?:number}
const context=new AsyncLocalStorage<TelemetryTrace>();
export const TELEMETRY_RUN_ID=randomBytes(8).toString('hex');
function safeFields(fields:Record<string,unknown>){try{const descriptors=Object.getOwnPropertyDescriptors(fields);descriptors.event={value:'translation-summary',enumerable:true,configurable:true};const candidate=Object.create(null,descriptors);const safe=sanitizeTelemetry(candidate)!;delete safe.event;return safe;}catch{return {};}}
export function createTelemetry(operation:'translate'|'replace'|'send',fields:Record<string,unknown>={}):TelemetryTrace {
  return {fields:{...safeFields(fields),operation,operationStartedAt:new Date().toISOString(),traceId:randomUUID(),runId:TELEMETRY_RUN_ID,providerMs:null,serverMs:null,cacheSource:'unknown'},started:performance.now(),finished:false};
}
export function runWithTelemetry<T>(trace:TelemetryTrace,fn:()=>Promise<T>):Promise<T>{return context.run(trace,fn);}
export function currentTelemetry():TelemetryTrace|undefined{return context.getStore();}
export function setTelemetry(fields:Record<string,unknown>):void{const trace=currentTelemetry();if(trace&&!trace.finished)Object.assign(trace.fields,safeFields(fields));}
export function addTelemetry(field:string,value:number):void{const trace=currentTelemetry();if(!trace||trace.finished||!Number.isFinite(value)||value<0)return;const safe=safeFields({[field]:value});if(Object.hasOwn(safe,field))trace.fields[field]=(typeof trace.fields[field]==='number'?trace.fields[field] as number:0)+value;}
export async function timeTelemetry<T>(field:string,fn:()=>Promise<T>):Promise<T>{const started=performance.now();try{return await fn();}finally{addTelemetry(field,performance.now()-started);}}
export function finishTelemetry(trace:TelemetryTrace,outcome:string,fields:Record<string,unknown>={},completedAt?:number):void{
  if(trace.finished)return;trace.finished=true;
  const now=performance.now(),end=typeof completedAt==='number'&&Number.isFinite(completedAt)&&completedAt>=trace.started&&completedAt<=now?completedAt:now;
  const projected=safeFields(trace.fields);const value=sanitizeTelemetry({...projected,...safeFields(fields),event:projected.operation==='translate'?'translation-summary':'translation-action',outcome,elapsedMs:Math.max(0,end-trace.started)});
  if(value)try{console.log(JSON.stringify(value));}catch{/* diagnostics never affect business operations */}
}
/** Narrow HTTP observer: translate and profile/refresh only; no payload, URL, header or error text survives. */
export function startHttpTelemetry(path:string,timeoutMs:number,payload?:unknown){
  const trace=currentTelemetry(),auth=path==='/agent/profile'||path==='/agent/auth/refresh';
  if(!trace||trace.finished||!auth&&!['/agent/translate','/agent/translate/batch'].includes(path))return undefined;
  const started=performance.now();let phase='request',bodyAt=started,parseAt=started;
  const put=(fields:Record<string,unknown>)=>{if(trace.finished)return;Object.assign(trace.fields,safeFields(fields));};
  const add=(field:string,value:number)=>{if(trace.finished)return;const safe=safeFields({[field]:value});if(Object.hasOwn(safe,field))trace.fields[field]=(typeof trace.fields[field]==='number'?trace.fields[field] as number:0)+value;};
  if(auth)add('authHttpCount',1);else {put({timeoutMs,translationSent:true,httpMethod:'POST',httpRoute:path,requestStartedAt:new Date().toISOString()});if(typeof payload==='string')put({requestBytes:Buffer.byteLength(payload,'utf8')});}
  const duration=(name:string,value:number)=>auth?add(`auth${name[0].toUpperCase()}${name.slice(1)}`,value):put({[name]:value});
  return {
    headers(response:Response){duration('headersMs',performance.now()-started);put({[auth?'authHttpStatus':'httpStatus']:response.status});if(!auth){put({responseHeadersAt:new Date().toISOString(),contentType:response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()==='application/json'?'application/json':'other'});const length=response.headers.get('content-length');if(length!==null&&/^\d+$/.test(length)){const number=Number(length);if(Number.isSafeInteger(number))put({contentLength:number});}const retry=response.headers.get('retry-after');if(retry!==null){let delta:number|undefined;if(/^\d+$/.test(retry))delta=Number(retry)*1000;else if(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry)){const date=Date.parse(retry);if(Number.isFinite(date))delta=Math.max(0,date-Date.now());}if(delta!==undefined&&Number.isFinite(delta))put({headerRetryAfterMs:delta});}const requestId=response.headers.get('x-request-id');if(requestId)put({serverRequestId:requestId});}phase='validation';},
    body(){phase='body';bodyAt=performance.now();},
    progress(bytes:number){if(!auth)put({responseBytes:bytes});},
    bodyDone(bytes:number){duration('bodyMs',performance.now()-bodyAt);if(!auth){trace.httpCompletedAt=performance.now();put({responseBytes:bytes,responseCompletedAt:new Date().toISOString()});}phase='validation';},
    parsing(){phase='parse';parseAt=performance.now();},
    parsed(result:unknown,parseStarted:number){
      duration('parseMs',performance.now()-parseStarted);phase='validation';
      if(auth)return;
      put(translationDiagnosticsFromResponse(result)??{});
      // JSON normally contains plain values; avoid invoking accessors even in a malformed observer input.
      try{const descriptor=result&&typeof result==='object'?Object.getOwnPropertyDescriptor(result,'data'):undefined;
        const data=descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;
        if(data&&typeof data==='object'&&!Array.isArray(data)){
          const descriptors=Object.getOwnPropertyDescriptors(data),read=(key:string)=>{const d=descriptors[key];return d&&Object.hasOwn(d,'value')?d.value:undefined;},retry=read('retry_after_seconds');
          put({providerReported:read('provider'),translationProfile:read('translation_profile'),policyVersion:read('translation_policy_version'),translationProtocol:read('translation_protocol'),providerRetryAfterMs:typeof retry==='number'&&Number.isFinite(retry)&&retry>=0?retry*1000:read('retry_after_ms'),retryable:read('retryable'),serverRequestId:read('request_id')});
        }
      }catch{/* an optional diagnostic projection never invalidates a response */}
    },
    failed(){if(phase==='body')duration('bodyMs',performance.now()-bodyAt);if(phase==='parse')duration('parseMs',performance.now()-parseAt);duration('failedElapsedMs',performance.now()-started);put({[auth?'authHttpFailurePhase':'httpFailurePhase']:phase});},
    done(){duration('httpMs',performance.now()-started);},
  };
}
