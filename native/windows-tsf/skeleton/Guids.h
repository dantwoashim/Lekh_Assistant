#pragma once

#include <windows.h>
#include <msctf.h>
#include "../../shared/ipc/generated/LekhIPCProtocol.generated.h"

// Stable Lekh Keyboard Windows TSF identifiers. These must not change after pilot installation.
// {3F04E1EA-7D90-47E1-865B-11D6F13D0301}
inline constexpr CLSID CLSID_LekhTextService = {
  0x3f04e1ea, 0x7d90, 0x47e1, {0x86, 0x5b, 0x11, 0xd6, 0xf1, 0x3d, 0x03, 0x01}
};

// {8076E28F-3B91-430B-9834-D85F08FE9A6D}
inline constexpr GUID GUID_LekhTextServiceProfile = {
  0x8076e28f, 0x3b91, 0x430b, {0x98, 0x34, 0xd8, 0x5f, 0x08, 0xfe, 0x9a, 0x6d}
};

inline constexpr wchar_t kLekhTextServiceDescription[] = L"Lekh Keyboard Nepali";
inline constexpr wchar_t kLekhPipeNamePrefix[] = L"\\\\.\\pipe\\LekhKeyboard-";
inline constexpr DWORD kLekhHotPathTimeoutMs = static_cast<DWORD>(lekh::ipc::kHotPathDeadlineMilliseconds);

#ifndef LANG_NEPALI
#define LANG_NEPALI 0x61
#endif
