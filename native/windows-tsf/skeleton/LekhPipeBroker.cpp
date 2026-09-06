#include "Guids.h"
#include "LekhDaemonBackend.h"
#include "LekhPipeSecurity.h"
#include "LekhWindowsIdentity.h"
#include "TsfProtocol.h"
#include "../../shared/ipc/generated/LekhIPCProtocol.generated.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <climits>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>
#include <windows.h>

namespace {

constexpr std::size_t kMaximumFrameBytes = lekh::ipc::kMaximumFrameBytes;
constexpr DWORD kHotPathDeadlineMilliseconds = static_cast<DWORD>(lekh::ipc::kHotPathDeadlineMilliseconds);
constexpr DWORD kControlDeadlineMilliseconds = static_cast<DWORD>(lekh::ipc::kControlDeadlineMilliseconds);
constexpr std::size_t kMaximumConnections = lekh::ipc::kMaximumActiveConnections;
constexpr std::size_t kWorkerCount = 8;
static_assert(kMaximumConnections > kWorkerCount + 1);
constexpr std::size_t kQueueCapacity = kMaximumConnections - kWorkerCount - 1;
constexpr DWORD kTransportCompletionGraceMilliseconds = 15;
constexpr DWORD kStartupReadinessTimeoutMilliseconds = 30000;
constexpr DWORD kStartupWarmBudgetMilliseconds = 4500;
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

void closeConnectedPipe(HANDLE pipe) {
  if (!pipe || pipe == INVALID_HANDLE_VALUE) return;
  CancelIoEx(pipe, nullptr);
  DisconnectNamedPipe(pipe);
  CloseHandle(pipe);
}

class ClientQueue final {
public:
  ~ClientQueue() {
    stop();
  }

  bool push(HANDLE pipe) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopping_ || clients_.size() >= kQueueCapacity) return false;
    clients_.push_back(pipe);
    ready_.notify_one();
    return true;
  }

  std::optional<HANDLE> pop() {
    std::unique_lock<std::mutex> lock(mutex_);
    ready_.wait(lock, [this] { return stopping_ || !clients_.empty(); });
    if (clients_.empty()) return std::nullopt;
    const HANDLE pipe = clients_.front();
    clients_.pop_front();
    return pipe;
  }

  void stop() {
    std::deque<HANDLE> pending;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (stopping_) return;
      stopping_ = true;
      pending.swap(clients_);
    }
    ready_.notify_all();
    for (const HANDLE pipe : pending) closeConnectedPipe(pipe);
  }

private:
  std::mutex mutex_;
  std::condition_variable ready_;
  std::deque<HANDLE> clients_;
  bool stopping_ = false;
};

std::optional<DWORD> remainingMilliseconds(Deadline deadline) {
  const auto now = std::chrono::steady_clock::now();
  if (now >= deadline) return std::nullopt;
  const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
  if (remaining <= 0) return 1;
  return static_cast<DWORD>(std::min<std::int64_t>(remaining, MAXDWORD));
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

std::optional<std::string> readClientFrame(HANDLE pipe, Deadline deadline) {
  std::string frame;
  frame.reserve(4096);
  std::array<char, 4096> chunk = {};

  while (frame.size() < kMaximumFrameBytes) {
    UniqueHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!event.valid()) return std::nullopt;
    OVERLAPPED overlapped = {};
    overlapped.hEvent = event.get();
    DWORD synchronousBytes = 0;
    const DWORD capacity = static_cast<DWORD>(
      std::min<std::size_t>(chunk.size(), kMaximumFrameBytes - frame.size())
    );
    const BOOL read = ReadFile(pipe, chunk.data(), capacity, &synchronousBytes, &overlapped);
    DWORD completedBytes = synchronousBytes;
    if (!read) {
      if (GetLastError() != ERROR_IO_PENDING) return std::nullopt;
      const std::optional<DWORD> asynchronousBytes = waitForIo(pipe, overlapped, deadline);
      if (!asynchronousBytes) return std::nullopt;
      completedBytes = *asynchronousBytes;
    }
    if (completedBytes == 0 || completedBytes > capacity) return std::nullopt;

    const auto newline = std::find(chunk.begin(), chunk.begin() + completedBytes, '\n');
    const std::size_t contentBytes = static_cast<std::size_t>(newline - chunk.begin());
    if (frame.size() + contentBytes + (newline != chunk.begin() + completedBytes ? 1 : 0) > kMaximumFrameBytes) {
      return std::nullopt;
    }
    frame.append(chunk.data(), contentBytes);
    if (newline != chunk.begin() + completedBytes) {
      if (std::any_of(newline + 1, chunk.begin() + completedBytes, [](char value) {
        return value != '\r' && value != '\n';
      })) {
        return std::nullopt;
      }
      if (!frame.empty() && frame.back() == '\r') frame.pop_back();
      return frame.empty() ? std::nullopt : std::optional<std::string>(std::move(frame));
    }
  }
  return std::nullopt;
}

