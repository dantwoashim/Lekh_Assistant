!macro lekhInstallPhase value
  FileOpen $R9 "$INSTDIR\.lekh-install-phase" w
  FileWrite $R9 "${value}"
  FileClose $R9
!macroend

!macro customCheckAppRunning
  ; electron-builder's default assisted-installer check queries Win32_Process
  ; through PowerShell/WMI. That can block indefinitely on headless Windows
  ; hosts, so use the bundled native process plugin instead.
  nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
  Pop $R0
  nsProcess::_FindProcess /NOUNLOAD "LekhPipeBroker.exe"
  Pop $R1
  ${If} $R0 == 0
  ${OrIf} $R1 == 0
    DetailPrint "Stopping the existing Lekh keyboard service before installation."
    nsProcess::_CloseProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
    Pop $R2
    Sleep 1500
    nsProcess::_KillProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
    Pop $R2
    nsProcess::_KillProcess /NOUNLOAD "LekhPipeBroker.exe"
    Pop $R2
    Sleep 500
    nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    nsProcess::_FindProcess /NOUNLOAD "LekhPipeBroker.exe"
    Pop $R1
    ${If} $R0 == 0
    ${OrIf} $R1 == 0
      nsProcess::_Unload
      MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard is still running. Quit it and run the installer again." /SD IDOK
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}
  nsProcess::_Unload
!macroend

