$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BuildDir = Join-Path $Root "build"

cmake -S $Root -B $BuildDir -A x64
cmake --build $BuildDir --config Release

$Dll = Join-Path $BuildDir "bin\Release\LekhTextService.dll"
if (!(Test-Path $Dll)) {
  throw "Expected TSF DLL not found: $Dll"
}

Write-Host "Built $Dll"
