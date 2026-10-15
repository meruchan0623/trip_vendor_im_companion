import {createInterface} from 'node:readline';
import {WindowsLaunchPlatform} from './windows-platform';
import {launchFromExplicitUserAction,reattachExplicitDevInstance} from './launcher';
import {assertOwnedLoopbackListener} from './identity';
import {connectOwnedLoopback} from './transport';
import {LiveRuntimeDriver} from './driver';
import {RuntimeAttachment} from './attachment';
import {runtimeBundle,runtimeBundleSha256} from './bundle';
import {SetupScope} from './setup-scope';
import {appendFileSync} from 'node:fs';
import {runOwnedAuthWorker} from '../host/auth-worker';
declare const __RUNTIME_LOG_FILE__:string;
const log=(event:string,fields:Record<string,unknown>={})=>{const line=JSON.stringify({event,...fields});console.log(line);try{appendFileSync(__RUNTIME_LOG_FILE__,line+'\n','utf8');}catch{console.error('OWN_LOG_UNAVAILABLE');}};
function safeFailure(error:unknown){const text=error instanceof Error?error.message:'';return /^[A-Z][A-Z0-9_]{1,100}$/.test(text)?text:'RUNTIME_ASSISTANCE_FAILED';}
async function main(){
  if(process.argv.slice(2).length===1&&process.argv[2]==='--owned-auth'){await runOwnedAuthWorker();return;}
  const args=process.argv.slice(2);const reattach=args.length===1?/^--reattach=(\d{1,7}):(\d{4,5})$/.exec(args[0]):null;if(args.length>1||args.some(arg=>!['--dry-run','--launch'].includes(arg))&&!reattach)throw new Error('INVALID_ARGUMENTS');
  const platform=new WindowsLaunchPlatform();
  if(!args.includes('--launch')&&!reattach){const snapshot=await platform.inspectReadOnly();log('dry-run',{verifiedBuild:snapshot.fingerprint.aresVersion,clientProcesses:snapshot.clientProcessIds.length,installerProcesses:snapshot.installerProcessIds.length,idle:snapshot.clientProcessIds.length===0&&snapshot.installerProcessIds.length===0,existingInstanceAttach:false,launchImplemented:true,runtimeAttach:'awaiting-live-acceptance',serviceBridgeImplemented:true,customerSend:false,vendorFilesWritten:false});return;}
  const started=Date.now();log('launch-requested',{customerSend:false,vendorFilesWritten:false});
  const launched=reattach?await reattachExplicitDevInstance(platform,Number(reattach[1]),Number(reattach[2])):await launchFromExplicitUserAction(platform,'start-runtime-assistance');log('client-started',{pid:launched.process.pid,elapsedMs:Date.now()-started});
  const verifyOwner=async()=>assertOwnedLoopbackListener(launched.process,await platform.waitForListener(launched.process,launched.port,1500),launched.port);
  let transport:Awaited<ReturnType<typeof connectOwnedLoopback>>|undefined,driver:LiveRuntimeDriver|undefined,attachment:RuntimeAttachment|undefined;
  let finishing:Promise<void>|undefined,heartbeatTimer:ReturnType<typeof setInterval>|undefined,ownerTimer:ReturnType<typeof setInterval>|undefined;
  const scope=new SetupScope();let interrupted=false;const interruptedSignal=()=>{interrupted=true;void finish();};
  let end! :()=>void;const ended=new Promise<void>(resolve=>{end=resolve;});let input:ReturnType<typeof createInterface>|undefined;
  const finish=()=>finishing??=Promise.resolve().then(async()=>{if(heartbeatTimer)clearInterval(heartbeatTimer);if(ownerTimer)clearInterval(ownerTimer);input?.close();try{await scope.close();}catch(error){log('cleanup-fallback',{reason:safeFailure(error),leaseExpiryMs:6000});}finally{log('detached',{originalClientCloseRequested:false});end();}});
  process.on('SIGINT',interruptedSignal);process.on('SIGTERM',interruptedSignal);
  try{
    transport=await scope.acquire(connectOwnedLoopback(launched.port,verifyOwner),resource=>resource.disconnect());if(interrupted)throw new Error('USER_CANCELLED');
    driver=await scope.acquire(LiveRuntimeDriver.discover(transport,launched.fingerprint,runtimeBundle,runtimeBundleSha256),resource=>resource.disconnect());if(interrupted)throw new Error('USER_CANCELLED');
    attachment=await scope.acquire(Promise.resolve(new RuntimeAttachment(driver)),resource=>resource.close());await attachment.attach(driver.target);if(interrupted)throw new Error('USER_CANCELLED');
    log('parent-capture-diagnostics',{captures:driver.parentCaptureDiagnostics,boundary:'isolated-world-shadow'});
    log('attached',{mode:'outbound-operator',serviceBridgeImplemented:true,customerSend:false,elapsedMs:Date.now()-started});console.log('旧诊断入口仅挂载空容器，不提供业务功能；请通过 npm start 启动新版内嵌助手。输入 d 后回车或按 Ctrl+C 退出辅助，原客户端会继续运行。');
    let lastGeometry='';const geometry=async()=>{const value=await driver!.geometry();const key=JSON.stringify(value);if(key!==lastGeometry){lastGeometry=key;log('owned-panel-geometry',{...value});}};await geometry();
    let heartbeatPending=false,ownerPending=false;
    heartbeatTimer=setInterval(()=>{if(heartbeatPending||finishing)return;heartbeatPending=true;void attachment!.heartbeat().then(async()=>{if(attachment!.status!=='attached')void finish();else await geometry();}).catch(error=>{log('lease-failed',{reason:safeFailure(error)});void finish();}).finally(()=>{heartbeatPending=false;});},1500);
    ownerTimer=setInterval(()=>{if(ownerPending||finishing)return;ownerPending=true;void verifyOwner().catch(error=>{log('owner-changed',{reason:safeFailure(error)});void finish();}).finally(()=>{ownerPending=false;});},5000);
    input=createInterface({input:process.stdin,output:process.stdout,terminal:process.stdin.isTTY});input.on('line',line=>{if(['d','q','退出'].includes(line.trim().toLowerCase()))void finish();});input.on('close',()=>{void finish();});
    await ended;
  }catch(error){await finish();throw error;}finally{process.removeListener('SIGINT',interruptedSignal);process.removeListener('SIGTERM',interruptedSignal);await finish();}
}
main().catch(error=>{log('failed',{reason:safeFailure(error),originalClientCloseRequested:false});console.error('辅助未启用。若客户端或安装器仍在运行，请自行关闭后再启动辅助；原客户端不会被自动关闭。');process.exitCode=1;});


