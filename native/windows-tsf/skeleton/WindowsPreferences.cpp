#include "WindowsPreferences.h"

#include <algorithm>
#include <cwchar>
#include <cwctype>
#include <optional>
#include <vector>
#include <windows.h>

namespace lekh::tsf {
namespace {

constexpr wchar_t kPreferenceKey[] = L"Software\\Lekh\\Keyboard";
constexpr wchar_t kModeValue[] = L"LekhNativeTypingMode";
constexpr wchar_t kInlinePreviewValue[] = L"LekhInlinePreviewEnabled";
constexpr wchar_t kCandidatePanelValue[] = L"LekhCustomCandidatePanelEnabled";
constexpr wchar_t kProofreadValue[] = L"LekhProofreadAsYouTypeEnabled";
constexpr wchar_t kSmartPunctuationValue[] = L"LekhSmartPunctuationEnabled";
constexpr wchar_t kPersonalizationValue[] = L"LekhPersonalizationEnabled";
constexpr wchar_t kNextWordValue[] = L"LekhNextWordPredictionEnabled";
constexpr wchar_t kExcludedApplicationsValue[] = L"LekhExcludedApplicationBundleIdentifiers";
constexpr std::size_t kMaximumExcludedApplications = 100;
constexpr DWORD kMaximumRegistryStringBytes = 64 * 1024;

class RegistryKey final {
public:
  RegistryKey() = default;
  explicit RegistryKey(HKEY key) : key_(key) {}
  ~RegistryKey() {
    if (key_) RegCloseKey(key_);
  }
  RegistryKey(const RegistryKey&) = delete;
  RegistryKey& operator=(const RegistryKey&) = delete;
  HKEY get() const { return key_; }
private:
  HKEY key_ = nullptr;
};

std::optional<std::wstring> readString(HKEY key, const wchar_t* name) {
  DWORD type = 0;
  DWORD bytes = 0;
  if (RegQueryValueExW(key, name, nullptr, &type, nullptr, &bytes) != ERROR_SUCCESS ||
      (type != REG_SZ && type != REG_EXPAND_SZ) || bytes == 0 || bytes > kMaximumRegistryStringBytes ||
      bytes % sizeof(wchar_t) != 0) {
    return std::nullopt;
  }
  std::vector<wchar_t> buffer(bytes / sizeof(wchar_t) + 1, L'\0');
  if (RegQueryValueExW(key, name, nullptr, &type, reinterpret_cast<BYTE*>(buffer.data()), &bytes) != ERROR_SUCCESS) {
    return std::nullopt;
  }
  return std::wstring(buffer.data());
}

bool readBoolean(HKEY key, const wchar_t* name, bool fallback) {
  DWORD type = 0;
  DWORD value = 0;
  DWORD bytes = sizeof(value);
  return RegQueryValueExW(
    key,
    name,
    nullptr,
    &type,
    reinterpret_cast<BYTE*>(&value),
    &bytes
  ) == ERROR_SUCCESS && type == REG_DWORD && bytes == sizeof(value)
    ? value != 0
    : fallback;
}

std::vector<std::wstring> readMultiString(HKEY key, const wchar_t* name) {
  DWORD type = 0;
  DWORD bytes = 0;
  if (RegQueryValueExW(key, name, nullptr, &type, nullptr, &bytes) != ERROR_SUCCESS ||
      type != REG_MULTI_SZ || bytes < sizeof(wchar_t) * 2 || bytes > kMaximumRegistryStringBytes ||
      bytes % sizeof(wchar_t) != 0) {
    return {};
  }
  std::vector<wchar_t> buffer(bytes / sizeof(wchar_t) + 1, L'\0');
  if (RegQueryValueExW(key, name, nullptr, &type, reinterpret_cast<BYTE*>(buffer.data()), &bytes) != ERROR_SUCCESS) {
    return {};
  }
  std::vector<std::wstring> values;
  const wchar_t* cursor = buffer.data();
  const wchar_t* const end = buffer.data() + buffer.size();
  while (cursor < end && *cursor != L'\0' && values.size() < kMaximumExcludedApplications) {
    const std::size_t remaining = static_cast<std::size_t>(end - cursor);
    const std::size_t length = wcsnlen_s(cursor, remaining);
    if (length == 0 || length == remaining) break;
    if (length <= 256) values.emplace_back(cursor, length);
    cursor += length + 1;
  }
  return values;
}

NativeTypingMode parseMode(const std::optional<std::wstring>& value) {
  if (!value) return NativeTypingMode::RomanizedTraditional;
  if (*value == L"romanized-romanized") return NativeTypingMode::RomanizedRomanized;
  // Traditional key maps remain intentionally unavailable until their source
  // layout is verified; a stale/future value must fail back to usable typing.
  return NativeTypingMode::RomanizedTraditional;
}

std::optional<std::wstring> foregroundApplicationIdentifier() {
  const HWND foreground = GetForegroundWindow();
  if (!foreground) return std::nullopt;
  DWORD processId = 0;
  GetWindowThreadProcessId(foreground, &processId);
  if (processId == 0) return std::nullopt;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
  if (!process) return std::nullopt;
  std::vector<wchar_t> buffer(32768, L'\0');
  DWORD length = static_cast<DWORD>(buffer.size());
  const BOOL queried = QueryFullProcessImageNameW(process, 0, buffer.data(), &length);
  CloseHandle(process);
  if (!queried || length == 0 || length >= buffer.size()) return std::nullopt;
  std::wstring executable(buffer.data(), length);
  const std::size_t separator = executable.find_last_of(L"\\/");
  if (separator != std::wstring::npos) executable.erase(0, separator + 1);
  if (executable.empty() || executable.size() > 184) return std::nullopt;
  std::transform(executable.begin(), executable.end(), executable.begin(), [](wchar_t character) {
    return static_cast<wchar_t>(std::towlower(character));
  });
  return L"win32.exe:" + executable;
}

} // namespace

WindowsPreferences readWindowsPreferences() {
  WindowsPreferences preferences;
  HKEY rawKey = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, kPreferenceKey, 0, KEY_QUERY_VALUE, &rawKey) != ERROR_SUCCESS) {
    return preferences;
  }
  RegistryKey key(rawKey);
  preferences.mode = parseMode(readString(key.get(), kModeValue));
  preferences.inlinePreviewEnabled = readBoolean(key.get(), kInlinePreviewValue, preferences.inlinePreviewEnabled);
  preferences.customCandidatePanelEnabled = readBoolean(key.get(), kCandidatePanelValue, preferences.customCandidatePanelEnabled);
  preferences.proofreadAsYouTypeEnabled = readBoolean(key.get(), kProofreadValue, preferences.proofreadAsYouTypeEnabled);
  preferences.smartPunctuationEnabled = readBoolean(key.get(), kSmartPunctuationValue, preferences.smartPunctuationEnabled);
  preferences.personalizationEnabled = readBoolean(key.get(), kPersonalizationValue, preferences.personalizationEnabled);
  preferences.nextWordPredictionEnabled = readBoolean(key.get(), kNextWordValue, preferences.nextWordPredictionEnabled);
  preferences.excludedApplicationIdentifiers = readMultiString(key.get(), kExcludedApplicationsValue);
  return preferences;
}

