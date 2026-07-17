#pragma once

#include <string>
#include <windows.h>

namespace lekh::pipe {

bool processMatchesCurrentUserAndImage(HANDLE process, const std::wstring& expectedImagePath);
bool serverIsTrustedBroker(HANDLE pipe, HMODULE clientModule);

} // namespace lekh::pipe
