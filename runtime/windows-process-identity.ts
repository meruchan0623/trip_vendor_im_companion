/** Fixed PID inspection used before the native identity optimization. */
export function windowsProcessIdentityScript(pid:number):string{
  if(!Number.isSafeInteger(pid)||pid<=0||pid>0x7fffffff)throw new Error('INVALID_PROCESS_PID');
  return `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop;if(-not $p -or -not $p.ExecutablePath -or -not $p.CreationDate){throw 'Missing process'};$owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;if($owner.ReturnValue -ne 0 -or -not $owner.Sid -or -not $sid -or $owner.Sid -ne $sid){throw 'Process owner mismatch'};$identity=@{pid=[int]$p.ProcessId;executable=$p.ExecutablePath;startedAt=$p.CreationDate.ToUniversalTime().ToString('o')};`;
}