bool writeClientFrame(HANDLE pipe, const std::string& response, Deadline deadline) {
  if (response.empty() || response.find('\n') != std::string::npos || response.size() + 1 > kMaximumFrameBytes) return false;
  const std::string frame = response + "\n";
  std::size_t offset = 0;
  while (offset < frame.size()) {
    UniqueHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!event.valid()) return false;
    OVERLAPPED overlapped = {};
    overlapped.hEvent = event.get();
    DWORD synchronousBytes = 0;
    const DWORD requestBytes = static_cast<DWORD>(frame.size() - offset);
    const BOOL wrote = WriteFile(pipe, frame.data() + offset, requestBytes, &synchronousBytes, &overlapped);
    DWORD completedBytes = synchronousBytes;
    if (!wrote) {
      if (GetLastError() != ERROR_IO_PENDING) return false;
      const std::optional<DWORD> asynchronousBytes = waitForIo(pipe, overlapped, deadline);
      if (!asynchronousBytes) return false;
      completedBytes = *asynchronousBytes;
    }
    if (completedBytes == 0 || completedBytes > requestBytes) return false;
    offset += completedBytes;
  }
  return true;
}

std::optional<std::wstring> pipeName() {
  const std::optional<lekh::windows::Sid> currentUser = lekh::windows::currentUserSid();
  const std::optional<std::wstring> sid = currentUser ? currentUser->string() : std::nullopt;
  if (!sid || sid->empty()) return std::nullopt;
  return std::wstring(kLekhPipeNamePrefix) + *sid;
}

UniqueHandle createClientPipe(
  const std::wstring& name,
  lekh::pipe::SecurityContext& security,
  bool firstInstance
) {
  const DWORD firstInstanceFlag = firstInstance ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0;
  UniqueHandle pipe(CreateNamedPipeW(
    name.c_str(),
    PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | firstInstanceFlag,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
    static_cast<DWORD>(kMaximumConnections),
    static_cast<DWORD>(kMaximumFrameBytes),
    static_cast<DWORD>(kMaximumFrameBytes),
    kHotPathDeadlineMilliseconds,
    security.attributes()
  ));
  if (!pipe.valid() || !security.validatePipeHandle(pipe.get())) return {};
  return pipe;
}

enum class ConnectResult {
  Connected,
  BackendStopped,
  Failed
};

ConnectResult connectClientPipe(HANDLE pipe, HANDLE backendProcess) {
  UniqueHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!event.valid()) return ConnectResult::Failed;
  OVERLAPPED overlapped = {};
  overlapped.hEvent = event.get();
  if (ConnectNamedPipe(pipe, &overlapped)) return ConnectResult::Connected;

  const DWORD error = GetLastError();
  if (error == ERROR_PIPE_CONNECTED) return ConnectResult::Connected;
  if (error != ERROR_IO_PENDING) return ConnectResult::Failed;

  const std::array<HANDLE, 2> waits = {event.get(), backendProcess};
  const DWORD wait = WaitForMultipleObjects(static_cast<DWORD>(waits.size()), waits.data(), FALSE, INFINITE);
  if (wait == WAIT_OBJECT_0) {
    DWORD ignored = 0;
    return GetOverlappedResult(pipe, &overlapped, &ignored, FALSE)
      ? ConnectResult::Connected
      : ConnectResult::Failed;
  }

  CancelIoEx(pipe, &overlapped);
  DWORD ignored = 0;
  GetOverlappedResult(pipe, &overlapped, &ignored, TRUE);
  return wait == WAIT_OBJECT_0 + 1 ? ConnectResult::BackendStopped : ConnectResult::Failed;
}

