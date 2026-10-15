param([switch]$BindFirst)
$ErrorActionPreference = 'Stop'
$helperPath = Join-Path $PSScriptRoot 'bin\publish\TravelMerchant.WindowHelper.exe'
if (!(Test-Path -LiteralPath $helperPath)) { throw 'Build Windows helper first' }
$startInfo = [Diagnostics.ProcessStartInfo]::new($helperPath)
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$probeProcess = [Diagnostics.Process]::Start($startInfo)
function Invoke-HelperCommand([string]$Type, [hashtable]$Payload = @{}) {
    $probeRequestId = [Guid]::NewGuid().ToString()
    $probeCommand = @{protocolVersion='1.0';requestId=$probeRequestId;type=$Type;payload=$Payload} | ConvertTo-Json -Compress
    Write-Host "stdio request: $probeCommand"
    $probeProcess.StandardInput.WriteLine($probeCommand)
    $probeProcess.StandardInput.Flush()
    $probeDeadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        $probeRead = $probeProcess.StandardOutput.ReadLineAsync()
        if (!$probeRead.Wait(8000)) { throw 'Helper response timeout' }
        $probeLine = $probeRead.Result
        if (!$probeLine) { throw 'Helper closed stdout' }
        Write-Host "stdio response: $probeLine"
        $probeResponse = $probeLine | ConvertFrom-Json
        if ($probeResponse.requestId -eq $probeRequestId) { return $probeResponse }
    } while ([DateTime]::UtcNow -lt $probeDeadline)
    throw 'Helper request pairing timeout'
}
try {
    $startup = $probeProcess.StandardOutput.ReadLineAsync()
    if (!$startup.Wait(8000)) { throw 'Helper startup timeout' }
    Write-Output "stdio startup: $($startup.Result)"
    $probeRows = @(Invoke-HelperCommand 'listWindows')
    $probeWindowsResponse = $probeRows[-1]
    # Every actual stdout record above is visible. BindFirst is restricted to a unique approved target.
    if ($BindFirst) {
        $probeWindows = @($probeWindowsResponse.payload.windows)
        if ($probeWindows.Count -ne 1) { throw "Expected exactly one approved target, found $($probeWindows.Count); select a target explicitly in the panel" }
        Invoke-HelperCommand 'bindWindow' @{targetInstanceId=$probeWindows[0].targetInstanceId}
        Invoke-HelperCommand 'probeCapabilities' @{businessProbe=$true}
    }
    Invoke-HelperCommand 'stop'
} finally {
    $probeProcess.StandardInput.Close()
    if (!$probeProcess.WaitForExit(3000)) { $probeProcess.Kill() }
    $probeError = $probeProcess.StandardError.ReadToEnd()
    if ($probeError) { Write-Output "helper stderr: $probeError" }
    $probeProcess.Dispose()
}
