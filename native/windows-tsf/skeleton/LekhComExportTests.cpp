#include "Guids.h"

#include <objbase.h>
#include <windows.h>

#include <array>
#include <iostream>

namespace {

using DllGetClassObjectFunction = HRESULT(STDAPICALLTYPE*)(REFCLSID, REFIID, void**);

int fail(const char* message) {
  std::cerr << message << '\n';
  return 1;
}

} // namespace

int wmain(int argumentCount, wchar_t** arguments) {
  if (argumentCount != 2 || !arguments[1] || arguments[1][0] == L'\0') {
    return fail("Expected the built LekhTextService DLL path.");
  }

  const HMODULE module = LoadLibraryExW(
    arguments[1],
    nullptr,
    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32
  );
  if (!module) return fail("Could not load the built LekhTextService DLL.");

  constexpr std::array<const char*, 4> requiredExports = {
    "DllCanUnloadNow",
    "DllGetClassObject",
    "DllRegisterServer",
    "DllUnregisterServer",
  };
  for (const char* exportName : requiredExports) {
    if (!GetProcAddress(module, exportName)) {
      FreeLibrary(module);
      return fail("The LekhTextService DLL is missing a required COM export.");
    }
  }

  const auto getClassObject = reinterpret_cast<DllGetClassObjectFunction>(
    GetProcAddress(module, "DllGetClassObject")
  );
  IClassFactory* factory = nullptr;
  const HRESULT factoryResult = getClassObject(
    CLSID_LekhTextService,
    IID_IClassFactory,
    reinterpret_cast<void**>(&factory)
  );
  if (FAILED(factoryResult) || !factory) {
    FreeLibrary(module);
    return fail("DllGetClassObject did not return the Lekh class factory.");
  }
  factory->Release();

  if (!FreeLibrary(module)) return fail("Could not release the LekhTextService DLL.");
  std::cout << "Lekh TSF COM exports and class factory passed\n";
  return 0;
}
