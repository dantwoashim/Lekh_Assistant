#include "LekhPipeServerIdentity.h"
#include "LekhWindowsIdentity.h"

#include <cstdlib>
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

} // namespace

int main() {
  const std::wstring executable = currentExecutablePath();
  require(!executable.empty(), "could not resolve the identity-test executable");
  const std::optional<lekh::windows::Sid> userSid = lekh::windows::currentUserSid();
  require(userSid && userSid->valid(), "could not resolve the current process user SID");
  require(
    lekh::windows::processRunsAsCurrentUser(GetCurrentProcess()),
    "the current-process pseudo-handle did not match its own user SID"
  );
  require(
    lekh::pipe::processMatchesCurrentUserAndImage(GetCurrentProcess(), executable),
    "current process did not match its exact on-disk image"
  );
  require(
    !lekh::pipe::processMatchesCurrentUserAndImage(GetCurrentProcess(), executable + L".missing"),
    "missing expected image was accepted"
  );
  require(
    !lekh::pipe::processMatchesCurrentUserAndImage(nullptr, executable),
    "invalid process handle was accepted"
  );
  std::cout << "Named-pipe server identity tests passed\n";
  return 0;
}
