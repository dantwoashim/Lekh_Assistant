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

// Stable identifier for the TSF composition display attribute.
// {B9C4D792-9E04-4FA5-8A3A-779A25977825}
inline constexpr GUID GUID_LekhCompositionDisplayAttribute = {
  0xb9c4d792, 0x9e04, 0x4fa5, {0x8a, 0x3a, 0x77, 0x9a, 0x25, 0x97, 0x78, 0x25}
};

// Stable identifier for host-rendered ghost completion text.
// {5EBF30CC-D310-4B3C-A926-21B48B86E912}
inline constexpr GUID GUID_LekhGhostDisplayAttribute = {
  0x5ebf30cc, 0xd310, 0x4b3c, {0xa9, 0x26, 0x21, 0xb4, 0x8b, 0x86, 0xe9, 0x12}
};

// Stable preserved-key identifiers. These are intentionally separate from the
// language profile so Windows can reserve shortcuts only while Lekh is active.
// {50F9D91F-87EB-4FC4-BDA7-4A812741A042}
inline constexpr GUID GUID_LekhCycleTypingMode = {
  0x50f9d91f, 0x87eb, 0x4fc4, {0xbd, 0xa7, 0x4a, 0x81, 0x27, 0x41, 0xa0, 0x42}
};

// {88C1C91B-4101-43E0-B1AB-9459685437BC}
inline constexpr GUID GUID_LekhRomanizedTraditionalMode = {
  0x88c1c91b, 0x4101, 0x43e0, {0xb1, 0xab, 0x94, 0x59, 0x68, 0x54, 0x37, 0xbc}
};

// {7FF5D1FB-C462-4778-9337-F7E80CD0F4B9}
inline constexpr GUID GUID_LekhRomanizedRomanizedMode = {
  0x7ff5d1fb, 0xc462, 0x4778, {0x93, 0x37, 0xf7, 0xe8, 0x0c, 0xd0, 0xf4, 0xb9}
};

inline constexpr wchar_t kLekhTextServiceDescription[] = L"Lekh Keyboard Nepali";
inline constexpr wchar_t kLekhPipeNamePrefix[] = L"\\\\.\\pipe\\LekhKeyboard-";
inline constexpr DWORD kLekhHotPathTimeoutMs = static_cast<DWORD>(lekh::ipc::kHotPathDeadlineMilliseconds);

#ifndef LANG_NEPALI
#define LANG_NEPALI 0x61
#endif
