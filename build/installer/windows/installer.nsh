!macro customInstallMode
  ; Lekh is a per-user TSF input method. Avoid an elevation choice that cannot
  ; make the HKCU text-service registration available to other accounts.
  StrCpy $isForceCurrentInstall "1"
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
  DetailPrint "Configuring Lekh Keyboard Companion."
  IfFileExists "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll" lekh_tsf_dll_found
    DetailPrint "Required Lekh TSF DLL is missing; refusing a companion-only keyboard install."
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not be installed because its native Windows text service is missing. Rebuild the installer and try again." /SD IDOK
    SetErrorLevel 1
    Quit

  lekh_tsf_dll_found:
    IfFileExists "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhPipeBroker.exe" lekh_pipe_broker_found
      DetailPrint "Required Lekh named-pipe broker is missing; refusing an unprotected keyboard install."
      MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not be installed because its secure native IPC broker is missing. Rebuild the installer and try again." /SD IDOK
      SetErrorLevel 1
      Quit

  lekh_pipe_broker_found:
    DetailPrint "Registering Lekh TSF text service."
    ClearErrors
    ; electron-builder's NSIS host is 32-bit. Sysnative reaches the native
    ; 64-bit regsvr32 required by the packaged x64 TSF DLL.
    ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /s "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll"' $0
    IfErrors lekh_tsf_registration_failed
    IntCmp $0 0 lekh_tsf_registration_complete lekh_tsf_registration_failed lekh_tsf_registration_failed

  lekh_tsf_registration_failed:
    DetailPrint "Lekh TSF registration failed with exit code $0; aborting installation."
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not register its native Windows text service. No working keyboard was installed." /SD IDOK
    SetErrorLevel 1
    Quit

  lekh_tsf_registration_complete:
    DetailPrint "Lekh TSF text service registered successfully."

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion" '"$INSTDIR\Lekh Keyboard Companion.exe" --background'

  DetailPrint "Starting the Lekh keyboard service in the background."
  ClearErrors
  ExecWait '"$SYSDIR\cmd.exe" /D /C start "" /B "$INSTDIR\Lekh Keyboard Companion.exe" --background' $0
  IfErrors lekh_companion_start_failed
  IntCmp $0 0 lekh_companion_started lekh_companion_start_failed lekh_companion_start_failed

  lekh_companion_start_failed:
    DetailPrint "Lekh background service could not be started; rolling back native registration."
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion"
    ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /u /s "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll"'
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard was installed but its background typing service could not start. Installation was rolled back." /SD IDOK
    SetErrorLevel 1
    Quit

  lekh_companion_started:
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
!macroend
