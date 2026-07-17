#pragma once

#include "LekhWindowsIdentity.h"

#include <string>
#include <windows.h>

namespace lekh::pipe {

class SecurityContext final {
public:
  SecurityContext() = default;
  ~SecurityContext();

  SecurityContext(const SecurityContext&) = delete;
  SecurityContext& operator=(const SecurityContext&) = delete;

  bool initialize();
  SECURITY_ATTRIBUTES* attributes();
  bool validatePipeHandle(HANDLE pipe) const;
  const std::wstring& logonSidString() const;

private:
  PSECURITY_DESCRIPTOR descriptor_ = nullptr;
  SECURITY_ATTRIBUTES attributes_ = {};
  lekh::windows::Sid logonSid_;
  std::wstring logonSidString_;
};

} // namespace lekh::pipe
