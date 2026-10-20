import { win32,posix } from 'node:path';
import {VERIFIED_RUNTIME_BUILD,RUNTIME_PLATFORM} from './build-manifest';
export {VERIFIED_RUNTIME_BUILD,RUNTIME_PLATFORM} from './build-manifest';
export type BuildFingerprint = { [K in keyof Pick<typeof VERIFIED_RUNTIME_BUILD,'executable'|'executableVersion'|'packageVersion'|'aresVersion'|'executableSha256'|'asarSha256'|'htmlSha256'|'rendererSha256'>]:string };
/** Windows paths are case-insensitive; macOS compares the exact NFC path (ps/lsof may report either Unicode form). */
export function sameExecutablePath(a:string,b:string):boolean {
  return RUNTIME_PLATFORM==='darwin'?posix.normalize(a).normalize('NFC')===posix.normalize(b).normalize('NFC'):win32.normalize(a).toLowerCase()===win32.normalize(b).toLowerCase();
}
export function assertBuildFingerprint(value:BuildFingerprint):void {
  for(const key of Object.keys(value) as (keyof BuildFingerprint)[]) if(!(key in VERIFIED_RUNTIME_BUILD))throw new Error('UNVERIFIED_BUILD');
  for(const key of ['executableVersion','packageVersion','aresVersion','executableSha256','asarSha256','htmlSha256','rendererSha256'] as const) if(value[key]!==VERIFIED_RUNTIME_BUILD[key])throw new Error('UNVERIFIED_BUILD');
  if(!sameExecutablePath(value.executable,VERIFIED_RUNTIME_BUILD.executable))throw new Error('UNVERIFIED_EXECUTABLE');
}
export function approvedDocumentURL(value:string):boolean {
  try{const url=new URL(value),expected=new URL(VERIFIED_RUNTIME_BUILD.documentURL);return url.protocol==='file:'&&!url.host&&!url.search&&!url.hash&&decodeURIComponent(url.pathname).toLowerCase()===decodeURIComponent(expected.pathname).toLowerCase();}catch{return false;}
}
export interface ProcessIdentity {pid:number;startedAt:string;executable:string}
export interface ListenerIdentity {pid:number;address:string;port:number;processStartedAt:string}
export function assertOwnedLoopbackListener(process:ProcessIdentity,listener:ListenerIdentity,port:number,expectedExecutable=VERIFIED_RUNTIME_BUILD.executable):void {
  if(!Number.isSafeInteger(process.pid)||process.pid<=0||!process.startedAt||!sameExecutablePath(process.executable,expectedExecutable))throw new Error('UNVERIFIED_PROCESS');
  if(listener.pid!==process.pid||listener.processStartedAt!==process.startedAt||listener.address!=='127.0.0.1'||listener.port!==port)throw new Error('UNOWNED_DEBUG_LISTENER');
}
