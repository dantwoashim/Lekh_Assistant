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
  RETURN_IF_FAILED(writeStringValue(HKEY_CURRENT_USER, keyPath, nullptr, kLekhTextServiceDescription));

  wchar_t inprocPath[300] = {};
  RETURN_IF_FAILED(StringCchPrintfW(inprocPath, ARRAYSIZE(inprocPath), L"%s\\InprocServer32", keyPath));
  RETURN_IF_FAILED(writeStringValue(HKEY_CURRENT_USER, inprocPath, nullptr, modulePath));
  RETURN_IF_FAILED(writeStringValue(HKEY_CURRENT_USER, inprocPath, L"ThreadingModel", L"Apartment"));
  return S_OK;
}

HRESULT unregisterComServer() {
  wchar_t clsid[64] = {};
  RETURN_IF_FAILED(guidToString(CLSID_LekhTextService, clsid, ARRAYSIZE(clsid)));
  wchar_t keyPath[256] = {};
  RETURN_IF_FAILED(StringCchPrintfW(keyPath, ARRAYSIZE(keyPath), L"Software\\Classes\\CLSID\\%s", clsid));
  const LONG result = SHDeleteKeyW(HKEY_CURRENT_USER, keyPath);
  return result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND ? S_OK : HRESULT_FROM_WIN32(result);
}

HRESULT registerTsfProfile() {
  ITfInputProcessorProfiles* profiles = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_TF_InputProcessorProfiles, nullptr, CLSCTX_INPROC_SERVER, IID_ITfInputProcessorProfiles, reinterpret_cast<void**>(&profiles));
  if (FAILED(hr) || !profiles) return hr;

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

  ITfCategoryMgr* categoryMgr = nullptr;
  if (SUCCEEDED(CoCreateInstance(CLSID_TF_CategoryMgr, nullptr, CLSCTX_INPROC_SERVER, IID_ITfCategoryMgr, reinterpret_cast<void**>(&categoryMgr))) && categoryMgr) {
    categoryMgr->RegisterCategory(CLSID_LekhTextService, GUID_TFCAT_TIP_KEYBOARD, CLSID_LekhTextService);
    categoryMgr->Release();
  }
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
  RETURN_IF_FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED));
  const HRESULT comResult = registerComServer();
  const HRESULT tsfResult = SUCCEEDED(comResult) ? registerTsfProfile() : comResult;
  CoUninitialize();
  return tsfResult;
}

STDAPI DllUnregisterServer() {
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  unregisterTsfProfile();
  const HRESULT result = unregisterComServer();
  CoUninitialize();
  return result;
}
