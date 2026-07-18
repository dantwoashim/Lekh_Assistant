#include "LekhDaemonBackend.h"

#include "LekhPipeSecurity.h"
#include "../../shared/ipc/generated/LekhIPCProtocol.generated.h"

#include <algorithm>
#include <array>
#include <bcrypt.h>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <iomanip>
#include <limits>
#include <sstream>
#include <utility>
#include <vector>

namespace {

constexpr std::size_t kMaximumFrameBytes = lekh::ipc::kMaximumFrameBytes;
using Deadline = std::chrono::steady_clock::time_point;

class UniqueHandle final {
public:
  UniqueHandle() = default;
  explicit UniqueHandle(HANDLE handle)
    : handle_(handle) {}

  ~UniqueHandle() {
    reset();
  }

  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;

  UniqueHandle(UniqueHandle&& other) noexcept
    : handle_(other.release()) {}

  UniqueHandle& operator=(UniqueHandle&& other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }

  bool valid() const {
    return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE;
  }

  HANDLE get() const {
    return handle_;
  }

  HANDLE release() {
    const HANDLE result = handle_;
    handle_ = nullptr;
    return result;
  }

  void reset(HANDLE handle = nullptr) {
    if (valid()) CloseHandle(handle_);
    handle_ = handle;
  }

private:
  HANDLE handle_ = nullptr;
};

struct PrivateChannel {
  UniqueHandle parent;
  UniqueHandle child;
};

std::optional<std::wstring> executablePath() {
  std::vector<wchar_t> buffer(32768, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  if (length == 0 || length >= buffer.size()) return std::nullopt;
  return std::wstring(buffer.data(), length);
}

std::optional<std::filesystem::path> canonicalFile(const std::filesystem::path& path) {
  std::error_code error;
  if (!std::filesystem::is_regular_file(path, error) || error) return std::nullopt;
  const std::filesystem::path canonical = std::filesystem::canonical(path, error);
  if (error || canonical.empty()) return std::nullopt;
  return canonical;
}

bool pathNameEquals(const std::filesystem::path& path, const wchar_t* expected) {
  return _wcsicmp(path.filename().c_str(), expected) == 0;
}

std::optional<std::wstring> randomChannelName() {
  std::array<unsigned char, 16> random = {};
  if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) {
    return std::nullopt;
  }
  std::wostringstream name;
  name << L"\\\\.\\pipe\\LekhKeyboardBackend-" << GetCurrentProcessId() << L"-";
  name << std::hex << std::setfill(L'0');
  for (const unsigned char byte : random) name << std::setw(2) << static_cast<unsigned int>(byte);
  return name.str();
}

std::optional<PrivateChannel> createPrivateChannel(
  lekh::pipe::SecurityContext& security,
  bool parentReads
) {
  const std::optional<std::wstring> pipeName = randomChannelName();
  if (!pipeName) return std::nullopt;

  const DWORD openMode = (parentReads ? PIPE_ACCESS_INBOUND : PIPE_ACCESS_OUTBOUND) |
    FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE;
  UniqueHandle server(CreateNamedPipeW(
    pipeName->c_str(),
    openMode,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
    1,
    static_cast<DWORD>(kMaximumFrameBytes),
    static_cast<DWORD>(kMaximumFrameBytes),
    50,
    security.attributes()
  ));
  if (!server.valid() || !security.validatePipeHandle(server.get())) return std::nullopt;

  UniqueHandle connectedEvent(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!connectedEvent.valid()) return std::nullopt;
  OVERLAPPED connection = {};
  connection.hEvent = connectedEvent.get();
  const BOOL connectedImmediately = ConnectNamedPipe(server.get(), &connection);
  const DWORD connectError = connectedImmediately ? ERROR_SUCCESS : GetLastError();
  if (!connectedImmediately && connectError != ERROR_IO_PENDING && connectError != ERROR_PIPE_CONNECTED) {
    return std::nullopt;
  }

  SECURITY_ATTRIBUTES inheritable = {};
  inheritable.nLength = sizeof(inheritable);
  inheritable.bInheritHandle = TRUE;
  UniqueHandle client(CreateFileW(
    pipeName->c_str(),
    parentReads ? GENERIC_WRITE : GENERIC_READ,
    0,
    &inheritable,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL,
    nullptr
  ));
  if (!client.valid()) {
    CancelIoEx(server.get(), &connection);
    if (connectError == ERROR_IO_PENDING) {
      DWORD ignored = 0;
      GetOverlappedResult(server.get(), &connection, &ignored, TRUE);
    }
    return std::nullopt;
  }

  if (connectError == ERROR_IO_PENDING) {
    const DWORD wait = WaitForSingleObject(connectedEvent.get(), 1000);
    DWORD ignored = 0;
    if (wait != WAIT_OBJECT_0 || !GetOverlappedResult(server.get(), &connection, &ignored, FALSE)) {
      CancelIoEx(server.get(), &connection);
      GetOverlappedResult(server.get(), &connection, &ignored, TRUE);
      return std::nullopt;
    }
  }

  if (!SetHandleInformation(client.get(), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) return std::nullopt;
  return PrivateChannel{std::move(server), std::move(client)};
}

bool allowedDaemonEnvironmentVariable(const std::wstring& key) {
  // The broker is a security boundary. Do not copy arbitrary credentials,
  // proxy configuration, Node injection flags, or application-specific state
  // from the companion into the contained daemon.
  static constexpr const wchar_t* allowed[] = {
    L"SystemRoot",
    L"WINDIR",
    L"TEMP",
    L"TMP",
    L"USERPROFILE",
    L"APPDATA",
    L"LOCALAPPDATA",
    L"ProgramData",
    L"LANG",
    L"LC_ALL",
    L"TZ"
  };
  return std::any_of(std::begin(allowed), std::end(allowed), [&key](const wchar_t* candidate) {
    return _wcsicmp(key.c_str(), candidate) == 0;
  });
}

std::vector<wchar_t> sanitizedEnvironment() {
  LPWCH rawEnvironment = GetEnvironmentStringsW();
  if (!rawEnvironment) return {};
  std::vector<std::wstring> entries;
  for (const wchar_t* cursor = rawEnvironment; *cursor != L'\0';) {
    std::wstring entry(cursor);
    cursor += entry.size() + 1;
    const std::size_t separator = entry.find(L'=', entry.empty() || entry.front() != L'=' ? 0 : 1);
    const std::wstring key = separator == std::wstring::npos ? entry : entry.substr(0, separator);
    if (allowedDaemonEnvironmentVariable(key)) entries.push_back(std::move(entry));
  }
  FreeEnvironmentStringsW(rawEnvironment);
  entries.emplace_back(L"ELECTRON_RUN_AS_NODE=1");
  std::sort(entries.begin(), entries.end(), [](const std::wstring& left, const std::wstring& right) {
    return _wcsicmp(left.c_str(), right.c_str()) < 0;
  });

  std::size_t characterCount = 1;
  for (const std::wstring& entry : entries) characterCount += entry.size() + 1;
  std::vector<wchar_t> block;
  block.reserve(characterCount);
  for (const std::wstring& entry : entries) {
    block.insert(block.end(), entry.begin(), entry.end());
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  return block;
}

std::wstring quoted(const std::wstring& argument) {
  if (argument.find(L'"') != std::wstring::npos) return L"";
  return L"\"" + argument + L"\"";
}

std::optional<DWORD> remainingMilliseconds(Deadline deadline) {
  const auto now = std::chrono::steady_clock::now();
  if (now >= deadline) return std::nullopt;
  const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
  if (remaining <= 0) return 1;
  return static_cast<DWORD>(std::min<std::int64_t>(remaining, std::numeric_limits<DWORD>::max()));
}

std::optional<DWORD> waitForIo(HANDLE handle, OVERLAPPED& overlapped, Deadline deadline) {
  const std::optional<DWORD> remaining = remainingMilliseconds(deadline);
  if (!remaining) return std::nullopt;
  DWORD bytes = 0;
  if (GetOverlappedResultEx(handle, &overlapped, &bytes, *remaining, FALSE)) return bytes;
  CancelIoEx(handle, &overlapped);
  DWORD ignored = 0;
  GetOverlappedResult(handle, &overlapped, &ignored, TRUE);
  return std::nullopt;
}

bool writeAll(HANDLE handle, const std::string& frame, Deadline deadline) {
  std::size_t offset = 0;
  while (offset < frame.size()) {
    UniqueHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!event.valid()) return false;
    OVERLAPPED overlapped = {};
    overlapped.hEvent = event.get();
    DWORD synchronousBytes = 0;
    const DWORD requestBytes = static_cast<DWORD>(frame.size() - offset);
    const BOOL wrote = WriteFile(handle, frame.data() + offset, requestBytes, &synchronousBytes, &overlapped);
    DWORD completedBytes = synchronousBytes;
    if (!wrote) {
      if (GetLastError() != ERROR_IO_PENDING) return false;
      const std::optional<DWORD> asynchronousBytes = waitForIo(handle, overlapped, deadline);
      if (!asynchronousBytes) return false;
      completedBytes = *asynchronousBytes;
    }
    if (completedBytes == 0 || completedBytes > requestBytes) return false;
    offset += completedBytes;
  }
  return true;
}

std::optional<std::string> readLine(HANDLE handle, std::string& buffered, Deadline deadline) {
  while (true) {
    const std::size_t newline = buffered.find('\n');
    if (newline != std::string::npos) {
      if (newline + 1 > kMaximumFrameBytes) return std::nullopt;
      std::string line = buffered.substr(0, newline);
      buffered.erase(0, newline + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      return line.empty() ? std::nullopt : std::optional<std::string>(std::move(line));
    }
    if (buffered.size() >= kMaximumFrameBytes) return std::nullopt;

    std::array<char, 4096> chunk = {};
    const DWORD readCapacity = static_cast<DWORD>(
      std::min<std::size_t>(chunk.size(), kMaximumFrameBytes - buffered.size())
    );
    UniqueHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!event.valid()) return std::nullopt;
    OVERLAPPED overlapped = {};
    overlapped.hEvent = event.get();
    DWORD synchronousBytes = 0;
    const BOOL read = ReadFile(handle, chunk.data(), readCapacity, &synchronousBytes, &overlapped);
    DWORD completedBytes = synchronousBytes;
    if (!read) {
      if (GetLastError() != ERROR_IO_PENDING) return std::nullopt;
      const std::optional<DWORD> asynchronousBytes = waitForIo(handle, overlapped, deadline);
      if (!asynchronousBytes) return std::nullopt;
      completedBytes = *asynchronousBytes;
    }
    if (completedBytes == 0 || completedBytes > readCapacity) return std::nullopt;
    buffered.append(chunk.data(), completedBytes);
  }
}

} // namespace

namespace lekh::pipe {

std::optional<DaemonLayout> resolveDaemonLayout() {
  const std::optional<std::wstring> executable = executablePath();
  if (!executable) return std::nullopt;
  std::filesystem::path directory = std::filesystem::path(*executable).parent_path();

  for (unsigned int depth = 0; depth < 12 && !directory.empty(); ++depth, directory = directory.parent_path()) {
    if (pathNameEquals(directory, L"resources")) {
      const std::optional<std::filesystem::path> runtime = canonicalFile(
        directory.parent_path() / L"Lekh Keyboard Companion.exe"
      );
      const std::optional<std::filesystem::path> daemon = canonicalFile(
        directory / L"native" / L"daemon" / L"lekh-keyboard-daemon.mjs"
      );
      if (runtime && daemon) return DaemonLayout{runtime->wstring(), daemon->wstring(), directory.parent_path().wstring()};
    }

    std::error_code error;
    if (std::filesystem::is_regular_file(directory / L"package.json", error) && !error) {
      const std::optional<std::filesystem::path> runtime = canonicalFile(
        directory / L"node_modules" / L"electron" / L"dist" / L"electron.exe"
      );
      const std::optional<std::filesystem::path> daemon = canonicalFile(
        directory / L"native" / L"daemon" / L"dist" / L"lekh-keyboard-daemon.mjs"
      );
      if (runtime && daemon) return DaemonLayout{runtime->wstring(), daemon->wstring(), directory.wstring()};
    }
  }
  return std::nullopt;
}

DaemonBackend::~DaemonBackend() {
  std::unique_lock<std::timed_mutex> lock(requestMutex_);
  poison();
  closeResources();
}

bool DaemonBackend::start(const DaemonLayout& layout) {
  std::unique_lock<std::timed_mutex> lock(requestMutex_);
  if (process_ || layout.runtimePath.empty() || layout.daemonPath.empty() || layout.workingDirectory.empty()) return false;
  if (quoted(layout.runtimePath).empty() || quoted(layout.daemonPath).empty()) return false;

  SecurityContext security;
  if (!security.initialize()) return false;
  std::optional<PrivateChannel> standardInput = createPrivateChannel(security, false);
  std::optional<PrivateChannel> standardOutput = createPrivateChannel(security, true);
  if (!standardInput || !standardOutput) return false;

  SECURITY_ATTRIBUTES inheritable = {};
  inheritable.nLength = sizeof(inheritable);
  inheritable.bInheritHandle = TRUE;
  UniqueHandle nullError(CreateFileW(
    L"NUL",
    GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    &inheritable,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL,
    nullptr
  ));
  if (!nullError.valid()) return false;

  SIZE_T attributeBytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
  if (attributeBytes == 0) return false;
  std::vector<unsigned char> attributeStorage(attributeBytes);
  STARTUPINFOEXW startup = {};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = standardInput->child.get();
  startup.StartupInfo.hStdOutput = standardOutput->child.get();
  startup.StartupInfo.hStdError = nullError.get();
  startup.lpAttributeList = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attributeBytes)) return false;

