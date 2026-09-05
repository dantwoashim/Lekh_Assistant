param(
  [string]$InstallerPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Clsid = "{3F04E1EA-7D90-47E1-865B-11D6F13D0301}"
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$RunnerTemp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$TestRoot = Join-Path $RunnerTemp "LekhV1InstallerTest"
$InstallDirectory = Join-Path $TestRoot "App"
$CompanionPath = Join-Path $InstallDirectory "Lekh Keyboard Companion.exe"
$TsfPath = Join-Path $InstallDirectory "resources\native\windows-tsf\build\bin\Release\LekhTextService.dll"
$TsfX86Path = Join-Path $InstallDirectory "resources\native\windows-tsf\build-x86\bin\Release\LekhTextService.dll"
$BrokerPath = Join-Path $InstallDirectory "resources\native\windows-tsf\build\bin\Release\LekhPipeBroker.exe"
$DaemonPath = Join-Path $InstallDirectory "resources\native\daemon\lekh-keyboard-daemon.mjs"
$PhasePath = Join-Path $InstallDirectory ".lekh-install-phase"
$ComKey = "HKLM:\Software\Classes\CLSID\$Clsid"
$InprocKey = Join-Path $ComKey "InprocServer32"
$ComX86Key = "HKLM:\Software\Classes\WOW6432Node\CLSID\$Clsid"
$InprocX86Key = Join-Path $ComX86Key "InprocServer32"
$TipKey = "HKLM:\Software\Microsoft\CTF\TIP\$Clsid"
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"

$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
if (!$Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "The Windows installer lifecycle test must run in an elevated PowerShell session."
}

foreach ($existingKey in @($ComKey, $ComX86Key, $TipKey)) {
  if (Test-Path -LiteralPath $existingKey) {
    throw "Refusing to overwrite an existing Lekh installation during lifecycle testing: $existingKey"
  }
}
$ExistingRunValue = Get-ItemProperty -LiteralPath $RunKey -Name "LekhKeyboardCompanion" -ErrorAction SilentlyContinue
if ($ExistingRunValue) {
  throw "Refusing to overwrite an existing Lekh run-at-sign-in registration during lifecycle testing."
}

if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
  $Installer = Get-ChildItem -LiteralPath (Join-Path $RepositoryRoot "release") -Recurse -File |
    Where-Object { $_.Name -match "Setup.*\.exe$" } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if (!$Installer) { throw "No Windows Setup executable was found in release/." }
  $InstallerPath = $Installer.FullName
}
$InstallerPath = [System.IO.Path]::GetFullPath($InstallerPath)
if (!(Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
  throw "Windows installer does not exist: $InstallerPath"
}
if (Test-Path -LiteralPath $TestRoot) {
  throw "Refusing to reuse a non-empty installer test target: $TestRoot"
}
New-Item -ItemType Directory -Path $TestRoot | Out-Null

function Invoke-CheckedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [int]$TimeoutSeconds = 60
  )
  # Start-Process -Wait follows the complete descendant process tree on
  # Windows. The installer intentionally launches a long-lived companion, so
  # wait only for the installer or uninstaller process itself.
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru
  if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
    Write-Host "DIAGNOSTICS: process $($process.Id) did not exit."
    Write-InstallerDiagnostics
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    $process.WaitForExit()
    throw "$FilePath did not exit within $TimeoutSeconds seconds."
  }
  if ($process.ExitCode -ne 0) {
    Write-Host "DIAGNOSTICS: process $($process.Id) exited with code $($process.ExitCode)."
    Write-InstallerDiagnostics
    throw "$FilePath exited with code $($process.ExitCode)."
  }
}

function Write-InstallerDiagnostics {
  if (Test-Path -LiteralPath $PhasePath -PathType Leaf) {
    Write-Host "DIAGNOSTICS: installerPhase=$(Get-Content -LiteralPath $PhasePath -Raw)"
  }
  foreach ($path in @($InstallDirectory, $CompanionPath, $TsfPath, $BrokerPath, $DaemonPath)) {
    Write-Host "DIAGNOSTICS: exists=$([bool](Test-Path -LiteralPath $path)) path=$path"
  }
  foreach ($key in @($InprocKey, $TipKey, $RunKey)) {
    Write-Host "DIAGNOSTICS: registryExists=$([bool](Test-Path -LiteralPath $key)) key=$key"
  }
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match "Lekh|Uninstall|Setup|regsvr32" } |
    ForEach-Object { Write-Host "DIAGNOSTICS: process=$($_.ProcessName) pid=$($_.Id)" }
}

