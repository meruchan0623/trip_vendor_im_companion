import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
/** Runs the fixed read-only inspection scripts in an isolated PowerShell process. */
export class WindowsPowerShell{
  private disposed=false;
  async execute(script:string):Promise<unknown>{
    if(this.disposed)throw new Error('WINDOWS_POWERSHELL_EXECUTION_FAILED');
    const encoded=Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); ${script}`,'utf16le').toString('base64');
    const env={...process.env};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
    const {stdout,stderr}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{env,windowsHide:true,timeout:15000,maxBuffer:256000});
    if(stderr.trim())throw new Error('WINDOWS_POWERSHELL_EXECUTION_FAILED');
    try{return JSON.parse(stdout.trim());}catch{throw new Error('WINDOWS_POWERSHELL_EXECUTION_FAILED');}
  }
  dispose(){this.disposed=true;}
}
export const windowsPowerShell=new WindowsPowerShell();
