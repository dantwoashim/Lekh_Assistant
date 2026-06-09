$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dll = Join-Path $Root "build\bin\Release\LekhTextService.dll"

if (Test-Path $Dll) {
  regsvr32.exe /u /s $Dll
  Write-Host "Unregistered Lekh Keyboard TSF text service."
} else {
  Write-Host "TSF DLL not found; nothing to unregister."
}
