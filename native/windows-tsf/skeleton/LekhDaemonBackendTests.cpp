#include "LekhDaemonBackend.h"

#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

std::wstring currentExecutablePath() {
  std::vector<wchar_t> buffer(32768, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  if (length == 0 || length >= buffer.size()) return L"";
  return std::wstring(buffer.data(), length);
}

std::optional<std::wstring> environmentVariable(const wchar_t* name) {
  const DWORD required = GetEnvironmentVariableW(name, nullptr, 0);
  if (required == 0) return std::nullopt;
  std::vector<wchar_t> value(required, L'\0');
  const DWORD length = GetEnvironmentVariableW(name, value.data(), required);
  if (length == 0 || length >= required) return std::nullopt;
  return std::wstring(value.data(), length);
}

void restoreEnvironmentVariable(const wchar_t* name, const std::optional<std::wstring>& value) {
  SetEnvironmentVariableW(name, value ? value->c_str() : nullptr);
}

} // namespace

int main() {
  const std::filesystem::path testExecutable = currentExecutablePath();
  require(!testExecutable.empty(), "could not resolve backend-test executable");
  const std::filesystem::path fixture = testExecutable.parent_path() / L"LekhDaemonBackendFixture.exe";
  require(std::filesystem::is_regular_file(fixture), "backend fixture executable is missing");

  const std::optional<std::wstring> previousNodeOptions = environmentVariable(L"NODE_OPTIONS");
  const std::optional<std::wstring> previousNodePath = environmentVariable(L"NODE_PATH");
  require(SetEnvironmentVariableW(L"NODE_OPTIONS", L"--require=untrusted-module") != FALSE, "could not set test NODE_OPTIONS");
  require(SetEnvironmentVariableW(L"NODE_PATH", L"C:\\untrusted") != FALSE, "could not set test NODE_PATH");

  lekh::pipe::DaemonBackend backend;
  const bool started = backend.start({fixture.wstring(), testExecutable.wstring(), testExecutable.parent_path().wstring()});
  restoreEnvironmentVariable(L"NODE_OPTIONS", previousNodeOptions);
  restoreEnvironmentVariable(L"NODE_PATH", previousNodePath);
  require(started, "failed to start contained backend fixture");
  require(backend.running(), "contained backend fixture exited during startup");

  const std::optional<std::string> first = backend.request("first\n", 1000);
  require(first && *first == "first", "first backend frame was not relayed exactly");
  const std::optional<std::string> second = backend.request("second\n", 1000);
  require(second && *second == "second", "second backend frame was not relayed exactly");
  require(!backend.request("two\nframes\n", 1000), "multi-frame backend request was accepted");
  require(backend.running(), "invalid caller frame poisoned a healthy backend");

  require(!backend.request("__delay__\n", 10), "backend deadline was not enforced");
  require(!backend.running(), "timed-out backend was left alive and protocol-desynchronized");
  std::cout << "Contained daemon backend tests passed\n";
  return 0;
}
