import {appendFileSync,existsSync,mkdirSync,readFileSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {safeCode} from '../host-node/diagnostics';
import {sanitizeTelemetry} from '../src/shared/runtime-telemetry';
type RecordValue=Record<string,unknown>;
export type RuntimeLogEntry={at:string;event:string}&RecordValue;
export const RUNTIME_LOG_LIMIT=1000;
const FILE_LINE_LIMIT=RUNTIME_LOG_LIMIT/2;
const DEFAULT_MAX_BYTES=512*1024;
const RECONNECT_STAGES=new Set(['start','target-found','page-verified','native-ready','panel-mounted','complete']);
const CDP_METHODS=new Set(['Target.getTargets','Target.attachToTarget','Target.detachFromTarget','Target.getTargetInfo','Page.enable','Page.getFrameTree','Page.getResourceContent','Page.createIsolatedWorld','Runtime.enable','Runtime.addBinding','Runtime.removeBinding','Runtime.evaluate','Runtime.callFunctionOn','Runtime.releaseObject','Runtime.releaseObjectGroup','Debugger.enable','Debugger.disable','Debugger.getScriptSource','DOMDebugger.getEventListeners','DOM.describeNode']);
const code=safeCode;
const number=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;
/** Local diagnostics intentionally contain no text, translated output, identifiers, credentials or upstream errors. */
export function createRuntimeDiagnostics(file:string,maxBytes=DEFAULT_MAX_BYTES,onEntry?:(entry:RuntimeLogEntry)=>void){
  const limit=Number.isSafeInteger(maxBytes)&&maxBytes>0?maxBytes:DEFAULT_MAX_BYTES;
  const entries:RuntimeLogEntry[]=[];
  let evicted=0,windowStarted=performance.now();
  let totals={requests:0,successCount:0,failureCount:0,timeoutCount:0,rateLimitedCount:0,cancelledCount:0,supersededCount:0};
  const httpSamples:number[]=[],userSamples:number[]=[];
  let fileLines=0;
  const removeOversizedFiles=()=>{
    for(const path of [file,file+'.1'])if(existsSync(path)&&statSync(path).size>limit)rmSync(path,{force:true});
  };
  try{
    removeOversizedFiles();
    // Two bounded generations, including files from older unlimited-line builds.
    for(const path of [file,file+'.1'])if(existsSync(path)){
      const lines=readFileSync(path,'utf8').split('\n').filter(Boolean).slice(-FILE_LINE_LIMIT);
      writeFileSync(path,lines.length?lines.join('\n')+'\n':'',{encoding:'utf8',mode:0o600});
      if(path===file)fileLines=lines.length;
    }
  }catch{/* Existing diagnostics must not interrupt startup. */}
  let lastState='';
  const write=(event:string,fields:RecordValue)=>{
    const record:RuntimeLogEntry={at:new Date().toISOString(),event,...fields};
    // Keep observability usable even when the disk is full or read-only.
    entries.push(record);if(entries.length>RUNTIME_LOG_LIMIT){const excess=entries.length-RUNTIME_LOG_LIMIT;evicted+=excess;entries.splice(0,excess);}
    try{onEntry?.(structuredClone(record));}catch{/* The progress channel is best effort. */}
    try{
      const entry=JSON.stringify(record)+'\n';
      const bytes=Buffer.byteLength(entry,'utf8');
      if(bytes>limit)return;
      mkdirSync(dirname(file),{recursive:true});
      removeOversizedFiles();
      if(!existsSync(file))fileLines=0;
      if(existsSync(file)&&(fileLines>=FILE_LINE_LIMIT||statSync(file).size+bytes>limit)){rmSync(file+'.1',{force:true});renameSync(file,file+'.1');fileLines=0;}
      appendFileSync(file,entry,{encoding:'utf8',mode:0o600});
      fileLines++;
    }catch{/* Observability must not interrupt the client or expose diagnostic exceptions. */}
  };
  const telemetry=(value:unknown)=>{
    const safe=sanitizeTelemetry(value);if(!safe)return;
    const {event,...fields}=safe;write(String(event),fields);
    if(event==='translation-summary'&&safe.translationSent===true){
      totals.requests++;const outcome=safe.outcome;
      if(outcome==='shown'||outcome==='success')totals.successCount++;
      else if(outcome==='cancelled')totals.cancelledCount++;
      else if(outcome==='superseded')totals.supersededCount++;
      else if(outcome==='rate-limited')totals.rateLimitedCount++;
      else totals.failureCount++;
      if(safe.reason==='timeout')totals.timeoutCount++;
      for(const [key,samples] of [['httpMs',httpSamples],['userWaitMs',userSamples]] as const){const ms=safe[key];if(typeof ms==='number'){samples.push(ms);if(samples.length>256)samples.shift();}}
    }
  };
  const statistics=(force=false)=>{
    const now=performance.now();if(!force&&now-windowStarted<300000||totals.requests===0)return;
    const percentile=(samples:number[],fraction:number)=>{const sorted=[...samples].sort((a,b)=>a-b);return sorted.length?sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)]:undefined;};
    telemetry({event:'translation-statistics',windowMs:now-windowStarted,...totals,
      httpP50Ms:percentile(httpSamples,.5),httpP95Ms:percentile(httpSamples,.95),httpMaxMs:percentile(httpSamples,1),
      userP50Ms:percentile(userSamples,.5),userP95Ms:percentile(userSamples,.95),userMaxMs:percentile(userSamples,1),
      httpSampleCount:httpSamples.length,userSampleCount:userSamples.length});
    windowStarted=now;totals={requests:0,successCount:0,failureCount:0,timeoutCount:0,rateLimitedCount:0,cancelledCount:0,supersededCount:0};httpSamples.length=userSamples.length=0;
  };
  function state(value:RecordValue){
    const fields:RecordValue={};
    for(const key of ['attached','hasPreview','hasError'])if(typeof value[key]==='boolean')fields[key]=value[key];
    const allowed:Record<string,string[]>={auth:['ready','connecting','needs_login','failed'],phase:['idle','reading','translating','waiting','ready','stale','replacing','failed'],composerSource:['unavailable','verified-editor','uia'],nativeStatus:['starting','available','helper_not_built','helper_diagnostic','helper_unavailable','helper_stopped','target_lost','windows_required'],orderStatus:['idle','loading','ready','empty','failed']};
    for(const [key,values] of Object.entries(allowed))if(values.includes(value[key] as string))fields[key]=value[key];
    const signature=JSON.stringify(fields);if(signature===lastState)return;lastState=signature;write('state',fields);
  }
  function consoleLog(args:unknown[]){
    if(args.length!==1||typeof args[0]!=='string'||args[0].length>12000)return;
    let value:RecordValue;try{value=JSON.parse(args[0]);}catch{return;}if(!value||typeof value!=='object'||Array.isArray(value))return;
    if(sanitizeTelemetry(value)){telemetry(value);return;}
    if(value.event==='composer-startup'&&typeof value.stage==='string'&&['start','files-verified','transport-ready','target-found','page-verified','native-ready','panel-mounted','failed'].includes(value.stage))write('composer-startup',{stage:value.stage,elapsedMs:number(value.elapsedMs)});
    else if(value.event==='order-discovery'&&['ORDER_READY','ORDER_UNAVAILABLE','ORDER_INSPECTION_FAILED'].includes(String(value.code)))write('order-discovery',{code:value.code,count:number(value.count)});
    else if(value.event==='composer-reconnect'&&typeof value.stage==='string'&&RECONNECT_STAGES.has(value.stage))write('composer-reconnect',{stage:value.stage,elapsedMs:number(value.elapsedMs)});
    else if(value.event==='runtime-waiting-visible')write('runtime-waiting-visible',{});
    else if(value.event==='composer-waiting-target')write('composer-waiting-target',{});
    else if(value.event==='runtime-invalidated')write('runtime-invalidated',{code:code(value.reason)});
    else if(value.event==='cdp-command-rejected'&&typeof value.method==='string'&&CDP_METHODS.has(value.method))write('cdp-command-rejected',{method:value.method,...(Number.isSafeInteger(value.errorCode)?{errorCode:value.errorCode}:{})});
    else if(value.event==='companion-service-failed')write('companion-service-failed',{code:code(value.code),errorType:['Error','TypeError','RangeError','SyntaxError','AbortError'].includes(String(value.errorType))?value.errorType:'Unknown',locations:Array.isArray(value.locations)?value.locations.filter(item=>typeof item==='string'&&/^(?:main\.cjs|external-composer\.ts|companion-service\.ts|driver\.ts|transport\.ts):\d{1,8}:\d{1,8}$/.test(item)).slice(0,4):[]});
    else if((value.event==='cdp-command-timeout'||value.event==='cdp-slow-command')&&typeof value.method==='string'&&CDP_METHODS.has(value.method))write(value.event,{method:value.method,elapsedMs:number(value.elapsedMs),timeoutMs:number(value.timeoutMs)});
  }
  function consoleError(args:unknown[]){if(typeof args[0]==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(args[0]))write('host-error',{stage:code(args[0]),code:code(args[1]??args[0])});}
  return{state,consoleLog,consoleError,telemetry,statistics,health:(fields:RecordValue)=>{telemetry({event:'runtime-health',...fields,logRetained:entries.length,logEvicted:evicted});statistics();},snapshot:()=>structuredClone(entries),lifecycle:(stage:'start'|'ready'|'quit',pid:number,ownerPid?:number)=>{if(stage==='quit')statistics(true);write('host-'+stage,{pid:number(pid),ownerPid:number(ownerPid)});}};
}
