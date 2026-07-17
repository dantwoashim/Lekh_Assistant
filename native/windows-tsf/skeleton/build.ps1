param(
  [ValidateSet("x64", "ARM64")]
  [string]$Architecture = "x64",
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BuildDirectoryName = if ($Architecture -eq "x64") { "build" } else { "build-$Architecture" }
$BuildDir = Join-Path $Root $BuildDirectoryName

cmake -S $Root -B $BuildDir -A $Architecture -DBUILD_TESTING=ON
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

Write-Host "Built and verified $Dll"
