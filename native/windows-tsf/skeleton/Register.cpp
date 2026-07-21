#include "Guids.h"

#include <shlwapi.h>
#include <strsafe.h>
#include <windows.h>

extern HMODULE g_module;

#ifndef RETURN_IF_FAILED
#define RETURN_IF_FAILED(expression) \
  do { \
    const HRESULT _lekh_hr = (expression); \
    if (FAILED(_lekh_hr)) return _lekh_hr; \
  } while (0)
#endif

namespace {

HRESULT initializeComForRegistration(bool* mustUninitialize) {
  if (!mustUninitialize) return E_POINTER;
  *mustUninitialize = false;
  const HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (SUCCEEDED(hr)) {
    *mustUninitialize = true;
    return S_OK;
  }
  // regsvr32 can initialize COM before calling the export. Its apartment is
  // usable even when requesting a different model returns RPC_E_CHANGED_MODE.
  return hr == RPC_E_CHANGED_MODE ? S_OK : hr;
}

HRESULT guidToString(REFGUID guid, wchar_t* output, size_t outputCount) {
  return StringFromGUID2(guid, output, static_cast<int>(outputCount)) > 0 ? S_OK : E_FAIL;
}

HRESULT writeStringValue(HKEY root, const wchar_t* keyPath, const wchar_t* valueName, const wchar_t* value) {
  HKEY key = nullptr;
  const LONG createResult = RegCreateKeyExW(root, keyPath, 0, nullptr, 0, KEY_WRITE, nullptr, &key, nullptr);
  if (createResult != ERROR_SUCCESS) return HRESULT_FROM_WIN32(createResult);
  const LONG setResult = RegSetValueExW(
    key,
    valueName,
    0,
    REG_SZ,
    reinterpret_cast<const BYTE*>(value),
    static_cast<DWORD>((wcslen(value) + 1) * sizeof(wchar_t))
  );
  RegCloseKey(key);
  return setResult == ERROR_SUCCESS ? S_OK : HRESULT_FROM_WIN32(setResult);
}

HRESULT registerComServer() {
  wchar_t clsid[64] = {};
  RETURN_IF_FAILED(guidToString(CLSID_LekhTextService, clsid, ARRAYSIZE(clsid)));

  wchar_t modulePath[MAX_PATH] = {};
  if (!GetModuleFileNameW(g_module, modulePath, ARRAYSIZE(modulePath))) return HRESULT_FROM_WIN32(GetLastError());

  wchar_t keyPath[256] = {};
  RETURN_IF_FAILED(StringCchPrintfW(keyPath, ARRAYSIZE(keyPath), L"Software\\Classes\\CLSID\\%s", clsid));
  RETURN_IF_FAILED(writeStringValue(HKEY_LOCAL_MACHINE, keyPath, nullptr, kLekhTextServiceDescription));

  wchar_t inprocPath[300] = {};
  RETURN_IF_FAILED(StringCchPrintfW(inprocPath, ARRAYSIZE(inprocPath), L"%s\\InprocServer32", keyPath));
  RETURN_IF_FAILED(writeStringValue(HKEY_LOCAL_MACHINE, inprocPath, nullptr, modulePath));
  RETURN_IF_FAILED(writeStringValue(HKEY_LOCAL_MACHINE, inprocPath, L"ThreadingModel", L"Apartment"));
  return S_OK;
}

HRESULT unregisterComServer() {
  wchar_t clsid[64] = {};
  RETURN_IF_FAILED(guidToString(CLSID_LekhTextService, clsid, ARRAYSIZE(clsid)));
  wchar_t keyPath[256] = {};
  RETURN_IF_FAILED(StringCchPrintfW(keyPath, ARRAYSIZE(keyPath), L"Software\\Classes\\CLSID\\%s", clsid));
  const LONG result = SHDeleteKeyW(HKEY_LOCAL_MACHINE, keyPath);
  return result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND ? S_OK : HRESULT_FROM_WIN32(result);
}

HRESULT registerTsfProfile() {
  ITfInputProcessorProfiles* profiles = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_TF_InputProcessorProfiles, nullptr, CLSCTX_INPROC_SERVER, IID_ITfInputProcessorProfiles, reinterpret_cast<void**>(&profiles));
  if (FAILED(hr)) return hr;
  if (!profiles) return E_NOINTERFACE;

  hr = profiles->Register(CLSID_LekhTextService);
  if (SUCCEEDED(hr)) {
    const LANGID nepali = MAKELANGID(LANG_NEPALI, SUBLANG_DEFAULT);
    hr = profiles->AddLanguageProfile(
      CLSID_LekhTextService,
      nepali,
      GUID_LekhTextServiceProfile,
      const_cast<wchar_t*>(kLekhTextServiceDescription),
      static_cast<ULONG>(wcslen(kLekhTextServiceDescription)),
      nullptr,
      0,
      0
    );
  }
  profiles->Release();
  if (FAILED(hr)) return hr;

  ITfCategoryMgr* categoryMgr = nullptr;
  hr = CoCreateInstance(CLSID_TF_CategoryMgr, nullptr, CLSCTX_INPROC_SERVER, IID_ITfCategoryMgr, reinterpret_cast<void**>(&categoryMgr));
  if (FAILED(hr)) return hr;
  if (!categoryMgr) return E_NOINTERFACE;
  hr = categoryMgr->RegisterCategory(CLSID_LekhTextService, GUID_TFCAT_TIP_KEYBOARD, CLSID_LekhTextService);
  categoryMgr->Release();
  return hr;
}

HRESULT unregisterTsfProfile() {
  ITfInputProcessorProfiles* profiles = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_TF_InputProcessorProfiles, nullptr, CLSCTX_INPROC_SERVER, IID_ITfInputProcessorProfiles, reinterpret_cast<void**>(&profiles));
  if (SUCCEEDED(hr) && profiles) {
    profiles->Unregister(CLSID_LekhTextService);
    profiles->Release();
  }
  return S_OK;
}

} // namespace

STDAPI DllRegisterServer() {
  bool mustUninitialize = false;
  RETURN_IF_FAILED(initializeComForRegistration(&mustUninitialize));
  const HRESULT comResult = registerComServer();
  const HRESULT tsfResult = SUCCEEDED(comResult) ? registerTsfProfile() : comResult;
  if (FAILED(tsfResult)) {
    unregisterTsfProfile();
    unregisterComServer();
  }
  if (mustUninitialize) CoUninitialize();
  return tsfResult;
}

STDAPI DllUnregisterServer() {
  bool mustUninitialize = false;
  const HRESULT initialization = initializeComForRegistration(&mustUninitialize);
  if (SUCCEEDED(initialization)) unregisterTsfProfile();
  const HRESULT result = unregisterComServer();
  if (mustUninitialize) CoUninitialize();
  return FAILED(initialization) ? initialization : result;
}
