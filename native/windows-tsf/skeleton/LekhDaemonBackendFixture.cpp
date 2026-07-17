#include <iostream>
#include <string>
#include <windows.h>

int wmain(int argc, wchar_t**) {
  if (argc < 3) return 2;
  wchar_t electronMode[2] = {};
  if (GetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", electronMode, 2) != 1 || electronMode[0] != L'1') return 3;
  if (GetEnvironmentVariableW(L"NODE_OPTIONS", nullptr, 0) != 0) return 4;
  if (GetEnvironmentVariableW(L"NODE_PATH", nullptr, 0) != 0) return 5;

  std::ios::sync_with_stdio(false);
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line == "__delay__") Sleep(250);
    std::cout << line << '\n' << std::flush;
  }
  return 0;
}
