import {appendFileSync,existsSync,mkdirSync,renameSync,rmSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
type RecordValue=Record<string,unknown>;
const DEFAULT_MAX_BYTES=512*1024;
const RECONNECT_STAGES=new Set(['start','target-found','page-verified','native-ready','panel-mounted','complete']);
const CDP_METHODS=new Set(['Target.getTargets','Target.attachToTarget','Target.detachFromTarget','Target.getTargetInfo','Page.enable','Page.getFrameTree','Page.getResourceContent','Page.createIsolatedWorld','Runtime.enable','Runtime.addBinding','Runtime.removeBinding','Runtime.evaluate','Runtime.callFunctionOn','Runtime.releaseObject','Runtime.releaseObjectGroup','Debugger.enable','Debugger.disable','Debugger.getScriptSource','DOMDebugger.getEventListeners','DOM.describeNode']);
const code=(value:unknown)=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(value)?value:'UNCLASSIFIED';
const number=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;
/** Local diagnostics intentionally contain no text, translated output, identifiers, credentials or upstream errors. */
export function createRuntimeDiagnostics(file:string,maxBytes=DEFAULT_MAX_BYTES){
  const limit=Number.isSafeInteger(maxBytes)&&maxBytes>0?maxBytes:DEFAULT_MAX_BYTES;
  const removeOversizedFiles=()=>{
    for(const path of [file,file+'.1'])if(existsSync(path)&&statSync(path).size>limit)rmSync(path,{force:true});
  };
  try{removeOversizedFiles();}catch{/* Existing diagnostics must not interrupt startup. */}
  let lastState='';
  const write=(event:string,fields:RecordValue)=>{
    try{
      const entry=JSON.stringify({at:new Date().toISOString(),event,...fields})+'\n';
      const bytes=Buffer.byteLength(entry,'utf8');
      if(bytes>limit)return;
      mkdirSync(dirname(file),{recursive:true});
      removeOversizedFiles();
      if(existsSync(file)&&statSync(file).size+bytes>limit){rmSync(file+'.1',{force:true});renameSync(file,file+'.1');}
      appendFileSync(file,entry,{encoding:'utf8',mode:0o600});
    }catch{/* Observability must not interrupt the client or expose diagnostic exceptions. */}
  };
  function state(value:RecordValue){
    const fields:RecordValue={};
    for(const key of ['attached','hasPreview','hasError'])if(typeof value[key]==='boolean')fields[key]=value[key];
    for(const key of ['auth','phase','composerSource','nativeStatus','orderStatus'])if(typeof value[key]==='string'&&/^[a-z][a-z0-9_-]{0,48}$/.test(value[key] as string))fields[key]=value[key];
    const signature=JSON.stringify(fields);if(signature===lastState)return;lastState=signature;write('state',fields);
  }
  function consoleLog(args:unknown[]){
    if(args.length!==1||typeof args[0]!=='string'||args[0].length>12000)return;
    let value:RecordValue;try{value=JSON.parse(args[0]);}catch{return;}if(!value||typeof value!=='object'||Array.isArray(value))return;
    if(value.event==='composer-startup'&&typeof value.stage==='string'&&/^[a-z-]{1,40}$/.test(value.stage))write('composer-startup',{stage:value.stage,elapsedMs:number(value.elapsedMs)});
    else if(value.event==='order-discovery'&&['ORDER_READY','ORDER_UNAVAILABLE','ORDER_INSPECTION_FAILED'].includes(String(value.code)))write('order-discovery',{code:value.code,count:number(value.count)});
    else if(value.event==='composer-reconnect'&&typeof value.stage==='string'&&RECONNECT_STAGES.has(value.stage))write('composer-reconnect',{stage:value.stage,elapsedMs:number(value.elapsedMs)});
    else if(value.event==='runtime-waiting-visible')write('runtime-waiting-visible',{});
    else if(value.event==='runtime-invalidated')write('runtime-invalidated',{code:code(value.reason)});
    else if(value.event==='cdp-command-rejected'&&typeof value.method==='string'&&CDP_METHODS.has(value.method))write('cdp-command-rejected',{method:value.method,...(Number.isSafeInteger(value.errorCode)?{errorCode:value.errorCode}:{})});
    else if(value.event==='companion-service-failed')write('companion-service-failed',{code:code(value.code),errorType:typeof value.errorType==='string'&&/^[A-Za-z]{1,40}$/.test(value.errorType)?value.errorType:'Unknown',locations:Array.isArray(value.locations)?value.locations.filter(item=>typeof item==='string'&&/^[\w.-]+\.(?:c?js|ts):\d+:\d+$/.test(item)).slice(0,4):[]});
    else if((value.event==='cdp-command-timeout'||value.event==='cdp-slow-command')&&typeof value.method==='string'&&/^[A-Za-z]+\.[A-Za-z]+$/.test(value.method))write(value.event,{method:value.method,elapsedMs:number(value.elapsedMs),timeoutMs:number(value.timeoutMs)});
  }
  function consoleError(args:unknown[]){if(typeof args[0]==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(args[0]))write('host-error',{stage:args[0],code:code(args[1])});}
  return{state,consoleLog,consoleError,lifecycle:(stage:'start'|'ready'|'quit',pid:number,ownerPid?:number)=>write('host-'+stage,{pid:number(pid),ownerPid:number(ownerPid)})};
}
