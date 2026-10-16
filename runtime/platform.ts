import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {RUNTIME_PLATFORM} from './build-manifest';
import {WindowsLaunchPlatform} from './windows-platform';
import {MacLaunchPlatform} from './macos-platform';
const execute=promisify(execFile);
export type ClientLaunchPlatform=WindowsLaunchPlatform|MacLaunchPlatform;
/** The host must match the manifest the bundle was built for. */
export function createLaunchPlatform():ClientLaunchPlatform{
  if(process.platform==='win32'&&RUNTIME_PLATFORM==='win32')return new WindowsLaunchPlatform();
  if(process.platform==='darwin'&&RUNTIME_PLATFORM==='darwin')return new MacLaunchPlatform();
  throw new Error('UNSUPPORTED_PLATFORM');
}
/** The loopback debugger port from a running client main process' own command line; never guessed. */
export async function existingClientDebugPort(pid:number):Promise<number>{
  if(process.platform==='darwin'){try{return await new MacLaunchPlatform().debugPortOf(pid);}catch{throw new Error('EXISTING_CLIENT_DEBUG_PORT_REQUIRED');}}
  if(process.platform!=='win32')throw new Error('EXISTING_CLIENT_DEBUG_PORT_REQUIRED');
  const script=`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if(-not $p -or $p.CommandLine -match '--type=' -or $p.CommandLine -notmatch '--remote-debugging-port=(\\d+)'){throw 'DEBUG_PORT_REQUIRED'}; @{port=[int]$Matches[1]}|ConvertTo-Json -Compress`;
  try { const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:16000});return JSON.parse(stdout.trim()).port; }
  catch {throw new Error('EXISTING_CLIENT_DEBUG_PORT_REQUIRED');}
}
