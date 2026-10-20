import {connect,type Socket} from 'node:net';
/** Fixed startup stages shown by the official client's loading placeholder. Never carries text or identifiers. */
export type VendorProgressStage='host-ready'|'start'|'files-verified'|'transport-ready'|'target-found'|'page-verified'|'native-ready'|'panel-mounted'|'failed';
const STAGES=new Set<string>(['host-ready','start','files-verified','transport-ready','target-found','page-verified','native-ready','panel-mounted','failed']);
const PIPE=/^--vendor-progress=(\\\\\.\\pipe\\tsim-companion-progress-[1-9]\d{0,8}-[a-f0-9]{32})$/;
let socket:Socket|undefined;
/** The pipe the installed vendor bootstrap opened for this owner; absent or malformed means no progress display. */
export function vendorProgressPipe(args:readonly string[],ownerPID:number):string|undefined{
  const flags=args.filter(arg=>arg.startsWith('--vendor-progress'));
  const match=flags.length===1?PIPE.exec(flags[0]):null;
  return match&&match[1].includes(`-progress-${ownerPID}-`)?match[1]:undefined;
}
/** Replaces any previous owner's channel. Progress is best effort and never keeps the helper alive. */
export function connectVendorProgress(args:readonly string[],ownerPID:number,open:(path:string)=>Socket=connect):void{
  const previous=socket;socket=undefined;previous?.destroy();
  const pipe=vendorProgressPipe(args,ownerPID);if(!pipe)return;
  try{const next=open(pipe);next.on('error',()=>{if(socket===next)socket=undefined;});next.on('close',()=>{if(socket===next)socket=undefined;});next.unref?.();socket=next;}catch{socket=undefined;}
}
export function reportVendorProgress(stage:VendorProgressStage):void{
  if(!socket||!STAGES.has(stage))return;
  try{socket.write(JSON.stringify({stage})+'\n');}catch{/* The vendor may have closed its placeholder channel. */}
}
export function disconnectVendorProgress():void{const previous=socket;socket=undefined;previous?.destroy();}
