#pragma once

#include <optional>
#include <string>
#include <windows.h>

class LekhIpcClient {
public:
  explicit LekhIpcClient(std::wstring pipeName = L"");

  std::optional<std::wstring> request(const std::wstring& jsonLine, DWORD timeoutMs) const;

private:
  std::wstring pipeName_;
};
