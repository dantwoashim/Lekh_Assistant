#include "Guids.h"

#include <shlwapi.h>
#include <strsafe.h>
#include <windows.h>

#include <cstring>
#include <string>
#include <vector>

extern HMODULE g_module;

#ifndef RETURN_IF_FAILED
#define RETURN_IF_FAILED(expression) \
  do { \
    const HRESULT _lekh_hr = (expression); \
    if (FAILED(_lekh_hr)) return _lekh_hr; \
  } while (0)
#endif

namespace {

constexpr wchar_t kRegistrationOwnerValue[] = L"LekhRegistrationOwner";
constexpr wchar_t kRegistrationOwnerToken[] =
  L"3F04E1EA-7D90-47E1-865B-11D6F13D0301";

struct RegistryValueSnapshot {
  std::wstring keyPath;
  std::wstring valueName;
  bool existed = false;
  DWORD type = REG_NONE;
  std::vector<BYTE> data;
};

struct ComRegistrationJournal {
  std::wstring keyPath;
  bool keyExisted = false;
  bool captured = false;
  std::vector<RegistryValueSnapshot> values;
};

class RegistrationMutex final {
public:
  RegistrationMutex() = default;
  RegistrationMutex(const RegistrationMutex&) = delete;
  RegistrationMutex& operator=(const RegistrationMutex&) = delete;

  ~RegistrationMutex() {
    if (owned_ && handle_) ReleaseMutex(handle_);
    if (handle_) CloseHandle(handle_);
  }

  HRESULT acquire() {
    handle_ = CreateMutexW(
      nullptr,
      FALSE,
      L"Local\\LekhKeyboardTsfRegistration-3F04E1EA-7D90-47E1-865B-11D6F13D0301"
    );
    if (!handle_) return HRESULT_FROM_WIN32(GetLastError());
    const DWORD waitResult = WaitForSingleObject(handle_, 30'000);
    if (waitResult == WAIT_OBJECT_0 || waitResult == WAIT_ABANDONED) {
      owned_ = true;
      return S_OK;
    }
    return waitResult == WAIT_TIMEOUT
      ? HRESULT_FROM_WIN32(ERROR_TIMEOUT)
      : HRESULT_FROM_WIN32(GetLastError());
  }

private:
  HANDLE handle_ = nullptr;
  bool owned_ = false;
};

const wchar_t* registryValueName(const RegistryValueSnapshot& snapshot) {
  return snapshot.valueName.empty() ? nullptr : snapshot.valueName.c_str();
}

HRESULT captureRegistryValue(
  const std::wstring& keyPath,
  const wchar_t* valueName,
  RegistryValueSnapshot& snapshot
) {
  snapshot = {};
  snapshot.keyPath = keyPath;
  snapshot.valueName = valueName ? valueName : L"";
  HKEY key = nullptr;
  const LONG openResult = RegOpenKeyExW(
    HKEY_CURRENT_USER,
    keyPath.c_str(),
    0,
    KEY_QUERY_VALUE,
    &key
  );
  if (openResult == ERROR_FILE_NOT_FOUND || openResult == ERROR_PATH_NOT_FOUND) return S_OK;
  if (openResult != ERROR_SUCCESS) return HRESULT_FROM_WIN32(openResult);

  DWORD bytes = 0;
  LONG queryResult = RegQueryValueExW(
    key,
    valueName,
    nullptr,
    &snapshot.type,
    nullptr,
    &bytes
  );
  if (queryResult == ERROR_FILE_NOT_FOUND) {
    RegCloseKey(key);
    return S_OK;
  }
  if (queryResult != ERROR_SUCCESS) {
    RegCloseKey(key);
    return HRESULT_FROM_WIN32(queryResult);
  }
  if (bytes > 64 * 1024) {
    RegCloseKey(key);
    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
  }
  snapshot.data.resize(bytes);
  queryResult = RegQueryValueExW(
    key,
    valueName,
    nullptr,
    &snapshot.type,
    snapshot.data.empty() ? nullptr : snapshot.data.data(),
    &bytes
  );
  RegCloseKey(key);
  if (queryResult != ERROR_SUCCESS) return HRESULT_FROM_WIN32(queryResult);
  if (bytes != snapshot.data.size()) return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
  snapshot.existed = true;
  return S_OK;
}

HRESULT registrySnapshotString(
  const RegistryValueSnapshot& snapshot,
  std::wstring& output
) {
  if (!snapshot.existed || snapshot.type != REG_SZ ||
      snapshot.data.size() < sizeof(wchar_t) ||
      snapshot.data.size() % sizeof(wchar_t) != 0) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
  }
  const std::size_t characters = snapshot.data.size() / sizeof(wchar_t);
  std::vector<wchar_t> value(characters, L'\0');
  std::memcpy(value.data(), snapshot.data.data(), snapshot.data.size());
  if (value[characters - 1] != L'\0' || wcsnlen(value.data(), characters) + 1 != characters) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
  }
  output.assign(value.data(), characters - 1);
  return S_OK;
}