  const std::array<HANDLE, 3> inheritedHandles = {
    standardInput->child.get(),
    standardOutput->child.get(),
    nullError.get()
  };
  if (!UpdateProcThreadAttribute(
    startup.lpAttributeList,
    0,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    const_cast<HANDLE*>(inheritedHandles.data()),
    sizeof(inheritedHandles),
    nullptr,
    nullptr
  )) {
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    return false;
  }

  UniqueHandle job(CreateJobObjectW(nullptr, nullptr));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobLimits = {};
  jobLimits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job.valid() || !SetInformationJobObject(
    job.get(),
    JobObjectExtendedLimitInformation,
    &jobLimits,
    sizeof(jobLimits)
  )) {
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    return false;
  }

  std::vector<wchar_t> environment = sanitizedEnvironment();
  if (environment.empty()) {
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    return false;
  }
  const std::wstring commandLine = quoted(layout.runtimePath) + L" " + quoted(layout.daemonPath) + L" --stdio";
  std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
  mutableCommand.push_back(L'\0');

  PROCESS_INFORMATION process = {};
  const BOOL created = CreateProcessW(
    layout.runtimePath.c_str(),
    mutableCommand.data(),
    nullptr,
    nullptr,
    TRUE,
    CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
    environment.data(),
    layout.workingDirectory.c_str(),
    &startup.StartupInfo,
    &process
  );
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  if (!created) return false;

  UniqueHandle processHandle(process.hProcess);
  UniqueHandle threadHandle(process.hThread);
  if (!AssignProcessToJobObject(job.get(), processHandle.get()) || ResumeThread(threadHandle.get()) == static_cast<DWORD>(-1)) {
    TerminateProcess(processHandle.get(), 1);
    return false;
  }

  standardInput_ = standardInput->parent.release();
  standardOutput_ = standardOutput->parent.release();
  process_ = processHandle.release();
  job_ = job.release();
  poisoned_.store(false);
  return true;
}

