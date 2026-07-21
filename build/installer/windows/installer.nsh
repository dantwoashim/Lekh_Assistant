!macro customInstall
  DetailPrint "Configuring Lekh Keyboard Companion."
  IfFileExists "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll" lekh_tsf_dll_found
    DetailPrint "Required Lekh TSF DLL is missing; refusing a companion-only keyboard install."
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not be installed because its native Windows text service is missing. Rebuild the installer and try again."
    Abort

  lekh_tsf_dll_found:
    IfFileExists "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhPipeBroker.exe" lekh_pipe_broker_found
      DetailPrint "Required Lekh named-pipe broker is missing; refusing an unprotected keyboard install."
      MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not be installed because its secure native IPC broker is missing. Rebuild the installer and try again."
      Abort

  lekh_pipe_broker_found:
    DetailPrint "Registering Lekh TSF text service."
    ClearErrors
    ExecWait 'regsvr32.exe /s "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll"' $0
    IfErrors lekh_tsf_registration_failed
    IntCmp $0 0 lekh_tsf_registration_complete lekh_tsf_registration_failed lekh_tsf_registration_failed

  lekh_tsf_registration_failed:
    DetailPrint "Lekh TSF registration failed with exit code $0; aborting installation."
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not register its native Windows text service. No working keyboard was installed."
    Abort

  lekh_tsf_registration_complete:
    DetailPrint "Lekh TSF text service registered successfully."

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion" '"$INSTDIR\Lekh Keyboard Companion.exe" --background'

  DetailPrint "Starting the Lekh keyboard service in the background."
  ClearErrors
  Exec '"$INSTDIR\Lekh Keyboard Companion.exe" --background'
  IfErrors lekh_companion_start_failed lekh_companion_started

  lekh_companion_start_failed:
    DetailPrint "Lekh background service could not be started; rolling back native registration."
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion"
    ExecWait 'regsvr32.exe /u /s "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll"'
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard was installed but its background typing service could not start. Installation was rolled back."
    Abort

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
    ExecWait 'regsvr32.exe /u /s "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll"' $0
    DetailPrint "Lekh TSF unregister exit code: $0"
!macroend