HRESULT restoreRegistryValue(const RegistryValueSnapshot& snapshot) {
  if (!snapshot.existed) {
    HKEY key = nullptr;
    const LONG openResult = RegOpenKeyExW(
      HKEY_CURRENT_USER,
      snapshot.keyPath.c_str(),
      0,
      KEY_SET_VALUE,
      &key
    );
    if (openResult == ERROR_FILE_NOT_FOUND || openResult == ERROR_PATH_NOT_FOUND) return S_OK;
    if (openResult != ERROR_SUCCESS) return HRESULT_FROM_WIN32(openResult);
    const LONG deleteResult = RegDeleteValueW(key, registryValueName(snapshot));
    RegCloseKey(key);
    return deleteResult == ERROR_SUCCESS || deleteResult == ERROR_FILE_NOT_FOUND
      ? S_OK
      : HRESULT_FROM_WIN32(deleteResult);
  }

  HKEY key = nullptr;
  const LONG createResult = RegCreateKeyExW(
    HKEY_CURRENT_USER,
    snapshot.keyPath.c_str(),
    0,
    nullptr,
    0,
    KEY_SET_VALUE,
    nullptr,
    &key,
    nullptr
  );
  if (createResult != ERROR_SUCCESS) return HRESULT_FROM_WIN32(createResult);
  const LONG setResult = RegSetValueExW(
    key,
    registryValueName(snapshot),
    0,
    snapshot.type,
    snapshot.data.empty() ? nullptr : snapshot.data.data(),
    static_cast<DWORD>(snapshot.data.size())
  );
  RegCloseKey(key);
  return setResult == ERROR_SUCCESS ? S_OK : HRESULT_FROM_WIN32(setResult);
}

bool registrySnapshotMatches(const RegistryValueSnapshot& expected) {
  RegistryValueSnapshot actual;
  if (FAILED(captureRegistryValue(
        expected.keyPath,
        registryValueName(expected),
        actual
      ))) {
    return false;
  }
  return actual.existed == expected.existed &&
    (!expected.existed ||
      (actual.type == expected.type && actual.data == expected.data));
}

bool rollbackComRegistration(const ComRegistrationJournal& journal) {
  if (!journal.captured) return true;
  if (!journal.keyExisted) {
    const LONG deleteResult = SHDeleteKeyW(HKEY_CURRENT_USER, journal.keyPath.c_str());
    if (deleteResult != ERROR_SUCCESS && deleteResult != ERROR_FILE_NOT_FOUND) return false;
    HKEY key = nullptr;
    const LONG openResult = RegOpenKeyExW(
      HKEY_CURRENT_USER,
      journal.keyPath.c_str(),
      0,
      KEY_READ,
      &key
    );
    if (openResult == ERROR_SUCCESS) RegCloseKey(key);
    return openResult == ERROR_FILE_NOT_FOUND || openResult == ERROR_PATH_NOT_FOUND;
  }

  bool restored = true;
  for (auto value = journal.values.rbegin(); value != journal.values.rend(); ++value) {
    if (FAILED(restoreRegistryValue(*value))) restored = false;
  }
  for (const auto& value : journal.values) {
    if (!registrySnapshotMatches(value)) restored = false;
  }
  return restored;
}

