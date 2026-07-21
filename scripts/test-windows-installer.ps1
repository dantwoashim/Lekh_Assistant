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
$BrokerPath = Join-Path $InstallDirectory "resources\native\windows-tsf\build\bin\Release\LekhPipeBroker.exe"
$DaemonPath = Join-Path $InstallDirectory "resources\native\daemon\lekh-keyboard-daemon.mjs"
$PhasePath = Join-Path $InstallDirectory ".lekh-install-phase"
$ComKey = "HKLM:\Software\Classes\CLSID\$Clsid"
$InprocKey = Join-Path $ComKey "InprocServer32"
$TipKey = "HKLM:\Software\Microsoft\CTF\TIP\$Clsid"
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"

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

function Invoke-DaemonHealthCheck {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $pipeName = "LekhKeyboard-$sid"
  $sentAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $request = @{
    id = "installer-health-1"
    type = "protocol.negotiate"
    version = 2
    sentAt = $sentAt
    deadlineAt = $sentAt + 5000
    clientInstanceId = "windows-installer-ci"
    requestSequence = 1
    payload = @{
      client = "windows-installer-ci"
      supportedVersions = @(2)
    }
  } | ConvertTo-Json -Compress -Depth 5

  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
    ".",
    $pipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    [System.IO.Pipes.PipeOptions]::None
  )
  try {
    $pipe.Connect(5000)
    $encoding = [System.Text.UTF8Encoding]::new($false)
    $writer = [System.IO.StreamWriter]::new($pipe, $encoding, 1024, $true)
    $reader = [System.IO.StreamReader]::new($pipe, $encoding, $false, 1024, $true)
    try {
      $writer.WriteLine($request)
      $writer.Flush()
      $read = $reader.ReadLineAsync()
      if (!$read.Wait([TimeSpan]::FromSeconds(5))) {
        throw "The installed daemon did not answer its named-pipe health request."
      }
      $responseLine = $read.Result
      if ([string]::IsNullOrWhiteSpace($responseLine)) {
        throw "The installed daemon closed its named pipe without a health response."
      }
      $response = $responseLine | ConvertFrom-Json
      if ($response.id -ne "installer-health-1" -or $response.type -ne "protocol.negotiate" -or
          $response.ok -ne $true -or $response.payload.selectedVersion -ne 2) {
        throw "The installed daemon returned an invalid negotiation response: $responseLine"
      }
      Write-Host "SERVICE CHECK: daemon protocol negotiation passed on $pipeName."
    } finally {
      try { $reader.Dispose() } catch { Write-Host "DIAGNOSTICS: reader cleanup observed a closed pipe." }
      try { $writer.Dispose() } catch { Write-Host "DIAGNOSTICS: writer cleanup observed a closed pipe." }
    }
  } finally {
    try { $pipe.Dispose() } catch { Write-Host "DIAGNOSTICS: pipe cleanup observed a closed pipe." }
  }
}

try {
  Write-Host "INSTALL: running the unsigned NSIS artifact silently."
  Invoke-CheckedProcess -FilePath $InstallerPath -Arguments @("/S", "/allusers", "/D=$InstallDirectory")

  foreach ($required in @($CompanionPath, $TsfPath, $BrokerPath, $DaemonPath)) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Installed artifact is missing: $required"
    }
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
  Wait-Until -Condition { Test-Path -LiteralPath $TipKey } `
    -FailureMessage "The installer did not register the TSF input profile."

  $runValue = (Get-ItemProperty -LiteralPath $RunKey -Name "LekhKeyboardCompanion").LekhKeyboardCompanion
  $expectedRunValue = '"' + $CompanionPath + '" --background'
  if ($runValue -ne $expectedRunValue) {
    throw "The startup command is not the background companion command: $runValue"
  }
  Write-Host "INSTALL: artifacts, COM, TSF, and startup entry verified."

  Wait-Until -Condition {
    (Get-InstalledProcesses | Where-Object { $_.Name -eq "LekhPipeBroker.exe" }).Count -ge 1
  } -FailureMessage "The installed Lekh pipe broker did not stay running."
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
  Wait-Until -Condition { (Get-InstalledProcesses).Count -eq 0 } `
    -FailureMessage "Installed Lekh processes remained after uninstall."
  if (Test-Path -LiteralPath $ComKey) { throw "COM registration remained after uninstall." }
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
