#include "LekhWindowsIdentity.h"

#include <sddl.h>

#include <utility>

namespace {

std::vector<DWORD> tokenInformation(HANDLE process, TOKEN_INFORMATION_CLASS informationClass) {
  if (!process || process == INVALID_HANDLE_VALUE) return {};
  HANDLE token = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &token)) return {};

  DWORD requiredBytes = 0;
  SetLastError(ERROR_SUCCESS);
  GetTokenInformation(token, informationClass, nullptr, 0, &requiredBytes);
  if (requiredBytes == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    CloseHandle(token);
    return {};
  }

  std::vector<DWORD> buffer((requiredBytes + sizeof(DWORD) - 1) / sizeof(DWORD));
  const BOOL read = GetTokenInformation(
    token,
    informationClass,
    buffer.data(),
    static_cast<DWORD>(buffer.size() * sizeof(DWORD)),
    &requiredBytes
  );
  CloseHandle(token);
  if (!read) return {};
  return buffer;
}

std::optional<lekh::windows::Sid> copySid(PSID sid) {
  if (!sid || !IsValidSid(sid)) return std::nullopt;
  const DWORD sidBytes = GetLengthSid(sid);
  std::vector<DWORD> storage((sidBytes + sizeof(DWORD) - 1) / sizeof(DWORD));
  if (!CopySid(sidBytes, storage.data(), sid)) return std::nullopt;
  return lekh::windows::Sid(std::move(storage));
}

std::optional<lekh::windows::Sid> processUserSid(HANDLE process) {
  const std::vector<DWORD> userStorage = tokenInformation(process, TokenUser);
  if (userStorage.empty()) return std::nullopt;
  const auto* user = reinterpret_cast<const TOKEN_USER*>(userStorage.data());
  return copySid(user->User.Sid);
}

} // namespace

namespace lekh::windows {

Sid::Sid(std::vector<DWORD> storage)
  : storage_(std::move(storage)) {}

bool Sid::valid() const {
  return !storage_.empty() && IsValidSid(get());
}

PSID Sid::get() const {
  return storage_.empty() ? nullptr : const_cast<DWORD*>(storage_.data());
}

std::optional<std::wstring> Sid::string() const {
  if (!valid()) return std::nullopt;
  LPWSTR value = nullptr;
  if (!ConvertSidToStringSidW(get(), &value) || !value) return std::nullopt;
  std::wstring result(value);
  LocalFree(value);
  return result;
}

std::optional<Sid> currentUserSid() {
  return processUserSid(GetCurrentProcess());
}

std::optional<Sid> currentLogonSid() {
  const std::vector<DWORD> groupsStorage = tokenInformation(GetCurrentProcess(), TokenGroups);
  if (groupsStorage.empty()) return std::nullopt;
  const auto* groups = reinterpret_cast<const TOKEN_GROUPS*>(groupsStorage.data());
  for (DWORD index = 0; index < groups->GroupCount; ++index) {
    const SID_AND_ATTRIBUTES& group = groups->Groups[index];
    if ((group.Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID) return copySid(group.Sid);
  }
  return std::nullopt;
}

bool processRunsAsCurrentUser(HANDLE process) {
  const std::optional<Sid> current = currentUserSid();
  const std::optional<Sid> candidate = processUserSid(process);
  return current && candidate && current->valid() && candidate->valid() && EqualSid(current->get(), candidate->get());
}

} // namespace lekh::windows
