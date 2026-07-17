#include "LekhPipeSecurity.h"

#include "../../shared/ipc/generated/LekhIPCProtocol.generated.h"

#include <cstdlib>
#include <iostream>
#include <string>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

} // namespace

int main() {
  lekh::pipe::SecurityContext security;
  require(security.initialize(), "failed to create explicit named-pipe security descriptor");
  require(security.attributes() != nullptr, "security attributes were not exposed");
  require(!security.authorizationSidString().empty(), "authorization SID was not retained");

  const std::wstring pipeName =
    L"\\\\.\\pipe\\LekhKeyboard-SecurityTest-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
    std::to_wstring(GetTickCount64());
  HANDLE pipe = CreateNamedPipeW(
    pipeName.c_str(),
    PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
    static_cast<DWORD>(lekh::ipc::kMaximumActiveConnections),
    static_cast<DWORD>(lekh::ipc::kMaximumFrameBytes),
    static_cast<DWORD>(lekh::ipc::kMaximumFrameBytes),
    50,
    security.attributes()
  );
  require(pipe != INVALID_HANDLE_VALUE, "failed to create secured named pipe");
  require(security.validatePipeHandle(pipe), "created pipe did not preserve the restricted protected DACL");

  HANDLE duplicateFirstInstance = CreateNamedPipeW(
    pipeName.c_str(),
    PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
    static_cast<DWORD>(lekh::ipc::kMaximumActiveConnections),
    4096,
    4096,
    50,
    security.attributes()
  );
  require(duplicateFirstInstance == INVALID_HANDLE_VALUE, "pipe squatting guard accepted a duplicate first instance");
  require(GetLastError() == ERROR_ACCESS_DENIED, "duplicate first instance failed for an unexpected reason");

  CloseHandle(pipe);
  std::cout << "Named-pipe security tests passed\n";
  return 0;
}
