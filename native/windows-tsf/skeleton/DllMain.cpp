#include <windows.h>

HMODULE g_module = nullptr;
long g_objectCount = 0;
long g_lockCount = 0;
long g_pendingDaemonRetirements = 0;

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_module = module;
    DisableThreadLibraryCalls(module);
  }
  return TRUE;
}

STDAPI DllCanUnloadNow() {
  const LONG objects = InterlockedCompareExchange(&g_objectCount, 0, 0);
  const LONG locks = InterlockedCompareExchange(&g_lockCount, 0, 0);
  const LONG retirements = InterlockedCompareExchange(&g_pendingDaemonRetirements, 0, 0);
  return (objects == 0 && locks == 0 && retirements == 0) ? S_OK : S_FALSE;
}