function Wait-Until {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Condition,
    [Parameter(Mandatory = $true)][string]$FailureMessage,
    [int]$TimeoutSeconds = 15
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw $FailureMessage
}

function Get-InstalledProcesses {
  $prefix = [System.IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\') + '\'
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  })
}

function Get-PeMachine {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  $reader = [System.IO.BinaryReader]::new($stream)
  try {
    if ($reader.ReadUInt16() -ne 0x5A4D) { throw "Not a PE image: $Path" }
    $stream.Position = 0x3C
    $peOffset = $reader.ReadUInt32()
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw "Invalid PE signature: $Path" }
    return $reader.ReadUInt16()
  } finally {
    $reader.Dispose()
    $stream.Dispose()
  }
}

function Invoke-PipeJsonRequest {
  param(
    [Parameter(Mandatory = $true)][string]$PipeName,
    [Parameter(Mandatory = $true)][string]$ClientInstanceId,
    [Parameter(Mandatory = $true)][long]$Sequence,
    [Parameter(Mandatory = $true)][string]$Type,
    [Parameter(Mandatory = $true)]$Payload,
    [Parameter(Mandatory = $true)][int]$DeadlineMilliseconds,
    [int]$ConnectTimeoutMilliseconds = 1000,
    [int]$ReadTimeoutMilliseconds = 6000
  )
  $encoding = [System.Text.UTF8Encoding]::new($false)
  $sentAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $requestId = "installer-$($Type.Replace('.', '-'))-$Sequence"
  $request = [ordered]@{
    id = $requestId
    type = $Type
    version = 2
    sentAt = $sentAt
    deadlineAt = $sentAt + $DeadlineMilliseconds
    clientInstanceId = $ClientInstanceId
    requestSequence = $Sequence
    payload = $Payload
  } | ConvertTo-Json -Compress -Depth 12
  # The complete frame is ready before Connect, so a newly exposed broker
  # listener receives its first request immediately.
  $requestBytes = $encoding.GetBytes($request + "`n")
  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
    ".",
    $PipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    [System.IO.Pipes.PipeOptions]::None
  )
  $reader = $null
  $started = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $pipe.Connect($ConnectTimeoutMilliseconds)
    $pipe.Write($requestBytes, 0, $requestBytes.Length)
    $pipe.Flush()
    $reader = [System.IO.StreamReader]::new($pipe, $encoding, $false, 4096, $true)
    $read = $reader.ReadLineAsync()
    if (!$read.Wait([TimeSpan]::FromMilliseconds($ReadTimeoutMilliseconds))) {
      throw "Timed out waiting for $Type response."
    }
    $responseLine = $read.Result
    if ([string]::IsNullOrWhiteSpace($responseLine)) {
      throw "The broker closed its pipe without a $Type response."
    }
    $response = $responseLine | ConvertFrom-Json
    if ($response.id -ne $requestId -or $response.type -ne $Type -or
        $response.version -ne 2 -or $response.ok -ne $true -or
        [long]$response.requestSequence -ne $Sequence) {
      throw "Invalid $Type response: $responseLine"
    }
    return [pscustomobject]@{
      Response = $response
      ResponseLine = $responseLine
      ElapsedMilliseconds = $started.ElapsedMilliseconds
    }
  } finally {
    $started.Stop()
    if ($reader) { $reader.Dispose() }
    $pipe.Dispose()
  }
}

