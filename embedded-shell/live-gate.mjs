import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
export function assertClientIdle(execute=execFileSync){
  const installerPattern=resolve(process.env.LOCALAPPDATA||'','vbk-electron-updater/pending/旅游商家桌面版_win_*.exe').replaceAll("'","''");
  const query=`$ErrorActionPreference='Stop'; $candidates=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -eq '旅游商家桌面版.exe' -or $_.Name -like '旅游商家桌面版_win_*.exe' }); if(@($candidates | Where-Object { [string]::IsNullOrWhiteSpace($_.ExecutablePath) }).Count -gt 0){throw 'Candidate executable path unavailable'}; $count=@($candidates | Where-Object { $_.ExecutablePath -eq 'C:\\Program Files\\vbk-electron\\旅游商家桌面版.exe' -or $_.ExecutablePath -like '${installerPattern}' }).Count; [Console]::WriteLine('tmc-process-check-v1:'+$count)`;
  let response;try{response=execute('powershell.exe',['-NoProfile','-Command',query],{encoding:'utf8',windowsHide:true,timeout:15_000}).trim();}catch{throw new Error('Process check failed: live write refused');}
  if(!/^tmc-process-check-v1:(?:0|[1-9]\d{0,5})$/.test(response))throw new Error('Unrecognized process check: live write refused');
  if(response!=='tmc-process-check-v1:0')throw new Error('Merchant client or its pending installer is running; patch tool never stops either');
}
