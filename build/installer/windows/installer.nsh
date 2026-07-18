!macro customInstall
  DetailPrint "Configuring Lekh Keyboard Companion."
  IfFileExists "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll" lekh_tsf_x64_dll_found
    DetailPrint "Required x64 Lekh TSF DLL is missing; refusing a partial keyboard install."
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not be installed because its x64 Windows text service is missing. Rebuild the installer and try again."
    Abort

  lekh_tsf_x64_dll_found:
    IfFileExists "$INSTDIR\resources\native\windows-tsf\build-Win32\bin\Release\LekhTextService.dll" lekh_tsf_x86_dll_found
      DetailPrint "Required x86 Lekh TSF DLL is missing; refusing a partial keyboard install."
      MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not be installed because its x86 Windows text service is missing. Rebuild the installer and try again."
      Abort

  lekh_tsf_x86_dll_found:
    IfFileExists "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhPipeBroker.exe" lekh_pipe_broker_found
      DetailPrint "Required Lekh named-pipe broker is missing; refusing an unprotected keyboard install."
      MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not be installed because its secure native IPC broker is missing. Rebuild the installer and try again."
      Abort

  lekh_pipe_broker_found:
    IfFileExists "$WINDIR\Sysnative\regsvr32.exe" lekh_native_regsvr32_found
      MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard requires 64-bit Windows and could not locate the native system registration tool."
      Abort

  lekh_native_regsvr32_found:
    IfFileExists "$WINDIR\SysWOW64\regsvr32.exe" lekh_x86_regsvr32_found
      MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not locate the 32-bit system registration tool required by 32-bit applications."
      Abort

  lekh_x86_regsvr32_found:
    ClearErrors
    ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion"
    IfErrors lekh_startup_slot_available
    StrCmp $1 '$\"$INSTDIR\Lekh Keyboard Companion.exe$\" --background' lekh_startup_slot_owned lekh_startup_slot_conflict

  lekh_startup_slot_conflict:
    DetailPrint "A different application already owns the Lekh companion startup value."
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard found a conflicting background startup entry and will not overwrite it. Remove or repair the older installation, then try again."
    Abort

  lekh_startup_slot_available:
    StrCpy $2 "created"
    ClearErrors
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion" '$\"$INSTDIR\Lekh Keyboard Companion.exe$\" --background'
    IfErrors lekh_startup_registration_failed
    ClearErrors
    ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion"
    IfErrors lekh_startup_registration_failed
    StrCmp $1 '$\"$INSTDIR\Lekh Keyboard Companion.exe$\" --background' lekh_tsf_x64_registration_started lekh_startup_registration_failed

  lekh_startup_slot_owned:
    StrCpy $2 "existing"

  lekh_tsf_x64_registration_started:
    DetailPrint "Registering the x64 Lekh TSF text service with the native system loader."
    ClearErrors
    StrCpy $0 -1
    ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /s "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll"' $0
    IfErrors lekh_tsf_x64_registration_failed
    IntCmp $0 0 lekh_tsf_x86_registration_started lekh_tsf_x64_registration_failed lekh_tsf_x64_registration_failed

  lekh_tsf_x64_registration_failed:
    DetailPrint "x64 Lekh TSF registration failed with exit code $0; preserving startup and native files for a safe repair."
    Goto lekh_tsf_registration_abort

  lekh_tsf_x86_registration_started:
    DetailPrint "Registering the x86 Lekh TSF text service with the 32-bit system loader."
    ClearErrors
    StrCpy $0 -1
    ExecWait '"$WINDIR\SysWOW64\regsvr32.exe" /s "$INSTDIR\resources\native\windows-tsf\build-Win32\bin\Release\LekhTextService.dll"' $0
    IfErrors lekh_tsf_x86_registration_failed
    IntCmp $0 0 lekh_tsf_registration_complete lekh_tsf_x86_registration_failed lekh_tsf_x86_registration_failed

  lekh_tsf_x86_registration_failed:
    DetailPrint "x86 Lekh TSF registration failed with exit code $0; preserving the x64 registration, startup, and native files for a safe repair."
    Goto lekh_tsf_registration_abort

  lekh_tsf_registration_complete:
    DetailPrint "Lekh x64 and x86 TSF text services registered successfully."
    Goto lekh_install_configuration_complete

  lekh_startup_registration_failed:
    DetailPrint "Lekh companion startup registration failed before TSF registration."

  lekh_remove_new_startup_entry:
    ClearErrors
    ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion"
    IfErrors lekh_tsf_registration_abort
    StrCmp $1 '$\"$INSTDIR\Lekh Keyboard Companion.exe$\" --background' 0 lekh_tsf_registration_abort
    ClearErrors
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion"
    IfErrors lekh_startup_cleanup_failed
    Goto lekh_tsf_registration_abort

  lekh_startup_cleanup_failed:
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not clean up the newly created background startup entry. Installation will stop while preserving the files required for a safe repair."
    Abort

  lekh_tsf_registration_abort:
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not complete its per-user startup and text-service registration. Installation will stop while preserving the native files required to repair or safely remove any partial state."
    Abort

  lekh_install_configuration_complete:
