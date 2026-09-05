param(
  [ValidateSet("x64", "x86", "ARM64")]
  [string]$Architecture = "x64",
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$CMakeArchitecture = if ($Architecture -eq "x86") { "Win32" } else { $Architecture }
$BuildDirectoryName = switch ($Architecture) {
  "x64" { "build" }
  "x86" { "build-Win32" }
  default { "build-$Architecture" }
}
$BuildDir = Join-Path $Root $BuildDirectoryName

cmake -S $Root -B $BuildDir -A $CMakeArchitecture -DBUILD_TESTING=ON
if ($LASTEXITCODE -ne 0) { throw "CMake configuration failed." }

cmake --build $BuildDir --config Release
if ($LASTEXITCODE -ne 0) { throw "Native TSF build failed." }

if (!$SkipTests) {
  ctest --test-dir $BuildDir -C Release --output-on-failure
  if ($LASTEXITCODE -ne 0) { throw "Native TSF protocol tests failed." }
}

$Dll = Join-Path $BuildDir "bin\Release\LekhTextService.dll"
if (!(Test-Path -LiteralPath $Dll -PathType Leaf)) {
  throw "Expected TSF DLL not found: $Dll"
}
$Broker = Join-Path $BuildDir "bin\Release\LekhPipeBroker.exe"
if (!(Test-Path -LiteralPath $Broker -PathType Leaf)) {
  throw "Expected named-pipe broker not found: $Broker"
}

Write-Host "Built and verified $Dll and $Broker"
