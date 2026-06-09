#include <windows.h>

HMODULE g_module = nullptr;
long g_objectCount = 0;
long g_lockCount = 0;

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_module = module;
    DisableThreadLibraryCalls(module);
  }
  return TRUE;
}

STDAPI DllCanUnloadNow() {
  return (g_objectCount == 0 && g_lockCount == 0) ? S_OK : S_FALSE;
}
