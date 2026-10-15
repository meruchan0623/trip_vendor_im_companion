param([string]$Node = (Get-Command node.exe).Source)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$fixture = Join-Path $workspace 'work\resident-backpressure-fixture'
New-Item -ItemType Directory -Force (Join-Path $fixture 'runtime'),(Join-Path $fixture 'host') | Out-Null
Copy-Item -LiteralPath $Node -Destination (Join-Path $fixture 'runtime\node.exe')
@'
// Test-only child: never consumes stdin. No customer page/browser access.
let i=0;const emit=setInterval(()=>{process.stdout.write(JSON.stringify({protocolVersion:'1.0',requestId:'test_'+i++,type:'probeCapabilities',payload:{}})+'\n');if(i>=1800)clearInterval(emit);},2);
setInterval(()=>{},1000);
'@ | Set-Content -LiteralPath (Join-Path $fixture 'host\main.cjs') -Encoding utf8
$clock = [Diagnostics.Stopwatch]::StartNew()
$resident = Start-Process -FilePath (Join-Path $PSScriptRoot 'bin\publish\TravelMerchant.Resident.exe') -ArgumentList '--smoke-test', $fixture -WindowStyle Hidden -PassThru
if (-not $resident.WaitForExit(20000)) {
  # Only the test-owned parent is terminated. Never enumerate/kill unrelated processes.
  $resident.Kill()
  throw 'Backpressure timeout: resident UI shutdown was blocked'
}
$result = @{ passed = $resident.ExitCode -eq 0; elapsedMs = $clock.ElapsedMilliseconds; exitCode = $resident.ExitCode; inputConsumed = $false; customerSend = $false }
$result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fixture 'result.json') -Encoding utf8
$result | ConvertTo-Json
if (-not $result.passed) { throw 'Backpressure fixture failed' }
