#include "Guids.h"

#include <objbase.h>
#include <windows.h>

#include <iostream>

namespace {

using RegistrationFunction = HRESULT(STDAPICALLTYPE*)();

int fail(const char* message, HRESULT result = E_FAIL) {
  std::cerr << message << " HRESULT=0x" << std::hex
            << static_cast<unsigned long>(result) << '\n';
  return 1;
}

} // namespace

int wmain(int argumentCount, wchar_t** arguments) {
  if (argumentCount != 2 || !arguments[1] || arguments[1][0] == L'\0') {
    return fail("Expected the built LekhTextService DLL path.");
  }
  const HRESULT initializeResult = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(initializeResult)) return fail("COM initialization failed.", initializeResult);

  const HMODULE module = LoadLibraryExW(
    arguments[1],
    nullptr,
    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32
  );
  if (!module) {
    CoUninitialize();
    return fail("Could not load the built LekhTextService DLL.", HRESULT_FROM_WIN32(GetLastError()));
  }
  const auto registerServer = reinterpret_cast<RegistrationFunction>(
    GetProcAddress(module, "DllRegisterServer")
  );
  const auto unregisterServer = reinterpret_cast<RegistrationFunction>(
    GetProcAddress(module, "DllUnregisterServer")
  );
  if (!registerServer || !unregisterServer) {
    FreeLibrary(module);
    CoUninitialize();
    return fail("Registration exports are unavailable.");
  }

  const HRESULT registrationResult = registerServer();
  if (FAILED(registrationResult)) {
    FreeLibrary(module);
    CoUninitialize();
    return fail("Architecture-matched TSF registration failed.", registrationResult);
  }

  IClassFactory* factory = nullptr;
  const HRESULT activationResult = CoGetClassObject(
    CLSID_LekhTextService,
    CLSCTX_INPROC_SERVER,
    nullptr,
    IID_IClassFactory,
    reinterpret_cast<void**>(&factory)
  );
  if (factory) factory->Release();

  const HRESULT unregistrationResult = unregisterServer();
  FreeLibrary(module);
  CoUninitialize();
  if (FAILED(activationResult)) {
    return fail("COM could not activate the registered Lekh class factory.", activationResult);
  }
  if (FAILED(unregistrationResult)) {
    return fail("TSF unregistration did not prove complete cleanup.", unregistrationResult);
  }
  std::cout << "Lekh TSF registration, COM activation, and cleanup passed\n";
  return 0;
}
