param([string]$Dotnet = 'dotnet')
$ErrorActionPreference = 'Stop'
if ($Dotnet -eq 'dotnet') {
    $command = Get-Command dotnet -ErrorAction SilentlyContinue
    $sdkAvailable = $false
    if ($command) { $sdks = @(& $command.Source --list-sdks); $sdkAvailable = $LASTEXITCODE -eq 0 -and $sdks.Count -gt 0 }
    if (-not $sdkAvailable) {
        $workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
        $localSdk = Join-Path $workspaceRoot 'work\tools\dotnet\dotnet.exe'
        if (-not (Test-Path -LiteralPath $localSdk -PathType Leaf)) { throw 'No .NET SDK found; provide -Dotnet or install .NET 10 SDK.' }
        $Dotnet = $localSdk
    }
}
Write-Output "Publishing Windows helper with SDK: $Dotnet"
& $Dotnet publish (Join-Path $PSScriptRoot 'WindowHelper.csproj') -c Release -r win-x64 --self-contained true -o (Join-Path $PSScriptRoot 'bin\publish')
if ($LASTEXITCODE -ne 0) { throw 'Windows helper publish failed' }
