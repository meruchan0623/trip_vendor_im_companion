param([string]$HostPath = '', [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$hostName = 'tech.tsim.travel_merchant_companion'
$extensionId = 'iiepfpjonkacmepbnhgacllpipibhphh'
$installDirectory = Join-Path $env:LOCALAPPDATA 'TravelMerchantCompanion\browser-bridge'
$registryPaths = @("HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName", "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName")
if ($Uninstall) {
  foreach ($registryPath in $registryPaths) { if (Test-Path -LiteralPath $registryPath) { Remove-Item -LiteralPath $registryPath } }
  Write-Output 'Browser native host registration removed. Browser sessions are unchanged.'
  exit
}
if (-not $HostPath) { $HostPath = Join-Path $PSScriptRoot '..\native\browser-bridge\bin\publish\TravelMerchant.BrowserBridge.exe' }
$resolvedHost = [IO.Path]::GetFullPath($HostPath)
if (-not (Test-Path -LiteralPath $resolvedHost -PathType Leaf)) { throw 'Build native/browser-bridge/build.ps1 first, or pass -HostPath to a published native host.' }
New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
if ($PSVersionTable.PSEdition -eq 'Core') { [Security.AccessControl.FileSystemAclExtensions]::SetAccessControl((New-Object IO.DirectoryInfo($installDirectory)), $acl) }
else { [IO.Directory]::SetAccessControl($installDirectory, $acl) }
$installedHost = Join-Path $installDirectory 'TravelMerchant.BrowserBridge.exe'
if ($resolvedHost -ne $installedHost) { Copy-Item -LiteralPath $resolvedHost -Destination $installedHost -Force }
$manifestPath = Join-Path $installDirectory "$hostName.json"
$manifestJSON = @{name=$hostName;description='TSim travel merchant companion browser session bridge';path=$installedHost;type='stdio';allowed_origins=@("chrome-extension://$extensionId/")} | ConvertTo-Json
[IO.File]::WriteAllText($manifestPath, $manifestJSON, (New-Object Text.UTF8Encoding($false)))
foreach ($registryPath in $registryPaths) { New-Item -Path $registryPath -Force | Out-Null; Set-Item -LiteralPath $registryPath -Value $manifestPath }
Write-Output "Installed native host: $installedHost"
Write-Output "Extension ID: $extensionId"
Write-Output 'Load browser-extension as an unpacked extension in the browser profile already signed in to TSim. Then open the companion.'
