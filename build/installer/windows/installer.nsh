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

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion" "$INSTDIR\Lekh Keyboard Companion.exe"
!macroend

!macro customUnInstall
  DetailPrint "Removing Lekh Keyboard startup entry."
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion"

  IfFileExists "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll" 0 +3
    DetailPrint "Unregistering Lekh TSF text service."
    ExecWait 'regsvr32.exe /u /s "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll"'
!macroend
