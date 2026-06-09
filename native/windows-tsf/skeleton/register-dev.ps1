$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dll = Join-Path $Root "build\bin\Release\LekhTextService.dll"

if (!(Test-Path $Dll)) {
  throw "Build the TSF DLL first: .\build.ps1"
}

regsvr32.exe /s $Dll
Write-Host "Registered Lekh Keyboard TSF text service for the current user."
