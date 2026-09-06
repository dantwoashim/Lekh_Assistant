#include "IpcClient.h"

#include "Guids.h"
#include "LekhPipeServerIdentity.h"
#include "LekhWindowsIdentity.h"
#include "../../shared/ipc/generated/LekhIPCProtocol.generated.h"

#include <algorithm>
#include <atomic>
#include <array>
#include <climits>
#include <filesystem>
#include <iterator>
#include <string>
#include <utility>
#include <vector>

extern HMODULE g_module;

namespace {

constexpr std::size_t kMaximumFrameBytes = lekh::ipc::kMaximumFrameBytes;
constexpr DWORD kTransportCompletionGraceMilliseconds = 15;
constexpr ULONGLONG kCompanionLaunchThrottleMilliseconds = 10000;

DWORD transportTimeout(DWORD protocolTimeout) {
  return protocolTimeout > MAXDWORD - kTransportCompletionGraceMilliseconds
    ? MAXDWORD
    : protocolTimeout + kTransportCompletionGraceMilliseconds;
}

std::string toUtf8(const std::wstring& value) {
  if (value.empty()) return "";
  if (value.size() > static_cast<size_t>(INT_MAX)) return "";
  const int size = WideCharToMultiByte(
    CP_UTF8,
    WC_ERR_INVALID_CHARS,
    value.data(),
    static_cast<int>(value.size()),
    nullptr,
    0,
    nullptr,
    nullptr
  );
  if (size <= 0) return "";
  std::string output(static_cast<size_t>(size), '\0');
  if (WideCharToMultiByte(
    CP_UTF8,
    WC_ERR_INVALID_CHARS,
    value.data(),
    static_cast<int>(value.size()),
    output.data(),
    size,
    nullptr,
    nullptr
  ) != size) {
    return "";
  }
  return output;
}

std::wstring fromUtf8(const char* value, DWORD bytes) {
  if (!value || bytes == 0) return L"";
  if (bytes > static_cast<DWORD>(INT_MAX)) return L"";
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, static_cast<int>(bytes), nullptr, 0);
  if (size <= 0) return L"";
  std::wstring output(static_cast<size_t>(size), L'\0');
  if (MultiByteToWideChar(
    CP_UTF8,
    MB_ERR_INVALID_CHARS,
    value,
    static_cast<int>(bytes),
    output.data(),
    size
  ) != size) {
    return L"";
  }
  return output;
}

std::optional<std::wstring> configuredPipeName() {
  const std::optional<lekh::windows::Sid> currentUser = lekh::windows::currentUserSid();
  const std::optional<std::wstring> sid = currentUser ? currentUser->string() : std::nullopt;
  if (!sid || sid->empty()) return std::nullopt;
  return std::wstring(kLekhPipeNamePrefix) + *sid;
}

std::optional<std::filesystem::path> companionExecutablePath() {
  std::vector<wchar_t> modulePath(1024);
  while (modulePath.size() <= 32768) {
    const DWORD length = GetModuleFileNameW(g_module, modulePath.data(), static_cast<DWORD>(modulePath.size()));
    if (length == 0) return std::nullopt;
    if (length < modulePath.size()) {
      std::filesystem::path directory = std::filesystem::path(std::wstring(modulePath.data(), length)).parent_path();
      for (unsigned int depth = 0; depth < 12 && !directory.empty(); ++depth) {
        if (_wcsicmp(directory.filename().c_str(), L"resources") == 0) {
          const std::filesystem::path executable = directory.parent_path() / L"Lekh Keyboard Companion.exe";
          std::error_code error;
          if (std::filesystem::is_regular_file(executable, error) && !error) return executable;
          return std::nullopt;
        }
        const auto parent = directory.parent_path();
        if (parent == directory) break;
        directory = parent;
      }
      return std::nullopt;
    }
    modulePath.resize(modulePath.size() * 2);
  }
  return std::nullopt;
}

void startCompanionIfNeeded() {
  static std::atomic<ULONGLONG> lastAttempt = 0;
  const ULONGLONG now = GetTickCount64();
  ULONGLONG previous = lastAttempt.load();
  if (previous != 0 && now - previous < kCompanionLaunchThrottleMilliseconds) return;
  if (!lastAttempt.compare_exchange_strong(previous, now)) return;

  const std::optional<std::filesystem::path> executable = companionExecutablePath();
  if (!executable || executable->wstring().find(L'"') != std::wstring::npos) return;
  std::wstring command = L"\"" + executable->wstring() + L"\" --background";
  std::vector<wchar_t> mutableCommand(command.begin(), command.end());
  mutableCommand.push_back(L'\0');
  STARTUPINFOW startup = {};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process = {};
  if (CreateProcessW(
    executable->c_str(), mutableCommand.data(), nullptr, nullptr, FALSE,
    CREATE_NO_WINDOW, nullptr, executable->parent_path().c_str(),
    &startup, &process
  )) {
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
  }
}

std::optional<DWORD> waitForOverlappedBytes(HANDLE handle, OVERLAPPED& overlapped, DWORD timeoutMs) {
  const DWORD waitResult = WaitForSingleObject(overlapped.hEvent, timeoutMs);
  if (waitResult != WAIT_OBJECT_0) {
    CancelIoEx(handle, &overlapped);
    DWORD ignoredBytes = 0;
    GetOverlappedResult(handle, &overlapped, &ignoredBytes, TRUE);
    return std::nullopt;
  }

  DWORD bytes = 0;
  if (!GetOverlappedResult(handle, &overlapped, &bytes, FALSE)) {
    return std::nullopt;
  }
  return bytes;
}

