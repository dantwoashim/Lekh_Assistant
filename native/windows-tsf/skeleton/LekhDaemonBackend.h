#pragma once

#include <atomic>
#include <mutex>
#include <optional>
#include <string>
#include <windows.h>

namespace lekh::pipe {

struct DaemonLayout {
  std::wstring runtimePath;
  std::wstring daemonPath;
  std::wstring workingDirectory;
};

std::optional<DaemonLayout> resolveDaemonLayout();

class DaemonBackend final {
public:
  DaemonBackend() = default;
  ~DaemonBackend();

  DaemonBackend(const DaemonBackend&) = delete;
  DaemonBackend& operator=(const DaemonBackend&) = delete;

  bool start(const DaemonLayout& layout);
  bool running() const;
  HANDLE waitHandle() const;
  std::optional<std::string> request(const std::string& requestFrame, DWORD timeoutMs);

private:
  void poison();
  void closeResources();

  HANDLE process_ = nullptr;
  HANDLE standardInput_ = nullptr;
  HANDLE standardOutput_ = nullptr;
  HANDLE job_ = nullptr;
  std::atomic_bool poisoned_ = false;
  std::string outputBuffer_;
  std::timed_mutex requestMutex_;
};

} // namespace lekh::pipe