HRESULT guidToString(REFGUID guid, wchar_t* output, size_t outputCount) {
  return StringFromGUID2(guid, output, static_cast<int>(outputCount)) > 0 ? S_OK : E_FAIL;
}

HRESULT currentModulePath(std::wstring& output) {
  std::vector<wchar_t> modulePath(32768, L'\0');
  const DWORD modulePathLength = GetModuleFileNameW(
    g_module,
    modulePath.data(),
    static_cast<DWORD>(modulePath.size())
  );
  if (modulePathLength == 0) return HRESULT_FROM_WIN32(GetLastError());
  if (modulePathLength >= modulePath.size()) return HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER);
  output.assign(modulePath.data(), modulePathLength);
  return S_OK;
}

HRESULT comKeyPaths(std::wstring& keyPath, std::wstring& inprocPath) {
  wchar_t clsid[64] = {};
  RETURN_IF_FAILED(guidToString(CLSID_LekhTextService, clsid, ARRAYSIZE(clsid)));
  wchar_t keyBuffer[256] = {};
  RETURN_IF_FAILED(StringCchPrintfW(
    keyBuffer,
    ARRAYSIZE(keyBuffer),
    L"Software\\Classes\\CLSID\\%s",
    clsid
  ));
  keyPath = keyBuffer;
  wchar_t inprocBuffer[300] = {};
  RETURN_IF_FAILED(StringCchPrintfW(
    inprocBuffer,
    ARRAYSIZE(inprocBuffer),
    L"%s\\InprocServer32",
    keyBuffer
  ));
  inprocPath = inprocBuffer;
  return S_OK;
}

HRESULT readStringValue(
  HKEY root,
  const wchar_t* keyPath,
  const wchar_t* valueName,
  std::wstring& output
) {
  DWORD type = 0;
  DWORD bytes = 0;
  LONG result = RegGetValueW(
    root,
    keyPath,
    valueName,
    RRF_RT_REG_SZ | RRF_NOEXPAND,
    &type,
    nullptr,
    &bytes
  );
  if (result != ERROR_SUCCESS) return HRESULT_FROM_WIN32(result);
  if (type != REG_SZ || bytes < sizeof(wchar_t) || bytes % sizeof(wchar_t) != 0) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
  }
  std::vector<wchar_t> value(bytes / sizeof(wchar_t), L'\0');
  result = RegGetValueW(
    root,
    keyPath,
    valueName,
    RRF_RT_REG_SZ | RRF_NOEXPAND,
    &type,
    value.data(),
    &bytes
  );
  if (result != ERROR_SUCCESS) return HRESULT_FROM_WIN32(result);
  const std::size_t characters = bytes / sizeof(wchar_t);
  if (characters == 0 || value[characters - 1] != L'\0' ||
      wcslen(value.data()) + 1 != characters) {
    return HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
  }
  output.assign(value.data(), characters - 1);
  return S_OK;
}

