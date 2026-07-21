#include "Guids.h"

#include <objbase.h>
#include <windows.h>

#include <cstdlib>
#include <iostream>

namespace {

using DllCanUnloadNowFunction = HRESULT(STDAPICALLTYPE*)();
using DllGetClassObjectFunction = HRESULT(STDAPICALLTYPE*)(REFCLSID, REFIID, void**);

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

} // namespace

int wmain(int argc, wchar_t** argv) {
  require(argc == 2 && argv[1] && argv[1][0] != L'\0', "expected the built TSF DLL path");

  HMODULE module = LoadLibraryW(argv[1]);
  require(module != nullptr, "failed to load the built TSF DLL");

  const auto canUnload = reinterpret_cast<DllCanUnloadNowFunction>(
    GetProcAddress(module, "DllCanUnloadNow")
  );
  const auto getClassObject = reinterpret_cast<DllGetClassObjectFunction>(
    GetProcAddress(module, "DllGetClassObject")
  );
  require(canUnload != nullptr && getClassObject != nullptr, "COM lifetime exports are missing");
  require(canUnload() == S_OK, "freshly loaded TSF DLL unexpectedly reported a live object");

  IClassFactory* factory = nullptr;
  const HRESULT factoryResult = getClassObject(
    CLSID_LekhTextService,
    IID_IClassFactory,
    reinterpret_cast<void**>(&factory)
  );
  require(SUCCEEDED(factoryResult) && factory != nullptr, "failed to create the Lekh COM class factory");
  require(
    canUnload() == S_FALSE,
    "TSF DLL reported unloadable while its COM class factory still had a live reference"
  );

  factory->Release();
  require(canUnload() == S_OK, "TSF DLL remained locked after releasing the COM class factory");
  FreeLibrary(module);

  std::cout << "Windows COM server lifetime tests passed\n";
  return 0;
}