bool writeFileWithTimeout(HANDLE pipe, const char* data, DWORD bytesToWrite, DWORD timeoutMs) {
  OVERLAPPED overlapped = {};
  overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!overlapped.hEvent) return false;

  DWORD bytesWritten = 0;
  BOOL wrote = WriteFile(pipe, data, bytesToWrite, &bytesWritten, &overlapped);
  if (!wrote && GetLastError() == ERROR_IO_PENDING) {
    const std::optional<DWORD> completedBytes = waitForOverlappedBytes(pipe, overlapped, timeoutMs);
    CloseHandle(overlapped.hEvent);
    return completedBytes.has_value() && *completedBytes == bytesToWrite;
  }

  CloseHandle(overlapped.hEvent);
  return wrote && bytesWritten == bytesToWrite;
}

std::optional<DWORD> readFileWithTimeout(HANDLE pipe, char* data, DWORD bufferSize, DWORD timeoutMs) {
  OVERLAPPED overlapped = {};
  overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!overlapped.hEvent) return std::nullopt;

  DWORD bytesRead = 0;
  BOOL read = ReadFile(pipe, data, bufferSize, &bytesRead, &overlapped);
  if (!read && GetLastError() == ERROR_IO_PENDING) {
    const std::optional<DWORD> completedBytes = waitForOverlappedBytes(pipe, overlapped, timeoutMs);
    CloseHandle(overlapped.hEvent);
    return completedBytes;
  }

  CloseHandle(overlapped.hEvent);
  if (!read || bytesRead == 0) return std::nullopt;
  return bytesRead;
}

std::optional<DWORD> remainingTimeout(ULONGLONG startedAt, DWORD timeoutMs) {
  const ULONGLONG elapsed = GetTickCount64() - startedAt;
  if (elapsed >= timeoutMs) return std::nullopt;
  return timeoutMs - static_cast<DWORD>(elapsed);
}

std::optional<std::string> readLineWithDeadline(
  HANDLE pipe,
  ULONGLONG startedAt,
  DWORD timeoutMs
) {
  std::string frame;
  frame.reserve(4096);
  std::array<char, 4096> chunk = {};

  while (frame.size() <= kMaximumFrameBytes) {
    const std::optional<DWORD> remaining = remainingTimeout(startedAt, timeoutMs);
    if (!remaining) return std::nullopt;
    const std::optional<DWORD> bytesRead = readFileWithTimeout(
      pipe,
      chunk.data(),
      static_cast<DWORD>(chunk.size()),
      *remaining
    );
    if (!bytesRead) return std::nullopt;

    const auto newline = std::find(chunk.begin(), chunk.begin() + *bytesRead, '\n');
    const std::size_t contentBytes = static_cast<std::size_t>(newline - chunk.begin());
    if (frame.size() + contentBytes > kMaximumFrameBytes) return std::nullopt;
    frame.append(chunk.data(), contentBytes);

    if (newline != chunk.begin() + *bytesRead) {
      if (std::any_of(newline + 1, chunk.begin() + *bytesRead, [](char value) {
        return value != '\r' && value != '\n';
      })) {
        return std::nullopt;
      }
      if (!frame.empty() && frame.back() == '\r') frame.pop_back();
      return frame;
    }
  }

  return std::nullopt;
}

} // namespace

LekhIpcClient::LekhIpcClient(std::wstring pipeName)
  : pipeName_(std::move(pipeName)) {
  if (pipeName_.empty()) {
    const std::optional<std::wstring> configured = configuredPipeName();
    if (configured) pipeName_ = *configured;
  }
}

std::optional<std::wstring> LekhIpcClient::request(const std::wstring& jsonLine, DWORD timeoutMs) const {
  if (pipeName_.empty()) return std::nullopt;
  const DWORD boundedTransportTimeout = transportTimeout(timeoutMs);
  const ULONGLONG startedAt = GetTickCount64();
  if (!WaitNamedPipeW(pipeName_.c_str(), boundedTransportTimeout)) {
    startCompanionIfNeeded();
    return std::nullopt;
  }

  HANDLE pipe = CreateFileW(
    pipeName_.c_str(),
    GENERIC_READ | GENERIC_WRITE,
    0,
    nullptr,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED,
    nullptr
  );
  if (pipe == INVALID_HANDLE_VALUE) return std::nullopt;
  if (!lekh::pipe::serverIsTrustedBroker(pipe, g_module)) {
    CloseHandle(pipe);
    return std::nullopt;
  }

  std::string payload = toUtf8(jsonLine);
  if (!jsonLine.empty() && payload.empty()) {
    CloseHandle(pipe);
    return std::nullopt;
  }
  if (payload.empty() || payload.back() != '\n') payload.push_back('\n');
  if (payload.size() > kMaximumFrameBytes) {
    CloseHandle(pipe);
    return std::nullopt;
  }
  const DWORD bytesToWrite = static_cast<DWORD>(payload.size());
  const std::optional<DWORD> writeTimeout = remainingTimeout(startedAt, boundedTransportTimeout);
  if (!writeTimeout || !writeFileWithTimeout(pipe, payload.data(), bytesToWrite, *writeTimeout)) {
    CloseHandle(pipe);
    return std::nullopt;
  }

  const std::optional<std::string> response = readLineWithDeadline(pipe, startedAt, boundedTransportTimeout);
  CloseHandle(pipe);
  if (!response || response->empty()) return std::nullopt;

  return fromUtf8(response->data(), static_cast<DWORD>(response->size()));
}