HRESULT inspectComRegistration(
  const std::wstring& keyPath,
  const std::wstring& inprocPath,
  const std::wstring& modulePath,
  bool& exists,
  bool& owned
) {
  exists = false;
  owned = false;
  HKEY key = nullptr;
  const LONG openResult = RegOpenKeyExW(
    HKEY_CURRENT_USER,
    keyPath.c_str(),
    0,
    KEY_READ,
    &key
  );
  if (openResult == ERROR_FILE_NOT_FOUND || openResult == ERROR_PATH_NOT_FOUND) return S_OK;
  if (openResult != ERROR_SUCCESS) return HRESULT_FROM_WIN32(openResult);
  exists = true;
  RegCloseKey(key);

  std::wstring registeredPath;
  const HRESULT readResult = readStringValue(
    HKEY_CURRENT_USER,
    inprocPath.c_str(),
    nullptr,
    registeredPath
  );
  if (HRESULT_CODE(readResult) == ERROR_FILE_NOT_FOUND ||
      HRESULT_CODE(readResult) == ERROR_PATH_NOT_FOUND) {
    return S_OK;
  }
  RETURN_IF_FAILED(readResult);
  std::wstring ownerToken;
  const HRESULT ownerResult = readStringValue(
    HKEY_CURRENT_USER,
    keyPath.c_str(),
    kRegistrationOwnerValue,
    ownerToken
  );
  if (HRESULT_CODE(ownerResult) == ERROR_FILE_NOT_FOUND ||
      HRESULT_CODE(ownerResult) == ERROR_PATH_NOT_FOUND) {
    return S_OK;
  }
  RETURN_IF_FAILED(ownerResult);
  owned = _wcsicmp(registeredPath.c_str(), modulePath.c_str()) == 0 &&
    ownerToken == kRegistrationOwnerToken;
  return S_OK;
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

HRESULT registerComServer(ComRegistrationJournal& journal) {
  journal = {};
  std::wstring modulePath;
  std::wstring keyPath;
  std::wstring inprocPath;
  RETURN_IF_FAILED(currentModulePath(modulePath));
  RETURN_IF_FAILED(comKeyPaths(keyPath, inprocPath));

  HKEY existingKey = nullptr;
  const LONG openResult = RegOpenKeyExW(
    HKEY_CURRENT_USER,
    keyPath.c_str(),
    0,
    KEY_READ,
    &existingKey
  );
  if (openResult == ERROR_SUCCESS) {
    journal.keyExisted = true;
    RegCloseKey(existingKey);
  } else if (openResult != ERROR_FILE_NOT_FOUND && openResult != ERROR_PATH_NOT_FOUND) {
    return HRESULT_FROM_WIN32(openResult);
  }

  journal.keyPath = keyPath;
  journal.values.resize(4);
  RETURN_IF_FAILED(captureRegistryValue(inprocPath, nullptr, journal.values[0]));
  RETURN_IF_FAILED(captureRegistryValue(inprocPath, L"ThreadingModel", journal.values[1]));
  RETURN_IF_FAILED(captureRegistryValue(keyPath, nullptr, journal.values[2]));
  RETURN_IF_FAILED(captureRegistryValue(
    keyPath,
    kRegistrationOwnerValue,
    journal.values[3]
  ));
  journal.captured = true;
  if (!journal.keyExisted &&
      (journal.values[0].existed || journal.values[1].existed ||
       journal.values[2].existed || journal.values[3].existed)) {
    journal.captured = false;
    return HRESULT_FROM_WIN32(ERROR_RETRY);
  }
  if (journal.keyExisted) {
    std::wstring registeredPath;
    std::wstring ownerToken;
    if (FAILED(registrySnapshotString(journal.values[0], registeredPath)) ||
        FAILED(registrySnapshotString(journal.values[3], ownerToken)) ||
        _wcsicmp(registeredPath.c_str(), modulePath.c_str()) != 0 ||
        ownerToken != kRegistrationOwnerToken) {
      journal.captured = false;
      return HRESULT_FROM_WIN32(ERROR_NOT_OWNER);
    }
  }
  for (const auto& value : journal.values) {
    if (!registrySnapshotMatches(value)) {
      journal.captured = false;
      return HRESULT_FROM_WIN32(ERROR_RETRY);
    }
  }

  HRESULT result = writeStringValue(HKEY_CURRENT_USER, inprocPath.c_str(), nullptr, modulePath.c_str());
  if (SUCCEEDED(result)) {
    result = writeStringValue(HKEY_CURRENT_USER, inprocPath.c_str(), L"ThreadingModel", L"Apartment");
  }
  if (SUCCEEDED(result)) {
    result = writeStringValue(HKEY_CURRENT_USER, keyPath.c_str(), nullptr, kLekhTextServiceDescription);
  }
  if (SUCCEEDED(result)) {
    result = writeStringValue(
      HKEY_CURRENT_USER,
      keyPath.c_str(),
      kRegistrationOwnerValue,
      kRegistrationOwnerToken
    );
  }
  if (FAILED(result)) {
    const bool rolledBack = rollbackComRegistration(journal);
    journal.captured = false;
    return rolledBack ? result : E_UNEXPECTED;
  }
  return S_OK;
}

HRESULT unregisterComServer() {
  std::wstring modulePath;
  std::wstring keyPath;
  std::wstring inprocPath;
  RETURN_IF_FAILED(currentModulePath(modulePath));
  RETURN_IF_FAILED(comKeyPaths(keyPath, inprocPath));
  bool exists = false;
  bool owned = false;
  RETURN_IF_FAILED(inspectComRegistration(keyPath, inprocPath, modulePath, exists, owned));
  if (!exists) return S_OK;
  if (!owned) return HRESULT_FROM_WIN32(ERROR_NOT_OWNER);
  const LONG result = SHDeleteKeyW(HKEY_CURRENT_USER, keyPath.c_str());
  return result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND ? S_OK : HRESULT_FROM_WIN32(result);
}

HRESULT validateComUnregistrationOwnership() {
  std::wstring modulePath;
  std::wstring keyPath;
  std::wstring inprocPath;
  RETURN_IF_FAILED(currentModulePath(modulePath));
  RETURN_IF_FAILED(comKeyPaths(keyPath, inprocPath));
  bool exists = false;
  bool owned = false;
  RETURN_IF_FAILED(inspectComRegistration(keyPath, inprocPath, modulePath, exists, owned));
  return exists && !owned ? HRESULT_FROM_WIN32(ERROR_NOT_OWNER) : S_OK;
}

HRESULT enumeratorContainsGuid(IEnumGUID* enumerator, REFGUID target, bool& found) {
  if (!enumerator) return E_INVALIDARG;
  found = false;
  for (;;) {
    GUID candidate = GUID_NULL;
    ULONG fetched = 0;
    const HRESULT nextResult = enumerator->Next(1, &candidate, &fetched);
    if (FAILED(nextResult)) return nextResult;
    if (fetched == 0) return S_OK;
    if (IsEqualGUID(candidate, target)) {
      found = true;
      return S_OK;
    }
    if (nextResult == S_FALSE) return S_OK;
  }
}

HRESULT inputProcessorRegistrationExists(
  ITfInputProcessorProfiles* profiles,
  bool& registered
) {
  if (!profiles) return E_INVALIDARG;
  IEnumGUID* inputProcessors = nullptr;
  const HRESULT enumerateResult = profiles->EnumInputProcessorInfo(&inputProcessors);
  if (FAILED(enumerateResult) || !inputProcessors) {
    return FAILED(enumerateResult) ? enumerateResult : E_NOINTERFACE;
  }
  const HRESULT findResult = enumeratorContainsGuid(
    inputProcessors,
    CLSID_LekhTextService,
    registered
  );
  inputProcessors->Release();
  return findResult;
}

HRESULT languageProfileRegistrationExists(
  ITfInputProcessorProfiles* profiles,
  bool& registered
) {
  if (!profiles) return E_INVALIDARG;
  registered = false;
  const LANGID nepali = MAKELANGID(LANG_NEPALI, SUBLANG_DEFAULT);
  IEnumTfLanguageProfiles* languageProfiles = nullptr;
  const HRESULT enumerateResult = profiles->EnumLanguageProfiles(
    nepali,
    &languageProfiles
  );
  if (FAILED(enumerateResult) || !languageProfiles) {
    return FAILED(enumerateResult) ? enumerateResult : E_NOINTERFACE;
  }
  for (;;) {
    TF_LANGUAGEPROFILE candidate = {};
    ULONG fetched = 0;
    const HRESULT nextResult = languageProfiles->Next(1, &candidate, &fetched);
    if (FAILED(nextResult)) {
      languageProfiles->Release();
      return nextResult;
    }
    if (fetched == 0) break;
    if (IsEqualCLSID(candidate.clsid, CLSID_LekhTextService) &&
        IsEqualGUID(candidate.guidProfile, GUID_LekhTextServiceProfile)) {
      registered = true;
      break;
    }
    if (nextResult == S_FALSE) break;
  }
  languageProfiles->Release();
  return S_OK;
}

HRESULT categoryRegistrationExists(
  ITfCategoryMgr* categoryManager,
  bool& registered
) {
  if (!categoryManager) return E_INVALIDARG;
  IEnumGUID* categories = nullptr;
  const HRESULT enumerateResult = categoryManager->EnumCategoriesInItem(
    CLSID_LekhTextService,
    &categories
  );
  if (FAILED(enumerateResult) || !categories) {
    return FAILED(enumerateResult) ? enumerateResult : E_NOINTERFACE;
  }
  const HRESULT findResult = enumeratorContainsGuid(
    categories,
    GUID_TFCAT_TIP_KEYBOARD,
    registered
  );
  categories->Release();
  return findResult;
}

bool rollbackTsfRegistration(
  ITfInputProcessorProfiles* profiles,
  ITfCategoryMgr* categoryManager,
  bool processorCreated,
  bool profileCreated,
  bool categoryCreated,
  bool processorExisted,
  bool profileExisted,
  bool categoryExisted
) {
  bool complete = true;
  bool currentProcessor = false;
  bool currentProfile = false;
  bool currentCategory = false;
  if (SUCCEEDED(inputProcessorRegistrationExists(profiles, currentProcessor))) {
    processorCreated = processorCreated || (!processorExisted && currentProcessor);
  } else {
    complete = false;
  }
  if (SUCCEEDED(languageProfileRegistrationExists(profiles, currentProfile))) {
    profileCreated = profileCreated || (!profileExisted && currentProfile);
  } else {
    complete = false;
  }
  if (SUCCEEDED(categoryRegistrationExists(categoryManager, currentCategory))) {
    categoryCreated = categoryCreated || (!categoryExisted && currentCategory);
  } else {
    complete = false;
  }
  const LANGID nepali = MAKELANGID(LANG_NEPALI, SUBLANG_DEFAULT);
  if (categoryCreated && FAILED(categoryManager->UnregisterCategory(
        CLSID_LekhTextService,
        GUID_TFCAT_TIP_KEYBOARD,
        CLSID_LekhTextService
      ))) {
    complete = false;
  }
  if (profileCreated && FAILED(profiles->RemoveLanguageProfile(
        CLSID_LekhTextService,
        nepali,
        GUID_LekhTextServiceProfile
      ))) {
    complete = false;
  }
  if (processorCreated && FAILED(profiles->Unregister(CLSID_LekhTextService))) {
    complete = false;
  }

  bool processorExists = true;
  bool profileExists = true;
  bool categoryExists = true;
  if (FAILED(inputProcessorRegistrationExists(profiles, processorExists)) ||
      FAILED(languageProfileRegistrationExists(profiles, profileExists)) ||
      FAILED(categoryRegistrationExists(categoryManager, categoryExists))) {
    return false;
  }
  if (processorExists != processorExisted ||
      profileExists != profileExisted ||
      categoryExists != categoryExisted) {
    complete = false;
  }
  return complete;
}

HRESULT registerTsfProfile(bool& rollbackComplete) {
  rollbackComplete = true;
  ITfInputProcessorProfiles* profiles = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_TF_InputProcessorProfiles, nullptr, CLSCTX_INPROC_SERVER, IID_ITfInputProcessorProfiles, reinterpret_cast<void**>(&profiles));
  if (FAILED(hr) || !profiles) return FAILED(hr) ? hr : E_NOINTERFACE;

  ITfCategoryMgr* categoryMgr = nullptr;
  hr = CoCreateInstance(
    CLSID_TF_CategoryMgr,
    nullptr,
    CLSCTX_INPROC_SERVER,
    IID_ITfCategoryMgr,
    reinterpret_cast<void**>(&categoryMgr)
  );
  if (FAILED(hr) || !categoryMgr) {
    profiles->Release();
    return FAILED(hr) ? hr : E_NOINTERFACE;
  }

  bool processorExisted = false;
  bool profileExisted = false;
  bool categoryExisted = false;
  hr = inputProcessorRegistrationExists(profiles, processorExisted);
  if (SUCCEEDED(hr)) hr = languageProfileRegistrationExists(profiles, profileExisted);
  if (SUCCEEDED(hr)) hr = categoryRegistrationExists(categoryMgr, categoryExisted);
  if (FAILED(hr) || (!processorExisted && (profileExisted || categoryExisted))) {
    categoryMgr->Release();
    profiles->Release();
    return FAILED(hr) ? hr : HRESULT_FROM_WIN32(ERROR_INVALID_DATA);
  }

  bool processorCreated = false;
  bool profileCreated = false;
  bool categoryCreated = false;
  if (!processorExisted) {
    hr = profiles->Register(CLSID_LekhTextService);
    if (SUCCEEDED(hr)) {
      processorCreated = true;
    } else {
      bool nowExists = false;
      if (SUCCEEDED(inputProcessorRegistrationExists(profiles, nowExists))) {
        processorCreated = nowExists;
      }
    }
  }

  const LANGID nepali = MAKELANGID(LANG_NEPALI, SUBLANG_DEFAULT);
  if (SUCCEEDED(hr) && !profileExisted) {
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
    if (SUCCEEDED(hr)) {
      profileCreated = true;
    } else {
      bool nowExists = false;
      if (SUCCEEDED(languageProfileRegistrationExists(profiles, nowExists))) {
        profileCreated = nowExists;
      }
    }
  }

  if (SUCCEEDED(hr) && !categoryExisted) {
    hr = categoryMgr->RegisterCategory(
      CLSID_LekhTextService,
      GUID_TFCAT_TIP_KEYBOARD,
      CLSID_LekhTextService
    );
    if (SUCCEEDED(hr)) {
      categoryCreated = true;
    } else {
      bool nowExists = false;
      if (SUCCEEDED(categoryRegistrationExists(categoryMgr, nowExists))) {
        categoryCreated = nowExists;
      }
    }
  }

  if (FAILED(hr)) {
    rollbackComplete = rollbackTsfRegistration(
      profiles,
      categoryMgr,
      processorCreated,
      profileCreated,
      categoryCreated,
      processorExisted,
      profileExisted,
      categoryExisted
    );
  }
  categoryMgr->Release();
  profiles->Release();
  return FAILED(hr) && !rollbackComplete ? E_UNEXPECTED : hr;
}

