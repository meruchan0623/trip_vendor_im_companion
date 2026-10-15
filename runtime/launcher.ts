import { VERIFIED_RUNTIME_BUILD,assertBuildFingerprint,assertOwnedLoopbackListener,type BuildFingerprint,type ProcessIdentity,type ListenerIdentity } from './identity';
export interface VerifiedIdleSnapshot {verified:true;fingerprint:BuildFingerprint;clientProcessIds:number[];clientMainProcessIds:number[];installerProcessIds:number[]}
export interface LaunchPlatform {
  inspectReadOnly():Promise<VerifiedIdleSnapshot>;
  reserveLoopbackPort():Promise<{address:'127.0.0.1';port:number;release():Promise<void>}>;
  spawnOriginal(executable:string,args:readonly string[],options:{shell:false;modifyEnvironment:false}):Promise<ProcessIdentity>;
  waitForListener(process:ProcessIdentity,port:number,timeoutMs:number):Promise<ListenerIdentity>;
}
function assertIdle(snapshot:VerifiedIdleSnapshot):void {
  if(snapshot.verified!==true||!Array.isArray(snapshot.clientProcessIds)||!Array.isArray(snapshot.clientMainProcessIds)||!Array.isArray(snapshot.installerProcessIds))throw new Error('PROCESS_CHECK_UNAVAILABLE');
  assertBuildFingerprint(snapshot.fingerprint);
  if(snapshot.clientProcessIds.length||snapshot.installerProcessIds.length)throw new Error('EXISTING_CLIENT_OR_INSTALLER');
}
/** Called only from an explicit future user launch, never by the read-only checker. */
export async function launchFromExplicitUserAction(platform:LaunchPlatform,userAction:'start-runtime-assistance'):Promise<{process:ProcessIdentity;port:number;fingerprint:BuildFingerprint}> {
  if(userAction!=='start-runtime-assistance')throw new Error('USER_START_REQUIRED');
  assertIdle(await platform.inspectReadOnly());
  const reservation=await platform.reserveLoopbackPort();
  if(reservation.address!=='127.0.0.1'||!Number.isSafeInteger(reservation.port)||reservation.port<1024||reservation.port>=65535){await reservation.release();throw new Error('INVALID_LOOPBACK_RESERVATION');}
  let snapshot:VerifiedIdleSnapshot;
  try{snapshot=await platform.inspectReadOnly();assertIdle(snapshot);}catch(error){await reservation.release();throw error;}
  await reservation.release();
  // Electron 27's own socket factory binds this renderer debugger to 127.0.0.1.
  // Do not enable Node --inspect, main-process eval, disabled security or file writes.
  const process=await platform.spawnOriginal(VERIFIED_RUNTIME_BUILD.executable,[`--remote-debugging-port=${reservation.port}`],{shell:false,modifyEnvironment:false});
  assertOwnedLoopbackListener(process,await platform.waitForListener(process,reservation.port,8000),reservation.port);
  const afterStart=await platform.inspectReadOnly();
  if(afterStart.verified!==true||!Array.isArray(afterStart.clientProcessIds)||!Array.isArray(afterStart.clientMainProcessIds)||!Array.isArray(afterStart.installerProcessIds)||afterStart.installerProcessIds.length||!afterStart.clientProcessIds.includes(process.pid)||afterStart.clientMainProcessIds.length!==1||afterStart.clientMainProcessIds[0]!==process.pid)throw new Error('POST_LAUNCH_PROCESS_CHECK_FAILED');
  assertBuildFingerprint(afterStart.fingerprint);
  return{process,port:reservation.port,fingerprint:snapshot.fingerprint};
}

/** Dev re-attach: the single verified client main process this helper launched earlier with a loopback debugger. Never spawns or restarts anything. */
export async function reattachExplicitDevInstance(platform:LaunchPlatform&{processIdentity(pid:number):Promise<ProcessIdentity>},pid:number,port:number):Promise<{process:ProcessIdentity;port:number;fingerprint:BuildFingerprint}> {
  if(!Number.isSafeInteger(pid)||pid<=0||!Number.isSafeInteger(port)||port<1024||port>=65535)throw new Error('INVALID_REATTACH_ARGUMENTS');
  const snapshot=await platform.inspectReadOnly();
  if(snapshot.verified!==true||snapshot.installerProcessIds.length||snapshot.clientMainProcessIds.length!==1||snapshot.clientMainProcessIds[0]!==pid)throw new Error('REATTACH_PROCESS_MISMATCH');
  assertBuildFingerprint(snapshot.fingerprint);
  const process=await platform.processIdentity(pid);
  if(process.executable.toLowerCase()!==VERIFIED_RUNTIME_BUILD.executable.toLowerCase())throw new Error('REATTACH_PROCESS_MISMATCH');
  assertOwnedLoopbackListener(process,await platform.waitForListener(process,port,1500),port);
  return{process,port,fingerprint:snapshot.fingerprint};
}
