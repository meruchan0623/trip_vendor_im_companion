param([string]$Dotnet = 'dotnet')
$ErrorActionPreference = 'Stop'
if ($Dotnet -eq 'dotnet') {
  $sdk = Get-Command dotnet -ErrorAction SilentlyContinue
  $available = $false
  if ($sdk) { $versions = @(& $sdk.Source --list-sdks); $available = $LASTEXITCODE -eq 0 -and $versions.Count -gt 0 }
  if (-not $available) {
    $localSdk = Join-Path $PSScriptRoot '..\..\work\tools\dotnet\dotnet.exe'
    if (-not (Test-Path -LiteralPath $localSdk -PathType Leaf)) { throw 'Install .NET 10 SDK or pass -Dotnet.' }
    $Dotnet = [IO.Path]::GetFullPath($localSdk)
  }
}
Write-Output "Publishing browser native host with SDK: $Dotnet"
& $Dotnet publish (Join-Path $PSScriptRoot 'BrowserBridge.csproj') -c Release -r win-x64 --self-contained true -o (Join-Path $PSScriptRoot 'bin\publish')
if ($LASTEXITCODE -ne 0) { throw 'Browser bridge publish failed' }