function Invoke-DaemonHealthCheck {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $pipeName = "LekhKeyboard-$sid"
  $clientInstanceId = "windows-installer-cold-$([Guid]::NewGuid().ToString('N'))"

  # Kill the installer-launched companion, broker, and bundled runtime. Starting
  # the installed broker directly below therefore exercises a genuinely cold
  # daemon and engine, not a pre-warmed process inherited from installation.
  Get-InstalledProcesses | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Wait-Until -Condition { @(Get-InstalledProcesses).Count -eq 0 } `
    -FailureMessage "Installed Lekh processes did not stop before the cold-start test."

  $broker = Start-Process -FilePath $BrokerPath -PassThru -WindowStyle Hidden
  $coldStarted = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(30)
    $lastFailure = "No connection attempt completed."
    $negotiation = $null
    do {
      try {
        $negotiation = Invoke-PipeJsonRequest `
          -PipeName $pipeName `
          -ClientInstanceId $clientInstanceId `
          -Sequence 1 `
          -Type "protocol.negotiate" `
          -Payload ([ordered]@{ client = "windows-tsf"; supportedVersions = @(2) }) `
          -DeadlineMilliseconds 5000 `
          -ConnectTimeoutMilliseconds 500 `
          -ReadTimeoutMilliseconds 5500
        break
      } catch {
        $lastFailure = $_.Exception.Message
        Start-Sleep -Milliseconds 100
      }
    } while ([DateTime]::UtcNow -lt $readyDeadline -and !$broker.HasExited)
    if (!$negotiation) {
      throw "The cold broker did not expose a warmed public listener within 30 seconds. Last failure: $lastFailure"
    }
    $serverInstanceId = [string]$negotiation.Response.payload.serverInstanceId
    if ([string]::IsNullOrWhiteSpace($serverInstanceId) -or
        $negotiation.Response.payload.selectedVersion -ne 2) {
      throw "Cold-start negotiation was not bound to a valid server instance."
    }

    $health = Invoke-PipeJsonRequest `
      -PipeName $pipeName `
      -ClientInstanceId $clientInstanceId `
      -Sequence 2 `
      -Type "health.check" `
      -Payload ([ordered]@{ client = "windows-tsf" }) `
      -DeadlineMilliseconds 5000
    if ($health.Response.serverInstanceId -ne $serverInstanceId -or
        $health.Response.payload.engineReady -ne $true) {
      throw "The public listener opened before the engine reported ready."
    }

    $typingContext = [ordered]@{
      fieldType = "normal"
      leftTextWindow = ""
      rightTextWindow = ""
      locale = "ne-NP"
      activeDomains = @()
      preserveEnglish = $true
      secureInput = $false
      mode = "romanized-traditional"
      layoutId = "lekh-romanized"
      enabledSurfaces = @("romanized-to-unicode")
      showRomanizedLabels = $true
      enablePersonalization = $false
      enableNextWordPrediction = $true
    }
    $begin = Invoke-PipeJsonRequest `
      -PipeName $pipeName `
      -ClientInstanceId $clientInstanceId `
      -Sequence 3 `
      -Type "session.begin" `
      -Payload ([ordered]@{ context = $typingContext }) `
      -DeadlineMilliseconds 50 `
      -ReadTimeoutMilliseconds 250
    if ($begin.Response.serverInstanceId -ne $serverInstanceId) {
      throw "session.begin changed server identity after negotiation."
    }
    $sessionId = [string]$begin.Response.payload.sessionId
    $sessionEpoch = [long]$begin.Response.payload.sessionEpoch
    if ([string]::IsNullOrWhiteSpace($sessionId) -or $sessionEpoch -lt 1 -or
        [long]$begin.Response.sessionEpoch -ne $sessionEpoch) {
      throw "session.begin returned an invalid bound session."
    }

    $keySentAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $keyResult = Invoke-PipeJsonRequest `
      -PipeName $pipeName `
      -ClientInstanceId $clientInstanceId `
      -Sequence 4 `
      -Type "session.processKeyStroke" `
      -Payload ([ordered]@{
        sessionId = $sessionId
        sessionEpoch = $sessionEpoch
        key = [ordered]@{
          key = "n"
          code = "KeyN"
          modifiers = [ordered]@{ shift = $false; ctrl = $false; alt = $false; meta = $false }
          isRepeat = $false
          timestamp = $keySentAt
          platform = "windows-tsf"
          nativeCode = 78
        }
      }) `
      -DeadlineMilliseconds 50 `
      -ReadTimeoutMilliseconds 250
    $keyPayload = $keyResult.Response.payload
    if ($keyResult.Response.serverInstanceId -ne $serverInstanceId -or
        [long]$keyResult.Response.sessionEpoch -ne $sessionEpoch -or
        $keyPayload.sessionId -ne $sessionId -or
        $keyPayload.action -ne "compose" -or
        $keyPayload.compositionText -ne "n" -or
        ([string]$keyPayload.displayText) -notmatch "[\u0900-\u097F]") {
      throw "The first warmed 50 ms process-key response was not a bound Devanagari composition: $($keyResult.ResponseLine)"
    }

    [void](Invoke-PipeJsonRequest `
      -PipeName $pipeName `
      -ClientInstanceId $clientInstanceId `
      -Sequence 5 `
      -Type "session.end" `
      -Payload ([ordered]@{ sessionId = $sessionId; sessionEpoch = $sessionEpoch }) `
      -DeadlineMilliseconds 5000)

    Write-Host "SERVICE CHECK: cold listener ready in $($coldStarted.ElapsedMilliseconds) ms; first valid hot-path response in $($keyResult.ElapsedMilliseconds) ms."
  } finally {
    $coldStarted.Stop()
    if (!$broker.HasExited) {
      Stop-Process -Id $broker.Id -Force -ErrorAction SilentlyContinue
      $broker.WaitForExit(5000) | Out-Null
    }
    Wait-Until -Condition { @(Get-InstalledProcesses).Count -eq 0 } `
      -FailureMessage "Cold-start broker or daemon remained after the service check."
  }
}