std::string toUtf8(const std::wstring& value) {
  if (value.empty() || value.size() > static_cast<std::size_t>(INT_MAX)) return "";
  const int bytes = WideCharToMultiByte(
    CP_UTF8,
    WC_ERR_INVALID_CHARS,
    value.data(),
    static_cast<int>(value.size()),
    nullptr,
    0,
    nullptr,
    nullptr
  );
  if (bytes <= 0) return "";
  std::string output(static_cast<std::size_t>(bytes), '\0');
  if (WideCharToMultiByte(
    CP_UTF8,
    WC_ERR_INVALID_CHARS,
    value.data(),
    static_cast<int>(value.size()),
    output.data(),
    bytes,
    nullptr,
    nullptr
  ) != bytes) {
    return "";
  }
  return output;
}

std::wstring fromUtf8(const std::string& value) {
  if (value.empty() || value.size() > static_cast<std::size_t>(INT_MAX)) return L"";
  const int characters = MultiByteToWideChar(
    CP_UTF8,
    MB_ERR_INVALID_CHARS,
    value.data(),
    static_cast<int>(value.size()),
    nullptr,
    0
  );
  if (characters <= 0) return L"";
  std::wstring output(static_cast<std::size_t>(characters), L'\0');
  if (MultiByteToWideChar(
    CP_UTF8,
    MB_ERR_INVALID_CHARS,
    value.data(),
    static_cast<int>(value.size()),
    output.data(),
    characters
  ) != characters) {
    return L"";
  }
  return output;
}

std::uint64_t epochMilliseconds() {
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()
  ).count());
}

DWORD deadlineClassBudget(lekh::tsf::RequestDeadlineClass deadlineClass) {
  return deadlineClass == lekh::tsf::RequestDeadlineClass::Control
    ? kControlDeadlineMilliseconds
    : kHotPathDeadlineMilliseconds;
}

std::optional<Deadline> operationDeadlineFor(const lekh::tsf::RequestTiming& timing) {
  const DWORD classBudget = deadlineClassBudget(timing.deadlineClass);
  std::uint64_t budget = classBudget;
  if (timing.hasValidDeadline) {
    const std::uint64_t now = epochMilliseconds();
    if (timing.deadlineAt <= now) return std::nullopt;
    budget = std::min<std::uint64_t>(budget, timing.deadlineAt - now);
  }
  if (budget == 0) return std::nullopt;
  return std::chrono::steady_clock::now() + std::chrono::milliseconds(budget);
}

Deadline responseDeadlineFor(Deadline operationDeadline) {
  return operationDeadline + std::chrono::milliseconds(kTransportCompletionGraceMilliseconds);
}