HRESULT unregisterTsfProfile() {
  ITfInputProcessorProfiles* profiles = nullptr;
  HRESULT hr = CoCreateInstance(
    CLSID_TF_InputProcessorProfiles,
    nullptr,
    CLSCTX_INPROC_SERVER,
    IID_ITfInputProcessorProfiles,
    reinterpret_cast<void**>(&profiles)
  );
  if (FAILED(hr) || !profiles) return FAILED(hr) ? hr : E_NOINTERFACE;

  ITfCategoryMgr* categoryMgr = nullptr;
  hr = CoCreateInstance(
    CLSID_TF_CategoryMgr,
    nullptr,
    CLSCTX_INPROC_SERVER,
    IID_ITfCategoryMgr,
    reinterpret_cast<void**>(&categoryMgr)
  );
  if (FAILED(hr) || !categoryMgr) {
    profiles->Release();
    return FAILED(hr) ? hr : E_NOINTERFACE;
  }

  bool processorExists = false;
  bool profileExists = false;
  bool categoryExists = false;
  hr = inputProcessorRegistrationExists(profiles, processorExists);
  if (SUCCEEDED(hr)) hr = languageProfileRegistrationExists(profiles, profileExists);
  if (SUCCEEDED(hr)) hr = categoryRegistrationExists(categoryMgr, categoryExists);
  if (FAILED(hr)) {
    categoryMgr->Release();
    profiles->Release();
    return hr;
  }

  HRESULT firstFailure = S_OK;
  const auto rememberFailure = [&firstFailure](HRESULT result) {
    if (FAILED(result) && SUCCEEDED(firstFailure)) firstFailure = result;
  };
  if (categoryExists) {
    rememberFailure(categoryMgr->UnregisterCategory(
      CLSID_LekhTextService,
      GUID_TFCAT_TIP_KEYBOARD,
      CLSID_LekhTextService
    ));
  }
  const LANGID nepali = MAKELANGID(LANG_NEPALI, SUBLANG_DEFAULT);
  if (profileExists) {
    rememberFailure(profiles->RemoveLanguageProfile(
      CLSID_LekhTextService,
      nepali,
      GUID_LekhTextServiceProfile
    ));
  }
  if (processorExists) {
    rememberFailure(profiles->Unregister(CLSID_LekhTextService));
  }

  processorExists = true;
  profileExists = true;
  categoryExists = true;
  rememberFailure(inputProcessorRegistrationExists(profiles, processorExists));
  rememberFailure(languageProfileRegistrationExists(profiles, profileExists));
  rememberFailure(categoryRegistrationExists(categoryMgr, categoryExists));
  categoryMgr->Release();
  profiles->Release();
  if (processorExists || profileExists || categoryExists) {
    return FAILED(firstFailure) ? firstFailure : E_UNEXPECTED;
  }
  return firstFailure;
}

} // namespace

