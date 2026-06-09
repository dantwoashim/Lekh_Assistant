!macro customInstall
  DetailPrint "Configuring Lekh Keyboard Companion."
  IfFileExists "$INSTDIR\resources\native\windows-tsf\LekhTextService.dll" 0 +4
    DetailPrint "Registering Lekh TSF text service."
    ExecWait 'regsvr32.exe /s "$INSTDIR\resources\native\windows-tsf\LekhTextService.dll"'
    Goto +2
  DetailPrint "Lekh TSF DLL not bundled; companion-only dev install."

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion" "$INSTDIR\Lekh Keyboard Companion.exe"
!macroend

!macro customUnInstall
  DetailPrint "Removing Lekh Keyboard startup entry."
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion"

  IfFileExists "$INSTDIR\resources\native\windows-tsf\LekhTextService.dll" 0 +3
    DetailPrint "Unregistering Lekh TSF text service."
    ExecWait 'regsvr32.exe /u /s "$INSTDIR\resources\native\windows-tsf\LekhTextService.dll"'
!macroend
