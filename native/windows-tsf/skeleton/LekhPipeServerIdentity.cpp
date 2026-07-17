#include "LekhPipeServerIdentity.h"

#include "LekhWindowsIdentity.h"

#include <filesystem>
#include <optional>
#include <vector>

namespace {

std::optional<std::wstring> modulePath(HMODULE module) {
  if (!module) return std::nullopt;
  std::vector<wchar_t> buffer(32768, L'\0');
  const DWORD length = GetModuleFileNameW(module, buffer.data(), static_cast<DWORD>(buffer.size()));
  if (length == 0 || length >= buffer.size()) return std::nullopt;
  return std::wstring(buffer.data(), length);
}

std::optional<std::wstring> processImagePath(HANDLE process) {
  // QueryFullProcessImageName accepts the GetCurrentProcess() pseudo-handle,
  // whose value is also used as INVALID_HANDLE_VALUE by file APIs.
  if (!process) return std::nullopt;
  std::vector<wchar_t> buffer(32768, L'\0');
  DWORD length = static_cast<DWORD>(buffer.size());
  if (!QueryFullProcessImageNameW(process, 0, buffer.data(), &length) || length == 0) return std::nullopt;
  return std::wstring(buffer.data(), length);
}

class FileHandle final {
public:
  explicit FileHandle(const std::wstring& path)
    : handle_(CreateFileW(
        path.c_str(),
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr
      )) {}

  ~FileHandle() {
    if (valid()) CloseHandle(handle_);
  }

  FileHandle(const FileHandle&) = delete;
  FileHandle& operator=(const FileHandle&) = delete;

  bool valid() const {
    return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE;
  }

  bool information(BY_HANDLE_FILE_INFORMATION& information) const {
    return valid() && GetFileInformationByHandle(handle_, &information);
  }

private:
  HANDLE handle_ = INVALID_HANDLE_VALUE;
};

bool sameFile(const std::wstring& leftPath, const std::wstring& rightPath) {
  FileHandle left(leftPath);
  FileHandle right(rightPath);
  BY_HANDLE_FILE_INFORMATION leftInformation = {};
  BY_HANDLE_FILE_INFORMATION rightInformation = {};
  if (!left.information(leftInformation) || !right.information(rightInformation)) return false;
  if ((leftInformation.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ||
      (rightInformation.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    return false;
  }
  return leftInformation.dwVolumeSerialNumber == rightInformation.dwVolumeSerialNumber &&
    leftInformation.nFileIndexHigh == rightInformation.nFileIndexHigh &&
    leftInformation.nFileIndexLow == rightInformation.nFileIndexLow;
}

} // namespace

namespace lekh::pipe {

bool processMatchesCurrentUserAndImage(HANDLE process, const std::wstring& expectedImagePath) {
  if (expectedImagePath.empty() || !lekh::windows::processRunsAsCurrentUser(process)) return false;
  const std::optional<std::wstring> actualImagePath = processImagePath(process);
  return actualImagePath && sameFile(*actualImagePath, expectedImagePath);
}

bool serverIsTrustedBroker(HANDLE pipe, HMODULE clientModule) {
  if (!pipe || pipe == INVALID_HANDLE_VALUE || !clientModule) return false;
  ULONG serverProcessId = 0;
  if (!GetNamedPipeServerProcessId(pipe, &serverProcessId) || serverProcessId == 0) return false;

  HANDLE serverProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, serverProcessId);
  if (!serverProcess) return false;

  const std::optional<std::wstring> module = modulePath(clientModule);
  const std::wstring expectedBroker = module
    ? (std::filesystem::path(*module).parent_path() / L"LekhPipeBroker.exe").wstring()
    : L"";
  const bool trusted = processMatchesCurrentUserAndImage(serverProcess, expectedBroker);
  CloseHandle(serverProcess);
  return trusted;
}

} // namespace lekh::pipe