try {
  Write-Host "INSTALL: running the unsigned NSIS artifact silently."
  Invoke-CheckedProcess -FilePath $InstallerPath -Arguments @("/S", "/allusers", "/D=$InstallDirectory")

  foreach ($required in @($CompanionPath, $TsfPath, $TsfX86Path, $BrokerPath, $DaemonPath)) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Installed artifact is missing: $required"
    }
  }

  if ((Get-PeMachine -Path $TsfPath) -ne 0x8664) {
    throw "The primary installed TSF DLL is not x64."
  }
  if ((Get-PeMachine -Path $TsfX86Path) -ne 0x014C) {
    throw "The compatibility installed TSF DLL is not x86."
  }

  Wait-Until -Condition { Test-Path -LiteralPath $InprocKey } `
    -FailureMessage "The installer did not create the machine-wide COM registration."
  $registeredPath = (Get-Item -LiteralPath $InprocKey).GetValue("")
  if (![StringComparer]::OrdinalIgnoreCase.Equals(
      [System.IO.Path]::GetFullPath([string]$registeredPath),
      [System.IO.Path]::GetFullPath($TsfPath)
    )) {
    throw "COM registration points to an unexpected DLL: $registeredPath"
  }
  Wait-Until -Condition { Test-Path -LiteralPath $InprocX86Key } `
    -FailureMessage "The installer did not create the 32-bit COM registration."
  $registeredX86Path = (Get-Item -LiteralPath $InprocX86Key).GetValue("")
  if (![StringComparer]::OrdinalIgnoreCase.Equals(
      [System.IO.Path]::GetFullPath([string]$registeredX86Path),
      [System.IO.Path]::GetFullPath($TsfX86Path)
    )) {
    throw "32-bit COM registration points to an unexpected DLL: $registeredX86Path"
  }
  Wait-Until -Condition { Test-Path -LiteralPath $TipKey } `
    -FailureMessage "The installer did not register the TSF input profile."

  $runValue = (Get-ItemProperty -LiteralPath $RunKey -Name "LekhKeyboardCompanion").LekhKeyboardCompanion
  $expectedRunValue = '"' + $CompanionPath + '" --background'
  if ($runValue -ne $expectedRunValue) {
    throw "The startup command is not the background companion command: $runValue"
  }
  Write-Host "INSTALL: artifacts, COM, TSF, and startup entry verified."

  Invoke-DaemonHealthCheck
  Write-Host "INSTALL: TSF registration and installed artifacts verified."

  $Uninstaller = Get-ChildItem -LiteralPath $InstallDirectory -File |
    Where-Object { $_.Name -match "^Uninstall.*\.exe$" } |
    Select-Object -First 1
  if (!$Uninstaller) { throw "The installed NSIS uninstaller was not found." }

  Write-Host "UNINSTALL: running the installed uninstaller silently."
  Invoke-CheckedProcess -FilePath $Uninstaller.FullName -Arguments @("/S")

  Wait-Until -Condition { !(Test-Path -LiteralPath $InstallDirectory) } `
    -FailureMessage "The installation directory remained after uninstall."
  Wait-Until -Condition { @(Get-InstalledProcesses).Count -eq 0 } `
    -FailureMessage "Installed Lekh processes remained after uninstall."
  if (Test-Path -LiteralPath $ComKey) { throw "COM registration remained after uninstall." }
  if (Test-Path -LiteralPath $ComX86Key) { throw "32-bit COM registration remained after uninstall." }
  if (Test-Path -LiteralPath $TipKey) { throw "TSF profile registration remained after uninstall." }
  $remainingRunValue = Get-ItemProperty -LiteralPath $RunKey -Name "LekhKeyboardCompanion" -ErrorAction SilentlyContinue
  if ($remainingRunValue) { throw "The Lekh startup command remained after uninstall." }

  Write-Host "CLEAN: files, processes, startup entry, COM registration, and TSF profile were removed."
  Remove-Item -LiteralPath $TestRoot -Force
} finally {
  if (Test-Path -LiteralPath $InstallDirectory) {
    $FallbackUninstaller = Get-ChildItem -LiteralPath $InstallDirectory -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "^Uninstall.*\.exe$" } |
      Select-Object -First 1
    if ($FallbackUninstaller) {
      Start-Process -FilePath $FallbackUninstaller.FullName -ArgumentList "/S" -Wait -ErrorAction SilentlyContinue
    }
  }
}
