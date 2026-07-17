#include "LekhPipeSecurity.h"

#include <aclapi.h>
#include <sddl.h>

#include <optional>
#include <utility>

namespace {

std::vector<DWORD> localSystemSid() {
  DWORD sidBytes = SECURITY_MAX_SID_SIZE;
  std::vector<DWORD> storage((sidBytes + sizeof(DWORD) - 1) / sizeof(DWORD));
  if (!CreateWellKnownSid(WinLocalSystemSid, nullptr, storage.data(), &sidBytes)) return {};
  return storage;
}

bool grantsFullPipeControl(ACCESS_MASK mask) {
  return (mask & GENERIC_ALL) == GENERIC_ALL || (mask & FILE_ALL_ACCESS) == FILE_ALL_ACCESS;
}

bool validatesRestrictedDacl(PSECURITY_DESCRIPTOR descriptor, PSID logonSid) {
  if (!descriptor || !logonSid || !IsValidSecurityDescriptor(descriptor) || !IsValidSid(logonSid)) return false;

  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  if (!GetSecurityDescriptorControl(descriptor, &control, &revision)) return false;
  if ((control & SE_DACL_PROTECTED) != SE_DACL_PROTECTED) return false;

  BOOL daclPresent = FALSE;
  BOOL daclDefaulted = FALSE;
  PACL dacl = nullptr;
  if (!GetSecurityDescriptorDacl(descriptor, &daclPresent, &dacl, &daclDefaulted)) return false;
  if (!daclPresent || !dacl || daclDefaulted || dacl->AceCount != 2) return false;

  const std::vector<DWORD> systemSidStorage = localSystemSid();
  if (systemSidStorage.empty()) return false;
  PSID systemSid = const_cast<DWORD*>(systemSidStorage.data());
  bool foundLogonSid = false;
  bool foundSystemSid = false;

  for (DWORD index = 0; index < dacl->AceCount; ++index) {
    void* rawAce = nullptr;
    if (!GetAce(dacl, index, &rawAce) || !rawAce) return false;
    const auto* header = static_cast<const ACE_HEADER*>(rawAce);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE || (header->AceFlags & INHERITED_ACE) != 0) return false;
    const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(rawAce);
    PSID trustee = const_cast<DWORD*>(&ace->SidStart);
    if (!IsValidSid(trustee) || !grantsFullPipeControl(ace->Mask)) return false;

    if (EqualSid(trustee, logonSid)) {
      if (foundLogonSid) return false;
      foundLogonSid = true;
    } else if (EqualSid(trustee, systemSid)) {
      if (foundSystemSid) return false;
      foundSystemSid = true;
    } else {
      return false;
    }
  }

  return foundLogonSid && foundSystemSid;
}

} // namespace

namespace lekh::pipe {

SecurityContext::~SecurityContext() {
  if (descriptor_) LocalFree(descriptor_);
}

bool SecurityContext::initialize() {
  if (descriptor_) return false;
  const std::optional<lekh::windows::Sid> logonSid = lekh::windows::currentLogonSid();
  if (!logonSid || !logonSid->valid()) return false;
  logonSid_ = *logonSid;

  const std::optional<std::wstring> logonSidString = logonSid_.string();
  if (!logonSidString) return false;

  const std::wstring sddl = L"D:P(A;;GA;;;SY)(A;;GA;;;" + *logonSidString + L")";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
    sddl.c_str(),
    SDDL_REVISION_1,
    &descriptor,
    nullptr
  )) {
    logonSid_ = {};
    return false;
  }

  if (!validatesRestrictedDacl(descriptor, logonSid_.get())) {
    LocalFree(descriptor);
    logonSid_ = {};
    return false;
  }

  descriptor_ = descriptor;
  logonSidString_ = *logonSidString;
  attributes_.nLength = sizeof(attributes_);
  attributes_.lpSecurityDescriptor = descriptor_;
  attributes_.bInheritHandle = FALSE;
  return true;
}

SECURITY_ATTRIBUTES* SecurityContext::attributes() {
  return descriptor_ ? &attributes_ : nullptr;
}

bool SecurityContext::validatePipeHandle(HANDLE pipe) const {
  if (!descriptor_ || pipe == nullptr || pipe == INVALID_HANDLE_VALUE || !logonSid_.valid()) return false;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD result = GetSecurityInfo(
    pipe,
    SE_KERNEL_OBJECT,
    DACL_SECURITY_INFORMATION,
    nullptr,
    nullptr,
    nullptr,
    nullptr,
    &descriptor
  );
  if (result != ERROR_SUCCESS || !descriptor) return false;
  const bool valid = validatesRestrictedDacl(descriptor, logonSid_.get());
  LocalFree(descriptor);
  return valid;
}

const std::wstring& SecurityContext::logonSidString() const {
  return logonSidString_;
}

} // namespace lekh::pipe
