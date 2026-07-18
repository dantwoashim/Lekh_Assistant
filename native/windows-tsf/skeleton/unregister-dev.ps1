$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$X64Dll = Join-Path $Root "build\bin\Release\LekhTextService.dll"
$X86Dll = Join-Path $Root "build-Win32\bin\Release\LekhTextService.dll"
$NativeRegsvr32 = Join-Path $env:WINDIR "Sysnative\regsvr32.exe"
if (!(Test-Path -LiteralPath $NativeRegsvr32 -PathType Leaf)) {
  $NativeRegsvr32 = Join-Path $env:WINDIR "System32\regsvr32.exe"
}
$X86Regsvr32 = Join-Path $env:WINDIR "SysWOW64\regsvr32.exe"

foreach ($RequiredFile in @($X64Dll, $X86Dll, $NativeRegsvr32, $X86Regsvr32)) {
  if (!(Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
    throw "A registered TSF DLL or architecture-specific system registration tool is missing. Rebuild or repair the same paths before unregistering: $RequiredFile"
  }
}

& $X86Regsvr32 /u /s $X86Dll
if ($LASTEXITCODE -ne 0) {
  throw "x86 TSF unregistration failed with regsvr32 exit code $LASTEXITCODE."
}
& $NativeRegsvr32 /u /s $X64Dll
if ($LASTEXITCODE -ne 0) {
  throw "x64 TSF unregistration failed with regsvr32 exit code $LASTEXITCODE. Repair and retry before deleting either DLL."
}
Write-Host "Unregistered Lekh Keyboard x64 and x86 TSF text services."
