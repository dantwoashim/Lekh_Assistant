#include "Guids.h"

#include <shlwapi.h>
#include <strsafe.h>
#include <windows.h>

#include <algorithm>
#include <iterator>
#include <string>
#include <utility>

extern HMODULE g_module;

#ifndef RETURN_IF_FAILED
#define RETURN_IF_FAILED(expression) \
  do { \
    const HRESULT _lekh_hr = (expression); \
    if (FAILED(_lekh_hr)) return _lekh_hr; \
  } while (0)
#endif

namespace {

constexpr const GUID* kTextServiceCategories[] = {
  &GUID_TFCAT_TIP_KEYBOARD,
  &GUID_TFCAT_DISPLAYATTRIBUTEPROVIDER,
  // Required for a TSF IME to be loaded by modern Windows/AppContainer hosts.
  // Secure-mode support is deliberately not declared: Lekh fails closed for
  // password, PIN, private, unknown, and secure-desktop input contexts.
  &GUID_TFCAT_TIPCAP_IMMERSIVESUPPORT,
};

constexpr DWORD kInstallLayoutOrTipUninstall = 0x00000001;
using InstallLayoutOrTipFunction = BOOL (CALLBACK*)(LPCWSTR profile, DWORD flags);

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

HRESULT textServiceProfileIdentifier(std::wstring* output) {
  if (!output) return E_POINTER;
  wchar_t clsid[64] = {};
  wchar_t profile[64] = {};
  RETURN_IF_FAILED(guidToString(CLSID_LekhTextService, clsid, ARRAYSIZE(clsid)));
  RETURN_IF_FAILED(guidToString(GUID_LekhTextServiceProfile, profile, ARRAYSIZE(profile)));
  wchar_t identifier[160] = {};
  const LANGID nepali = MAKELANGID(LANG_NEPALI, SUBLANG_DEFAULT);
  RETURN_IF_FAILED(StringCchPrintfW(
    identifier,
    ARRAYSIZE(identifier),
    L"0x%04x:%s%s",
    static_cast<unsigned int>(nepali),
    clsid,
    profile
  ));
  *output = identifier;
  return S_OK;
}

HRESULT setTextServiceEnabledForCurrentUser(bool enabled) {
  std::wstring identifier;
  RETURN_IF_FAILED(textServiceProfileIdentifier(&identifier));

  // Load only the operating-system copy. There is intentionally no import
  // library for this API, and ordinary LoadLibrary search order is unsafe in
  // an elevated registration process.
  HMODULE input = LoadLibraryExW(L"input.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!input) return HRESULT_FROM_WIN32(GetLastError());
  const auto installLayoutOrTip = reinterpret_cast<InstallLayoutOrTipFunction>(
    GetProcAddress(input, "InstallLayoutOrTip")
  );
  if (!installLayoutOrTip) {
    FreeLibrary(input);
    return HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND);
  }
  const BOOL result = installLayoutOrTip(
    identifier.c_str(),
    enabled ? 0 : kInstallLayoutOrTipUninstall
  );
  FreeLibrary(input);
  return result ? S_OK : E_FAIL;
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

HRESULT currentModulePath(std::wstring* output) {
  if (!output) return E_POINTER;
  constexpr size_t kMaximumWindowsPathCharacters = 32768;
  std::wstring buffer(512, L'\0');
  while (buffer.size() <= kMaximumWindowsPathCharacters) {
    SetLastError(ERROR_SUCCESS);
    const DWORD length = GetModuleFileNameW(
      g_module,
      buffer.data(),
      static_cast<DWORD>(buffer.size())
    );
    if (length == 0) return HRESULT_FROM_WIN32(GetLastError());
    if (static_cast<size_t>(length) < buffer.size()) {
      buffer.resize(length);
      *output = std::move(buffer);
      return S_OK;
    }
    if (buffer.size() == kMaximumWindowsPathCharacters) break;
    buffer.resize(std::min(buffer.size() * 2, kMaximumWindowsPathCharacters));
  }
  return HRESULT_FROM_WIN32(ERROR_FILENAME_EXCED_RANGE);
}

HRESULT registerComServer() {
  wchar_t clsid[64] = {};
  RETURN_IF_FAILED(guidToString(CLSID_LekhTextService, clsid, ARRAYSIZE(clsid)));

  std::wstring modulePath;
  RETURN_IF_FAILED(currentModulePath(&modulePath));

  wchar_t keyPath[256] = {};
  RETURN_IF_FAILED(StringCchPrintfW(keyPath, ARRAYSIZE(keyPath), L"Software\\Classes\\CLSID\\%s", clsid));
  RETURN_IF_FAILED(writeStringValue(HKEY_LOCAL_MACHINE, keyPath, nullptr, kLekhTextServiceDescription));

  wchar_t inprocPath[300] = {};
  RETURN_IF_FAILED(StringCchPrintfW(inprocPath, ARRAYSIZE(inprocPath), L"%s\\InprocServer32", keyPath));
  RETURN_IF_FAILED(writeStringValue(HKEY_LOCAL_MACHINE, inprocPath, nullptr, modulePath.c_str()));
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
    std::wstring iconPath;
    hr = currentModulePath(&iconPath);
    if (FAILED(hr)) {
      profiles->Release();
      return hr;
    }
    hr = profiles->AddLanguageProfile(
      CLSID_LekhTextService,
      nepali,
      GUID_LekhTextServiceProfile,
      const_cast<wchar_t*>(kLekhTextServiceDescription),
      static_cast<ULONG>(wcslen(kLekhTextServiceDescription)),
      iconPath.data(),
      static_cast<ULONG>(iconPath.size()),
      0
    );
  }
  profiles->Release();
  if (FAILED(hr)) return hr;

  ITfCategoryMgr* categoryMgr = nullptr;
  hr = CoCreateInstance(CLSID_TF_CategoryMgr, nullptr, CLSCTX_INPROC_SERVER, IID_ITfCategoryMgr, reinterpret_cast<void**>(&categoryMgr));
  if (FAILED(hr)) return hr;
  if (!categoryMgr) return E_NOINTERFACE;
  std::size_t registeredCategoryCount = 0;
  for (; registeredCategoryCount < std::size(kTextServiceCategories); ++registeredCategoryCount) {
    hr = categoryMgr->RegisterCategory(
      CLSID_LekhTextService,
      *kTextServiceCategories[registeredCategoryCount],
      CLSID_LekhTextService
    );
    if (FAILED(hr)) break;
  }
  if (FAILED(hr)) {
    while (registeredCategoryCount > 0) {
      --registeredCategoryCount;
      categoryMgr->UnregisterCategory(
        CLSID_LekhTextService,
        *kTextServiceCategories[registeredCategoryCount],
        CLSID_LekhTextService
      );
    }
  }
  categoryMgr->Release();
  if (SUCCEEDED(hr)) hr = setTextServiceEnabledForCurrentUser(true);
  return hr;
}

HRESULT unregisterTsfProfile() {
  setTextServiceEnabledForCurrentUser(false);
  ITfCategoryMgr* categoryMgr = nullptr;
  HRESULT hr = CoCreateInstance(
    CLSID_TF_CategoryMgr,
    nullptr,
    CLSCTX_INPROC_SERVER,
    IID_ITfCategoryMgr,
    reinterpret_cast<void**>(&categoryMgr)
  );
  if (SUCCEEDED(hr) && categoryMgr) {
    for (const GUID* category : kTextServiceCategories) {
      categoryMgr->UnregisterCategory(CLSID_LekhTextService, *category, CLSID_LekhTextService);
    }
    categoryMgr->Release();
  }

  ITfInputProcessorProfiles* profiles = nullptr;
  hr = CoCreateInstance(CLSID_TF_InputProcessorProfiles, nullptr, CLSCTX_INPROC_SERVER, IID_ITfInputProcessorProfiles, reinterpret_cast<void**>(&profiles));
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