bool writeWindowsTypingMode(NativeTypingMode mode) {
  HKEY rawKey = nullptr;
  DWORD disposition = 0;
  if (RegCreateKeyExW(
    HKEY_CURRENT_USER,
    kPreferenceKey,
    0,
    nullptr,
    0,
    KEY_SET_VALUE,
    nullptr,
    &rawKey,
    &disposition
  ) != ERROR_SUCCESS) {
    return false;
  }
  RegistryKey key(rawKey);
  const wchar_t* value = nativeTypingModeName(mode);
  const DWORD bytes = static_cast<DWORD>((wcslen(value) + 1) * sizeof(wchar_t));
  return RegSetValueExW(
    key.get(),
    kModeValue,
    0,
    REG_SZ,
    reinterpret_cast<const BYTE*>(value),
    bytes
  ) == ERROR_SUCCESS;
}

NativeTypingMode nextWindowsTypingMode(NativeTypingMode mode) {
  return mode == NativeTypingMode::RomanizedTraditional
    ? NativeTypingMode::RomanizedRomanized
    : NativeTypingMode::RomanizedTraditional;
}

const wchar_t* nativeTypingModeName(NativeTypingMode mode) {
  switch (mode) {
    case NativeTypingMode::RomanizedRomanized: return L"romanized-romanized";
    case NativeTypingMode::TraditionalTraditional: return L"traditional-traditional";
    case NativeTypingMode::TraditionalRomanized: return L"traditional-romanized";
    case NativeTypingMode::RomanizedTraditional:
    default: return L"romanized-traditional";
  }
}

bool personalizationAllowedForForegroundApplication(const WindowsPreferences& preferences) {
  if (!preferences.personalizationEnabled) return false;
  const std::optional<std::wstring> identifier = foregroundApplicationIdentifier();
  // If Windows will not disclose the owning process (for example across an
  // elevation boundary), do not learn. An unknown app must never bypass a
  // user's privacy exclusions.
  if (!identifier) return false;
  return std::none_of(
    preferences.excludedApplicationIdentifiers.begin(),
    preferences.excludedApplicationIdentifiers.end(),
    [&identifier](const std::wstring& excluded) {
      return _wcsicmp(identifier->c_str(), excluded.c_str()) == 0;
    }
  );
}

} // namespace lekh::tsf