STDAPI DllRegisterServer() {
  const HRESULT initializeResult = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  const bool uninitialize = SUCCEEDED(initializeResult);
  if (FAILED(initializeResult) && initializeResult != RPC_E_CHANGED_MODE) return initializeResult;
  RegistrationMutex registrationMutex;
  const HRESULT mutexResult = registrationMutex.acquire();
  if (FAILED(mutexResult)) {
    if (uninitialize) CoUninitialize();
    return mutexResult;
  }
  ComRegistrationJournal comJournal;
  const HRESULT comResult = registerComServer(comJournal);
  bool tsfRollbackComplete = true;
  HRESULT result = SUCCEEDED(comResult)
    ? registerTsfProfile(tsfRollbackComplete)
    : comResult;
  if (FAILED(result) && SUCCEEDED(comResult) && tsfRollbackComplete &&
      !rollbackComRegistration(comJournal)) {
    result = E_UNEXPECTED;
  }
  if (uninitialize) CoUninitialize();
  return result;
}

STDAPI DllUnregisterServer() {
  const HRESULT initializeResult = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  const bool uninitialize = SUCCEEDED(initializeResult);
  if (FAILED(initializeResult) && initializeResult != RPC_E_CHANGED_MODE) return initializeResult;
  RegistrationMutex registrationMutex;
  const HRESULT mutexResult = registrationMutex.acquire();
  if (FAILED(mutexResult)) {
    if (uninitialize) CoUninitialize();
    return mutexResult;
  }
  const HRESULT ownershipResult = validateComUnregistrationOwnership();
  if (FAILED(ownershipResult)) {
    if (uninitialize) CoUninitialize();
    return ownershipResult;
  }
  const HRESULT tsfResult = unregisterTsfProfile();
  const HRESULT comResult = SUCCEEDED(tsfResult) ? unregisterComServer() : S_OK;
  if (uninitialize) CoUninitialize();
  return FAILED(tsfResult) ? tsfResult : comResult;
}
