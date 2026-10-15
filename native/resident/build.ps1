param([string]$Dotnet = 'dotnet')
$ErrorActionPreference = 'Stop'
if ($Dotnet -eq 'dotnet') {
  $command = Get-Command dotnet -ErrorAction SilentlyContinue
  $sdkAvailable = $false
  if ($command) { $sdks = @(& $command.Source --list-sdks); $sdkAvailable = $LASTEXITCODE -eq 0 -and $sdks.Count -gt 0 }
  if (-not $sdkAvailable) { $Dotnet = Join-Path $PSScriptRoot '..\..\work\tools\dotnet\dotnet.exe' }
}
& $Dotnet publish (Join-Path $PSScriptRoot 'Resident.csproj') -c Release -r win-x64 --self-contained true -o (Join-Path $PSScriptRoot 'bin\publish')
if ($LASTEXITCODE -ne 0) { throw 'Resident publish failed' }