bool DaemonBackend::running() const {
  return process_ && !poisoned_.load() && WaitForSingleObject(process_, 0) == WAIT_TIMEOUT;
}

HANDLE DaemonBackend::waitHandle() const {
  return process_;
}

std::optional<std::string> DaemonBackend::request(const std::string& requestFrame, DWORD timeoutMs) {
  if (requestFrame.empty() || requestFrame.size() > kMaximumFrameBytes || requestFrame.back() != '\n' ||
      requestFrame.find('\n') != requestFrame.size() - 1 || timeoutMs == 0) {
    return std::nullopt;
  }
  const Deadline deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  std::unique_lock<std::timed_mutex> lock(requestMutex_, std::defer_lock);
  if (!lock.try_lock_until(deadline)) return std::nullopt;
  if (!running()) return std::nullopt;

  if (!writeAll(standardInput_, requestFrame, deadline)) {
    poison();
    return std::nullopt;
  }
  const std::optional<std::string> response = readLine(standardOutput_, outputBuffer_, deadline);
  if (!response) poison();
  return response;
}

void DaemonBackend::poison() {
  if (poisoned_.exchange(true)) return;
  if (standardInput_) {
    CancelIoEx(standardInput_, nullptr);
    CloseHandle(standardInput_);
    standardInput_ = nullptr;
  }
  if (standardOutput_) {
    CancelIoEx(standardOutput_, nullptr);
    CloseHandle(standardOutput_);
    standardOutput_ = nullptr;
  }
  if (process_ && WaitForSingleObject(process_, 0) == WAIT_TIMEOUT) TerminateProcess(process_, 1);
}

void DaemonBackend::closeResources() {
  if (job_) {
    CloseHandle(job_);
    job_ = nullptr;
  }
  if (process_) {
    WaitForSingleObject(process_, 1000);
    CloseHandle(process_);
    process_ = nullptr;
  }
  outputBuffer_.clear();
}

} // namespace lekh::pipe
