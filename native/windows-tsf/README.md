# Windows TSF Text Service

This folder contains the Windows Text Services Framework implementation for Lekh Keyboard.

The source now contains an opt-in end-to-end typing vertical slice: safe-context inspection, real daemon sessions, strict IPC decisions, and TSF composition/edit-session application. It is not a production Windows release until it is compiled and exercised on Windows across the native host matrix.

## Build and test on Windows

From a Visual Studio Developer PowerShell with CMake and the Windows SDK installed:

```powershell
cd native\windows-tsf\skeleton
.\build.ps1 -Architecture x64
```

The build treats compiler warnings as errors and runs the portable native protocol tests through CTest. ARM64 can be configured independently:

```powershell
.\build.ps1 -Architecture ARM64
```

For a current-user development registration of the x64 build:

```powershell
.\register-dev.ps1
```

The deterministic TSF typing path is enabled whenever the Lekh input method is active. It consumes a supported key only after the focused context is classified as safe and a daemon session is ready; secure, unknown, failed, and unsupported contexts remain pass-through.

See:

- `skeleton/lekh_tsf_contract.md`
- `skeleton/LekhTextService.cpp`
- `skeleton/TsfEditSession.cpp`
- `skeleton/TsfProtocol.cpp`
- `skeleton/CMakeLists.txt`
