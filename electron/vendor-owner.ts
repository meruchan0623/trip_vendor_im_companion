import type {ProcessIdentity} from '../runtime/identity';
import {sameExecutablePath} from '../runtime/identity';

/** ESRCH confirms exit; permissions or inspection failures do not. */
function processGone(pid:number):boolean {try{process.kill(pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}}

/** Inspection exhaustion is recoverable; a vanished/replaced owner is a normal lifetime end. */
export function vendorOwnerExitCode(reason:string):number {return reason==='VENDOR_OWNER_INSPECTION_FAILED'?72:0;}

export function vendorOwnerPID(args:readonly string[]):number|undefined {
  const flags=args.filter(arg=>arg.startsWith('--vendor-owner'));
  if(!flags.length)return undefined;
  const match=flags.length===1?/^--vendor-owner=([1-9]\d{0,8})$/.exec(flags[0]):null;
  if(!match)throw new Error('INVALID_VENDOR_OWNER');
  return Number(match[1]);
}

/** Bind automatic assistance to one process lifetime, including protection against PID reuse. */
export async function watchVendorOwner(pid:number,inspect:(pid:number)=>Promise<ProcessIdentity>,expectedExecutable:string,onExit:(reason:string)=>void,intervalMs=1000,options:{isProcessGone?:(pid:number)=>boolean;maxInspectionFailures?:number}={}):Promise<()=>void>{
  const owner=await inspect(pid);
  if(owner.pid!==pid||!sameExecutablePath(owner.executable,expectedExecutable))throw new Error('INVALID_VENDOR_OWNER');
  let stopped=false,busy=false,failures=0;
  const maxFailures=options.maxInspectionFailures??3,isGone=options.isProcessGone??processGone;
  const exit=(reason:string)=>{if(stopped)return;stopped=true;clearInterval(timer);onExit(reason);};
  const timer=setInterval(async()=>{
    if(stopped||busy)return;busy=true;
    try{const current=await inspect(pid);if(stopped)return;if(current.pid!==owner.pid||current.startedAt!==owner.startedAt||!sameExecutablePath(current.executable,owner.executable)){exit('VENDOR_OWNER_CHANGED');return;}failures=0;}
    catch{if(stopped)return;let gone=false;try{gone=isGone(pid);}catch{/* Unknown is not proof of exit. */}if(gone)exit('VENDOR_OWNER_EXITED');else if(++failures>=maxFailures)exit('VENDOR_OWNER_INSPECTION_FAILED');}
    finally{busy=false;}
  },intervalMs);
  timer.unref?.();
  return()=>{stopped=true;clearInterval(timer);};
}
