import {join} from 'node:path';
import {homedir} from 'node:os';
import {FileTranslationOptionsStore} from '../electron/translation-options-store';
import { NativeAdapter, type WindowState } from '../electron/native-adapter';
import {ProfileBrowser,profileOrderWindow} from '../electron/profile-browser';
import { CompanionService } from '../electron/companion-service';
import { ResidentConnection } from '../electron/resident-connection';
import { startExternalClient } from '../electron/external-composer';
import { attachProtocol, parseHostAction, ParentNativeTransport, stateProjection, MAX_LINE_BYTES, type HostAction } from './protocol';
import { safeDiagnostic } from './diagnostics';
import { getHeapStatistics } from 'node:v8';

// Existing driver diagnostics must never enter the private RPC stream.
console.log=(...args:unknown[])=>{const line=safeDiagnostic(args);if(line)process.stderr.write(line+'\n');};
let quitting=false,service:CompanionService|undefined,resident:ResidentConnection|undefined;
let latest:WindowState|null=null,lastState='';
let orderBrowser:ProfileBrowser|undefined;
const send=(value:unknown)=>{
  if(process.stdout.destroyed)return;
  const line=JSON.stringify(value)+'\n';
  if(Buffer.byteLength(line)>MAX_LINE_BYTES||process.stdout.writableLength>MAX_LINE_BYTES*4){void shutdown();return;}
  process.stdout.write(line);
};
const emit=(type:string,payload:unknown,requestId?:string)=>send({protocolVersion:'1.0',type,...(requestId?{requestId}:{}),payload});
const transport=new ParentNativeTransport(send);
const native=new NativeAdapter('',state=>{
  if(quitting)return;
  resident?.setBound(!!state);const previous=latest;latest=state;
  const changed=previous?.targetInstanceId!==state?.targetInstanceId;
  if(changed||previous?.visible!==state?.visible||previous?.minimized!==state?.minimized||previous?.foreground!==state?.foreground||previous?.groupForeground!==state?.groupForeground)service?.setWindowState(state);
  if(changed&&state)void service?.connectComposer().catch(()=>{});
},status=>service?.setNativeStatus(status),()=>{orderBrowser?.handleLost();void service?.closeOrder();},measurement=>{if(measurement.closed&&orderBrowser?.ownsGeometry(measurement.launchId))void service?.closeOrder();},undefined,()=>resident?.notifyTargetAvailable(),()=>transport);
function publish(force=false){if(!service||quitting)return;const state=stateProjection(service.getState(),service.getOrderStatus());const encoded=JSON.stringify(state);if(!force&&encoded===lastState)return;lastState=encoded;emit('hostState',state);}
let shuttingDown:Promise<void>|undefined;
let memoryTimer:ReturnType<typeof setInterval>|undefined;
async function shutdown(){
  if(shuttingDown)return shuttingDown;
  quitting=true;if(memoryTimer)clearInterval(memoryTimer);memoryTimer=undefined;resident?.dispose();stopInput?.();
  const deadline=setTimeout(()=>{process.exit(1);},12000);deadline.unref();
  shuttingDown=(async()=>{try{await service?.dispose();}finally{native.stop();emit('hostStopped',{clean:true});process.stdout.end(()=>process.exit(0));}})();
  return shuttingDown;
}
async function invoke(action:HostAction){
  if(quitting)return;
  try{
    const name=action.payload.action;
    switch(name){
      case 'status':publish(true);break;
      case 'refreshSession':await service!.refreshSession();break;
      case 'openLogin':await service!.openLogin();break;
      case 'logout':await service!.logout();break;
      case 'pause':await service!.cancelTranslation();break;
      case 'resume':await service!.resumeTranslation();break;
      case 'followCustomerLanguage':await service!.followCustomerLanguage();break;
      case 'updateSettings':await service!.setTranslationOptions(action.payload.options!);break;
      case 'disconnect':await resident!.disconnect();break;
      case 'connect':await resident!.connect(async()=>{const choices=await native.list();if(choices.length!==1)throw new Error('TARGET_SELECTION_REQUIRED');return choices[0]!.targetInstanceId;});break;
      case 'startClient':await resident!.connect(async current=>{const pid=await startExternalClient(),end=Date.now()+8000;while(current()&&Date.now()<end){const choices=(await native.list()).filter(w=>w.targetInstanceId.startsWith(`${pid}:`));if(choices.length===1)return choices[0]!.targetInstanceId;if(choices.length>1)throw new Error('AMBIGUOUS_CLIENT_WINDOW');await new Promise(r=>setTimeout(r,150));}throw new Error('CLIENT_WINDOW_NOT_FOUND');});break;
      case 'quit':emit('hostResult',{ok:true},action.requestId);await shutdown();return;
    }
    emit('hostResult',{ok:true},action.requestId);publish();
  }catch(error){const message=error instanceof Error?error.message:'';emit('hostResult',{ok:false,code:/^[A-Z_]{1,80}$/.test(message)?message:'HOST_ACTION_FAILED'},action.requestId);}
}
let pendingActions=0;
// EOF is primary. This bounded secondary check handles an accidentally retained pipe.
const parentPid=Number(process.env.TRAVEL_RESIDENT_PARENT_PID);
const parentWatch=Number.isSafeInteger(parentPid)&&parentPid>0?setInterval(()=>{try{process.kill(parentPid,0);}catch{void shutdown();}},5000):undefined;
parentWatch?.unref();
const stopInput=attachProtocol(process.stdin,value=>{
  if(quitting||!value||typeof value!=='object')return;
  if((value as {type?:unknown}).type==='hostAction'){
    const action=parseHostAction(value);
    if(!action){void shutdown();return;}
    if(pendingActions>=16){emit('hostResult',{ok:false,code:'HOST_BUSY'},action.requestId);return;}
    pendingActions++;void invoke(action).finally(()=>pendingActions--);
  }else transport.receive(value);
},()=>{void shutdown();});
process.stdout.on('error',()=>{void shutdown();});
process.on('SIGINT',()=>{void shutdown();});process.on('SIGTERM',()=>{void shutdown();});
process.on('uncaughtException',()=>{process.stderr.write('HOST_UNCAUGHT_EXCEPTION\n');void shutdown();});
process.on('unhandledRejection',()=>{process.stderr.write('HOST_UNHANDLED_REJECTION\n');void shutdown();});
if(process.platform==='win32'||process.platform==='darwin')orderBrowser=new ProfileBrowser(native,()=>null,code=>service?.reportBrowserFailure(code));
service=new CompanionService(native,async url=>{if(url!=='https://csagent.tsim.tech/login')throw new Error('LOGIN_URL_REJECTED');emit('hostOpenLogin',{url});},()=>{},process.argv.includes('--smoke-test')?{enabled:false}:{},true,undefined,new FileTranslationOptionsStore(join(process.env.APPDATA??join(homedir(),'.config'),'trip_vendor_im_companion','translation-options.json')),orderBrowser?profileOrderWindow(orderBrowser,()=>latest?.bounds??null):undefined);
service.onState(()=>publish());resident=new ResidentConnection(native,async()=>{});
native.start();publish(true);
emit('hostReady',{runtime:'node',customerSend:'user-enter'});
if(process.argv.includes('--memory-metrics')){
  memoryTimer=setInterval(()=>{
    if(quitting)return;
    const memory=process.memoryUsage(),heap=getHeapStatistics();
    emit('hostMetrics',{rss:memory.rss,heapTotal:memory.heapTotal,heapUsed:memory.heapUsed,external:memory.external,arrayBuffers:memory.arrayBuffers,heapSizeLimit:heap.heap_size_limit,totalPhysicalSize:heap.total_physical_size});
  },30000);
  memoryTimer.unref();
}
if(!process.argv.includes('--smoke-test'))resident.start();