!macroend

!macro customUnInstall
  IfFileExists "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll" lekh_tsf_x64_uninstall_dll_found
    DetailPrint "The registered x64 Lekh TSF DLL is missing; refusing to leave an unverifiable partial uninstall."
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard's x64 text-service DLL is missing. Repair or reinstall the same version first, then uninstall again."
    Abort

  lekh_tsf_x64_uninstall_dll_found:
    IfFileExists "$INSTDIR\resources\native\windows-tsf\build-Win32\bin\Release\LekhTextService.dll" lekh_tsf_x86_uninstall_dll_found
      DetailPrint "The registered x86 Lekh TSF DLL is missing; refusing to leave an unverifiable partial uninstall."
      MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard's x86 text-service DLL is missing. Repair or reinstall the same version first, then uninstall again."
      Abort

  lekh_tsf_x86_uninstall_dll_found:
    IfFileExists "$WINDIR\Sysnative\regsvr32.exe" lekh_native_uninstall_regsvr32_found
      MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not locate the native system registration tool, so uninstall cannot continue safely."
      Abort

  lekh_native_uninstall_regsvr32_found:
    IfFileExists "$WINDIR\SysWOW64\regsvr32.exe" lekh_x86_uninstall_regsvr32_found
      MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not locate the 32-bit system registration tool, so uninstall cannot continue safely."
      Abort

  lekh_x86_uninstall_regsvr32_found:
    DetailPrint "Unregistering the x86 Lekh TSF text service."
    ClearErrors
    StrCpy $0 -1
    ExecWait '"$WINDIR\SysWOW64\regsvr32.exe" /u /s "$INSTDIR\resources\native\windows-tsf\build-Win32\bin\Release\LekhTextService.dll"' $0
    IfErrors lekh_tsf_x86_unregistration_failed
    IntCmp $0 0 lekh_tsf_x64_unregistration_started lekh_tsf_x86_unregistration_failed lekh_tsf_x86_unregistration_failed

  lekh_tsf_x86_unregistration_failed:
    DetailPrint "x86 Lekh TSF unregistration failed with exit code $0; preserving the complete installation for a safe retry."
    Goto lekh_tsf_unregistration_failed

  lekh_tsf_x64_unregistration_started:
    DetailPrint "Unregistering the x64 Lekh TSF text service."
    ClearErrors
    StrCpy $0 -1
    ExecWait '"$WINDIR\Sysnative\regsvr32.exe" /u /s "$INSTDIR\resources\native\windows-tsf\build\bin\Release\LekhTextService.dll"' $0
    IfErrors lekh_tsf_x64_unregistration_failed
    IntCmp $0 0 lekh_tsf_unregistration_complete lekh_tsf_x64_unregistration_failed lekh_tsf_x64_unregistration_failed

  lekh_tsf_x64_unregistration_failed:
    DetailPrint "x64 Lekh TSF unregistration failed with exit code $0; preserving the installation for repair and retry."
    Goto lekh_tsf_unregistration_failed

  lekh_tsf_unregistration_failed:
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard could not unregister both Windows text-service architectures. The uninstall will stop so registered DLLs are not removed. Close applications using the keyboard, repair if needed, and try again."
    Abort

  lekh_tsf_unregistration_complete:
    DetailPrint "Removing Lekh Keyboard startup entry."
    ClearErrors
    ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion"
    IfErrors lekh_uninstall_configuration_complete
    StrCmp $1 '$\"$INSTDIR\Lekh Keyboard Companion.exe$\" --background' 0 lekh_startup_value_not_owned
    ClearErrors
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LekhKeyboardCompanion"
    IfErrors lekh_startup_unregistration_failed
    Goto lekh_uninstall_configuration_complete

  lekh_startup_value_not_owned:
    DetailPrint "Preserving a background startup value that is not owned by this installation."
    Goto lekh_uninstall_configuration_complete

  lekh_startup_unregistration_failed:
    MessageBox MB_OK|MB_ICONSTOP "Lekh Keyboard removed its text-service registration but could not remove the background startup entry. The uninstall will stop so it can be retried safely."
    Abort

  lekh_uninstall_configuration_complete:
!macroend
