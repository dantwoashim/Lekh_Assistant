$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
if (!$Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $Elevated = Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"") `
    -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  if ($Elevated.ExitCode -ne 0) { throw "Administrator registration was cancelled or failed." }
  exit 0
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dll = Join-Path $Root "build\bin\Release\LekhTextService.dll"
$CompatibilityDll = Join-Path $Root "build-Win32\bin\Release\LekhTextService.dll"

if (!(Test-Path -LiteralPath $Dll -PathType Leaf) -or !(Test-Path -LiteralPath $CompatibilityDll -PathType Leaf)) {
  throw "Build both TSF DLLs first: .\build.ps1 -Architecture x64; .\build.ps1 -Architecture x86"
}

& "$env:WINDIR\System32\regsvr32.exe" /s $Dll
if ($LASTEXITCODE -ne 0) { throw "regsvr32 failed with exit code $LASTEXITCODE." }
& "$env:WINDIR\SysWOW64\regsvr32.exe" /s $CompatibilityDll
if ($LASTEXITCODE -ne 0) {
  $CompatibilityExitCode = $LASTEXITCODE
  & "$env:WINDIR\System32\regsvr32.exe" /u /s $Dll
  throw "32-bit regsvr32 failed with exit code $CompatibilityExitCode; 64-bit registration was rolled back."
}
Write-Host "Registered the 64-bit and 32-bit Lekh Keyboard TSF text services system-wide for development."
