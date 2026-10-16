import type {ProcessIdentity} from '../runtime/identity';

export function vendorOwnerPID(args:readonly string[]):number|undefined {
  const flags=args.filter(arg=>arg.startsWith('--vendor-owner'));
  if(!flags.length)return undefined;
  const match=flags.length===1?/^--vendor-owner=([1-9]\d{0,8})$/.exec(flags[0]):null;
  if(!match)throw new Error('INVALID_VENDOR_OWNER');
  return Number(match[1]);
}

/** Bind automatic assistance to one process lifetime, including protection against PID reuse. */
export async function watchVendorOwner(pid:number,inspect:(pid:number)=>Promise<ProcessIdentity>,expectedExecutable:string,onExit:()=>void,intervalMs=1000):Promise<()=>void>{
  const owner=await inspect(pid);
  if(owner.pid!==pid||owner.executable.normalize('NFC')!==expectedExecutable.normalize('NFC'))throw new Error('INVALID_VENDOR_OWNER');
  let stopped=false,busy=false;
  const timer=setInterval(async()=>{
    if(stopped||busy)return;busy=true;
    try{const current=await inspect(pid);if(current.pid!==owner.pid||current.startedAt!==owner.startedAt||current.executable!==owner.executable)throw new Error('VENDOR_OWNER_CHANGED');}
    catch{if(!stopped){stopped=true;clearInterval(timer);onExit();}}
    finally{busy=false;}
  },intervalMs);
  timer.unref?.();
  return()=>{stopped=true;clearInterval(timer);};
}
