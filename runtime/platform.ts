import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {RUNTIME_PLATFORM} from './build-manifest';
import {WindowsLaunchPlatform} from './windows-platform';
import {MacLaunchPlatform} from './macos-platform';
const execute=promisify(execFile);
let vendorDebugArguments:readonly string[]|undefined;
/** Called after the single-instance owner handoff has passed its own process validation. */
export function configureExplicitVendorDebugPort(args:readonly string[]){
  const owner=args.find(value=>value.startsWith('--vendor-owner=')),match=owner?/^--vendor-owner=([1-9]\d*)$/.exec(owner):null;
  if(!match||explicitVendorDebugPort(args,Number(match[1]))===undefined)throw new Error('EXISTING_CLIENT_DEBUG_PORT_REQUIRED');
  vendorDebugArguments=[...args];
}
export type ClientLaunchPlatform=WindowsLaunchPlatform|MacLaunchPlatform;
/** The host must match the manifest the bundle was built for. */
export function createLaunchPlatform():ClientLaunchPlatform{
  if(process.platform==='win32'&&RUNTIME_PLATFORM==='win32')return new WindowsLaunchPlatform();
  if(process.platform==='darwin'&&RUNTIME_PLATFORM==='darwin')return new MacLaunchPlatform();
  throw new Error('UNSUPPORTED_PLATFORM');
}
/** The loopback debugger port from a running client main process' own command line; never guessed. */
export async function existingClientDebugPort(pid:number):Promise<number>{
  if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('EXISTING_CLIENT_DEBUG_PORT_REQUIRED');
  if(process.platform==='darwin'){try{return await new MacLaunchPlatform().debugPortOf(pid);}catch{throw new Error('EXISTING_CLIENT_DEBUG_PORT_REQUIRED');}}
  if(process.platform!=='win32')throw new Error('EXISTING_CLIENT_DEBUG_PORT_REQUIRED');
  const injected=explicitVendorDebugPort(vendorDebugArguments??process.argv,pid);
  if(injected==='auto')return new WindowsLaunchPlatform().discoverDebugPort(pid);
  if(injected!==undefined)return injected;
  const script=`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if(-not $p -or $p.CommandLine -match '--type=' -or $p.CommandLine -notmatch '--remote-debugging-port=(\\d+)'){throw 'DEBUG_PORT_REQUIRED'}; @{port=[int]$Matches[1]}|ConvertTo-Json -Compress`;
  try { const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:16000});return JSON.parse(stdout.trim()).port; }
  catch {throw new Error('EXISTING_CLIENT_DEBUG_PORT_REQUIRED');}
}
/** Bootstrap appendSwitch is not in the OS command line. This hint is never an ownership proof;
 * reattachExplicitDevInstance still verifies the process image, creation time and loopback listener. */
export function explicitVendorDebugPort(args:readonly string[],pid:number):number|'auto'|undefined{
  const owners=args.filter(value=>value.startsWith('--vendor-owner=')),ports=args.filter(value=>value.startsWith('--vendor-debug-port='));
  if(!owners.length&&!ports.length)return undefined;
  const owner=owners.length===1?/^--vendor-owner=([1-9]\d*)$/.exec(owners[0]):null,port=ports.length===1?/^--vendor-debug-port=(auto|\d{4,5})$/.exec(ports[0]):null;
  if(!owner||!port||Number(owner[1])!==pid||!Number.isSafeInteger(pid)||pid<=0||port[1]!=='auto'&&(Number(port[1])<1024||Number(port[1])>65535))throw new Error('EXISTING_CLIENT_DEBUG_PORT_REQUIRED');
  return port[1]==='auto'?'auto':Number(port[1]);
}