!macro customInstall
  !insertmacro lekhInstallPhase "custom-install-started"
  DetailPrint "Configuring Lekh Keyboard Companion."
  IfFileExists "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll" lekh_tsf_dll_found
    DetailPrint "Required Lekh TSF DLL is missing; refusing a companion-only keyboard install."
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not be installed because its native Windows text service is missing. Rebuild the installer and try again." /SD IDOK
    SetErrorLevel 1
    Quit

  lekh_tsf_dll_found:
    IfFileExists "$INSTDIR\resources\native\windows-tsf\build-x86\bin\Release\LekhTextService.dll" lekh_x86_tsf_dll_found
      DetailPrint "Required 32-bit Lekh TSF DLL is missing; 32-bit applications would not support the keyboard."
      MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not be installed because its 32-bit Windows text service is missing." /SD IDOK
      SetErrorLevel 1
      Quit

  lekh_x86_tsf_dll_found:
    IfFileExists "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhPipeBroker.exe" lekh_pipe_broker_found
      DetailPrint "Required Lekh named-pipe broker is missing; refusing an unprotected keyboard install."
      MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not be installed because its secure native IPC broker is missing. Rebuild the installer and try again." /SD IDOK
      SetErrorLevel 1
      Quit

  lekh_pipe_broker_found:
    DetailPrint "Registering Lekh TSF text service."
    !insertmacro lekhInstallPhase "registering-tsf"
    ClearErrors
    ; electron-builder's NSIS host is 32-bit. Sysnative reaches the native
    ; 64-bit regsvr32 required by the packaged x64 TSF DLL.
    ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /s "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll"' $0
    IfErrors lekh_tsf_registration_failed
    !insertmacro lekhInstallPhase "register-tsf-exit-$0"
    IntCmp $0 0 lekh_tsf_registration_complete lekh_tsf_registration_failed lekh_tsf_registration_failed

  lekh_tsf_registration_failed:
    DetailPrint "Lekh TSF registration failed with exit code $0; aborting installation."
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not register its native Windows text service. No working keyboard was installed." /SD IDOK
    SetErrorLevel 1
    Quit

  lekh_tsf_registration_complete:
    DetailPrint "Registering 32-bit Lekh TSF support for legacy Windows applications."
    ClearErrors
    ExecWait '"$WINDIR\SysWOW64\regsvr32.exe" /s "$INSTDIR\resources\native\windows-tsf\build-x86\bin\Release\LekhTextService.dll"' $1
    IfErrors lekh_x86_tsf_registration_failed
    !insertmacro lekhInstallPhase "register-x86-tsf-exit-$1"
    IntCmp $1 0 lekh_all_tsf_registration_complete lekh_x86_tsf_registration_failed lekh_x86_tsf_registration_failed

  lekh_x86_tsf_registration_failed:
    DetailPrint "32-bit Lekh TSF registration failed with exit code $1; rolling back 64-bit registration."
    ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /u /s "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll"'
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not register support for 32-bit Windows applications. Installation was rolled back." /SD IDOK
    SetErrorLevel 1
    Quit

  lekh_all_tsf_registration_complete:
    !insertmacro lekhInstallPhase "tsf-registered"
    DetailPrint "Lekh 64-bit and 32-bit TSF text services registered successfully."

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion" '"$INSTDIR\Lekh Keyboard Companion.exe" --background'

  DetailPrint "Starting the Lekh keyboard service in the background."
  !insertmacro lekhInstallPhase "starting-companion"
  ClearErrors
  ; The installer is elevated for machine-wide TSF registration. Launch the
  ; companion through electron-builder's original-user UAC bridge so the
  ; per-user pipe, preferences, and startup process belong to the desktop user.
  !insertmacro UAC_AsUser_ExecShell "" "$INSTDIR\Lekh Keyboard Companion.exe" "--background" "$INSTDIR" SW_HIDE
    IfErrors lekh_companion_start_failed
    !insertmacro lekhInstallPhase "start-companion-requested"
    Goto lekh_wait_for_runtime

  lekh_wait_for_runtime:
    StrCpy $2 0
  lekh_runtime_probe:
    Sleep 500
    nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
    Pop $3
    nsProcess::_FindProcess /NOUNLOAD "LekhPipeBroker.exe"
    Pop $4
    ${If} $3 == 0
    ${AndIf} $4 == 0
      nsProcess::_Unload
      Goto lekh_companion_started
    ${EndIf}
    IntOp $2 $2 + 1
    IntCmp $2 20 lekh_runtime_start_failed lekh_runtime_probe lekh_runtime_start_failed

  lekh_runtime_start_failed:
    nsProcess::_Unload
    DetailPrint "Lekh background runtime did not become healthy within 10 seconds."
    Goto lekh_companion_start_failed

  lekh_companion_start_failed:
    DetailPrint "Lekh background service could not be started; rolling back native registration."
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion"
    ExecWait '"$WINDIR\SysWOW64\regsvr32.exe" /u /s "$INSTDIR\resources\native\windows-tsf\build-x86\bin\Release\LekhTextService.dll"'
    ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /u /s "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll"'
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard was installed but its background typing service could not start. Installation was rolled back." /SD IDOK
    SetErrorLevel 1
    Quit

  lekh_companion_started:
    Delete "$INSTDIR\.lekh-install-phase"
    DetailPrint "Lekh keyboard background service started."
!macroend

!macro customUnInstall
  DetailPrint "Stopping Lekh Keyboard processes."
  nsExec::ExecToLog 'taskkill.exe /F /T /IM "Lekh Keyboard Companion.exe"'
  nsExec::ExecToLog 'taskkill.exe /F /IM "LekhPipeBroker.exe"'
  Sleep 500

  DetailPrint "Removing Lekh Keyboard startup entry."
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion"

  IfFileExists "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll" 0 +4
    DetailPrint "Unregistering Lekh TSF text service."
    ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /u /s "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll"' $0
    DetailPrint "Lekh TSF unregister exit code: $0"

  IfFileExists "$INSTDIR\resources\native\windows-tsf\build-x86\bin\Release\LekhTextService.dll" 0 +4
    DetailPrint "Unregistering 32-bit Lekh TSF text service."
    ExecWait '"$WINDIR\SysWOW64\regsvr32.exe" /u /s "$INSTDIR\resources\native\windows-tsf\build-x86\bin\Release\LekhTextService.dll"' $1
    DetailPrint "Lekh 32-bit TSF unregister exit code: $1"
!macroend
