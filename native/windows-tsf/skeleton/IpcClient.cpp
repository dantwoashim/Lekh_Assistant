#include "IpcClient.h"

#include "Guids.h"

#include <sddl.h>
#include <iterator>
#include <string>
#include <utility>
#include <vector>

namespace {

std::string toUtf8(const std::wstring& value) {
  if (value.empty()) return "";
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string output(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), output.data(), size, nullptr, nullptr);
  return output;
}

std::wstring fromUtf8(const char* value, DWORD bytes) {
  if (!value || bytes == 0) return L"";
  const int size = MultiByteToWideChar(CP_UTF8, 0, value, static_cast<int>(bytes), nullptr, 0);
  std::wstring output(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value, static_cast<int>(bytes), output.data(), size);
  return output;
}

std::optional<std::wstring> currentUserSid() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return std::nullopt;

  DWORD requiredBytes = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &requiredBytes);
  if (requiredBytes == 0) {
    CloseHandle(token);
    return std::nullopt;
  }

  std::vector<BYTE> buffer(requiredBytes);
  if (!GetTokenInformation(token, TokenUser, buffer.data(), requiredBytes, &requiredBytes)) {
    CloseHandle(token);
    return std::nullopt;
  }
  CloseHandle(token);

  const auto* user = reinterpret_cast<TOKEN_USER*>(buffer.data());
  LPWSTR sidString = nullptr;
  if (!ConvertSidToStringSidW(user->User.Sid, &sidString) || !sidString) return std::nullopt;
  std::wstring output(sidString);
  LocalFree(sidString);
  return output;
}

std::wstring configuredPipeName() {
  wchar_t overrideName[256] = {};
  const DWORD length = GetEnvironmentVariableW(L"LEKH_KEYBOARD_PIPE_NAME", overrideName, static_cast<DWORD>(std::size(overrideName)));
  if (length > 0 && length < std::size(overrideName)) return overrideName;

  const std::optional<std::wstring> sid = currentUserSid();
  if (!sid || sid->empty()) return kLekhPipeNameFallback;
  return std::wstring(kLekhPipeNamePrefix) + *sid;
}

} // namespace

LekhIpcClient::LekhIpcClient(std::wstring pipeName)
  : pipeName_(pipeName.empty() ? configuredPipeName() : std::move(pipeName)) {}

bool LekhIpcClient::canConnect(DWORD timeoutMs) const {
  if (!WaitNamedPipeW(pipeName_.c_str(), timeoutMs)) return false;
  HANDLE pipe = CreateFileW(pipeName_.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (pipe == INVALID_HANDLE_VALUE) return false;
  CloseHandle(pipe);
  return true;
}

std::optional<std::wstring> LekhIpcClient::request(const std::wstring& jsonLine, DWORD timeoutMs) const {
  if (!WaitNamedPipeW(pipeName_.c_str(), timeoutMs)) return std::nullopt;

  HANDLE pipe = CreateFileW(pipeName_.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (pipe == INVALID_HANDLE_VALUE) return std::nullopt;

  DWORD mode = PIPE_READMODE_MESSAGE;
  SetNamedPipeHandleState(pipe, &mode, nullptr, nullptr);

  std::string payload = toUtf8(jsonLine);
  if (payload.empty() || payload.back() != '\n') payload.push_back('\n');
  DWORD bytesWritten = 0;
  const DWORD bytesToWrite = static_cast<DWORD>(payload.size());
  const BOOL wrote = WriteFile(pipe, payload.data(), bytesToWrite, &bytesWritten, nullptr);
  if (!wrote || bytesWritten != bytesToWrite) {
    CloseHandle(pipe);
    return std::nullopt;
  }

  std::vector<char> buffer(16384);
  DWORD bytesRead = 0;
  const BOOL read = ReadFile(pipe, buffer.data(), static_cast<DWORD>(buffer.size()), &bytesRead, nullptr);
  CloseHandle(pipe);
  if (!read || bytesRead == 0) return std::nullopt;

  return fromUtf8(buffer.data(), bytesRead);
}