bool verifyBackendReadiness(lekh::pipe::DaemonBackend& backend) {
  // Allow cold process initialization without extending protocol deadlines.
  if (!backend.waitForReady(kStartupReadinessTimeoutMilliseconds)) return false;
  constexpr DWORD readinessTimeoutMs = kControlDeadlineMilliseconds;
  const std::uint64_t sentAt = epochMilliseconds();
  const std::wstring clientInstanceId = L"windows-broker-startup-" + std::to_wstring(GetCurrentProcessId());
  const lekh::tsf::RequestMetadata metadata = {
    L"broker_startup",
    clientInstanceId,
    1,
    sentAt,
    sentAt + readinessTimeoutMs
  };
  const std::wstring request = lekh::tsf::makeProtocolNegotiationRequest(metadata);
  const std::string utf8 = toUtf8(request);
  if (utf8.empty()) return false;
  const std::optional<std::string> response = backend.request(utf8 + "\n", readinessTimeoutMs);
  if (!response) return false;
  const std::wstring wideResponse = fromUtf8(*response);
  const std::optional<lekh::tsf::NegotiatedProtocol> negotiated = !wideResponse.empty()
    ? lekh::tsf::parseProtocolNegotiationResponse(wideResponse, metadata)
    : std::nullopt;
  if (!negotiated) return false;

  const std::uint64_t warmSentAt = epochMilliseconds();
  const lekh::tsf::RequestMetadata warmMetadata = {
    L"broker_warm",
    clientInstanceId,
    2,
    warmSentAt,
    warmSentAt + readinessTimeoutMs
  };
  const std::wstring warmRequest = lekh::tsf::makeEngineWarmRequest(warmMetadata, kStartupWarmBudgetMilliseconds);
  const std::string warmUtf8 = toUtf8(warmRequest);
  if (warmUtf8.empty()) return false;
  const std::optional<std::string> warmResponse = backend.request(warmUtf8 + "\n", readinessTimeoutMs);
  if (!warmResponse) return false;
  const std::wstring wideWarmResponse = fromUtf8(*warmResponse);
  return !wideWarmResponse.empty() && lekh::tsf::parseEngineWarmResponse(
    wideWarmResponse,
    warmMetadata,
    negotiated->serverInstanceId
  );
}

void serveClient(HANDLE pipe, lekh::pipe::DaemonBackend& backend) {
  const Deadline requestReadDeadline = std::chrono::steady_clock::now() +
    std::chrono::milliseconds(kControlDeadlineMilliseconds + kTransportCompletionGraceMilliseconds);
  const std::optional<std::string> request = readClientFrame(pipe, requestReadDeadline);
  if (!request) {
    closeConnectedPipe(pipe);
    return;
  }

  const std::wstring wideRequest = fromUtf8(*request);
  const lekh::tsf::RequestTiming timing = wideRequest.empty()
    ? lekh::tsf::RequestTiming{}
    : lekh::tsf::inspectRequestTiming(wideRequest);
  const std::optional<Deadline> operationDeadline = operationDeadlineFor(timing);
  if (!operationDeadline) {
    closeConnectedPipe(pipe);
    return;
  }

  const std::optional<DWORD> backendTimeout = remainingMilliseconds(*operationDeadline);
  if (backendTimeout) {
    const std::optional<std::string> response = backend.request(*request + "\n", *backendTimeout);
    if (response && writeClientFrame(pipe, *response, responseDeadlineFor(*operationDeadline))) {
      // DisconnectNamedPipe discards reply bytes that the client has not read yet.
      // Draining here keeps short-lived Node and TSF clients from seeing a
      // successful write as ERROR_BROKEN_PIPE before their response arrives.
      FlushFileBuffers(pipe);
    }
  }
  closeConnectedPipe(pipe);
}

int runBroker() {
  const std::optional<lekh::pipe::DaemonLayout> layout = lekh::pipe::resolveDaemonLayout();
  const std::optional<std::wstring> name = pipeName();
  lekh::pipe::SecurityContext security;
  if (!layout || !name || !security.initialize()) return 10;

  lekh::pipe::DaemonBackend backend;
  if (!backend.start(*layout) || !verifyBackendReadiness(backend)) return 11;

  ClientQueue clients;
  std::vector<std::thread> workers;
  workers.reserve(kWorkerCount);
  for (std::size_t index = 0; index < kWorkerCount; ++index) {
    workers.emplace_back([&clients, &backend] {
      while (const std::optional<HANDLE> pipe = clients.pop()) serveClient(*pipe, backend);
    });
  }

  bool firstInstance = true;
  while (backend.running()) {
    UniqueHandle listener = createClientPipe(*name, security, firstInstance);
    if (!listener.valid()) break;
    firstInstance = false;
    const ConnectResult connected = connectClientPipe(listener.get(), backend.waitHandle());
    if (connected == ConnectResult::BackendStopped) break;
    if (connected == ConnectResult::Failed) continue;
    const HANDLE client = listener.release();
    if (!clients.push(client)) closeConnectedPipe(client);
  }

  clients.stop();
  for (std::thread& worker : workers) worker.join();
  return backend.running() ? 12 : 13;
}

} // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  return runBroker();
}
