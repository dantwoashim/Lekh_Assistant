$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
if (!$Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $Elevated = Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"") `
    -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  if ($Elevated.ExitCode -ne 0) { throw "Administrator unregistration was cancelled or failed." }
  exit 0
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dll = Join-Path $Root "build\bin\Release\LekhTextService.dll"
$CompatibilityDll = Join-Path $Root "build-Win32\bin\Release\LekhTextService.dll"

if (Test-Path -LiteralPath $CompatibilityDll -PathType Leaf) {
  & "$env:WINDIR\SysWOW64\regsvr32.exe" /u /s $CompatibilityDll
  if ($LASTEXITCODE -ne 0) { throw "32-bit regsvr32 failed with exit code $LASTEXITCODE." }
  Write-Host "Unregistered the 32-bit Lekh Keyboard TSF text service."
}

if (Test-Path -LiteralPath $Dll -PathType Leaf) {
  & "$env:WINDIR\System32\regsvr32.exe" /u /s $Dll
  if ($LASTEXITCODE -ne 0) { throw "regsvr32 failed with exit code $LASTEXITCODE." }
  Write-Host "Unregistered the 64-bit Lekh Keyboard TSF text service."
} else {
  Write-Host "64-bit TSF DLL not found; nothing else to unregister."
}
