#pragma once

#include <optional>
#include <string>
#include <vector>
#include <windows.h>

namespace lekh::windows {

class Sid final {
public:
  Sid() = default;
  explicit Sid(std::vector<DWORD> storage);

  bool valid() const;
  PSID get() const;
  std::optional<std::wstring> string() const;

private:
  std::vector<DWORD> storage_;
};

std::optional<Sid> currentUserSid();
std::optional<Sid> currentLogonSid();
bool processRunsAsCurrentUser(HANDLE process);

} // namespace lekh::windows
