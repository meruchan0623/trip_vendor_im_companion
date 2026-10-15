param([Parameter(Mandatory=$true)][int]$RootProcessId,[int]$VendorProcessId=0,[int]$Seconds=600,[Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
$taskRoot=Get-Process -Id $RootProcessId
$taskRootStart=$taskRoot.StartTime.ToUniversalTime().ToString('o')
$taskKnown=@{}; $taskPrevious=@{}; $taskSamples=[Collections.Generic.List[object]]::new()
$taskClock=[Diagnostics.Stopwatch]::StartNew(); $taskLast=0.0
$taskDirectory=Split-Path -Parent ([IO.Path]::GetFullPath($OutputPath))
[IO.Directory]::CreateDirectory($taskDirectory)|Out-Null
Write-Output "Sampling root $RootProcessId for $Seconds seconds; output $OutputPath"
while($taskClock.Elapsed.TotalSeconds -lt $Seconds){
  $taskCurrentRoot=Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
  if(-not $taskCurrentRoot -or $taskCurrentRoot.StartTime.ToUniversalTime().ToString('o') -ne $taskRootStart){Write-Output 'Root process ended or identity changed; stopping sample';break}
  $taskAll=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name)
  $taskVendorIds=@();if($VendorProcessId -gt 0){$taskVendorIds=@($VendorProcessId);do{$taskMore=@($taskAll|Where-Object {$_.ParentProcessId -in $taskVendorIds -and $_.ProcessId -notin $taskVendorIds}|ForEach-Object {[int]$_.ProcessId});$taskVendorIds+=$taskMore}while($taskMore.Count)}
  $taskNow=$taskClock.Elapsed.TotalSeconds; $taskDt=$taskNow-$taskLast; $taskLast=$taskNow
  foreach($taskGroup in @(@{Name='helper';Root=$RootProcessId},@{Name='vendor';Root=$VendorProcessId})){
    if($taskGroup.Root -le 0){continue}
    $taskIds=@([int]$taskGroup.Root)
    do {$taskNext=@($taskAll|Where-Object {$_.ParentProcessId -in $taskIds -and $_.ProcessId -notin $taskIds -and ($taskGroup.Name -ne 'helper' -or $_.ProcessId -notin $taskVendorIds)}|ForEach-Object {[int]$_.ProcessId});$taskIds+=$taskNext}while($taskNext.Count)
    $taskWorking=0L; $taskPrivate=0L; $taskCpu=0.0; $taskHandles=0; $taskCount=0
    foreach($taskId in $taskIds){
      try{$taskP=Get-Process -Id $taskId -ErrorAction Stop;$taskKey="$($taskGroup.Name):$taskId`:$($taskP.StartTime.Ticks)";$taskTotal=$taskP.TotalProcessorTime.TotalSeconds
        if($taskPrevious.ContainsKey($taskKey)){$taskCpu+=[Math]::Max([double]0,[double]($taskTotal-$taskPrevious[$taskKey]))}
        $taskPrevious[$taskKey]=$taskTotal;$taskWorking+=$taskP.WorkingSet64;$taskPrivate+=$taskP.PrivateMemorySize64;$taskHandles+=$taskP.HandleCount;$taskCount++
        $taskKnown[$taskKey]=@{pid=$taskId;name=$taskP.ProcessName;startedAt=$taskP.StartTime.ToUniversalTime().ToString('o');group=$taskGroup.Name}
      }catch{}
    }
    $taskSamples.Add([pscustomobject]@{seconds=[Math]::Round($taskNow,3);group=$taskGroup.Name;workingSetMiB=[Math]::Round($taskWorking/1MB,3);privateCommitMiB=[Math]::Round($taskPrivate/1MB,3);cpuPercentMachine=[Math]::Round(100*$taskCpu/$taskDt/[Environment]::ProcessorCount,4);handles=$taskHandles;processes=$taskCount})
  }
  if($taskSamples.Count % 30 -eq 0){Write-Output ($taskSamples[$taskSamples.Count-2]|ConvertTo-Json -Compress)}
  Start-Sleep -Milliseconds 1000
}
$taskResult=@{measurementVersion=2;rootProcessId=$RootProcessId;rootStartedAt=$taskRootStart;logicalProcessors=[Environment]::ProcessorCount;elapsedSeconds=$taskClock.Elapsed.TotalSeconds;knownProcesses=@($taskKnown.Values);samples=@($taskSamples.ToArray());limitations=@('Working set sum includes shared pages','Sampling interval is one-second sleep plus process enumeration time; snapshots can miss short-lived children','First sample CPU excluded from comparisons; no Private Working Set counter collected')}
$taskResult|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Output "Completed: $OutputPath ($($taskSamples.Count) samples)"
