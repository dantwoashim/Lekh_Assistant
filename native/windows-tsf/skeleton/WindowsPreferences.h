#pragma once

#include <string>
#include <vector>

namespace lekh::tsf {

enum class NativeTypingMode {
  RomanizedTraditional,
  RomanizedRomanized,
  TraditionalTraditional,
  TraditionalRomanized
};

struct WindowsPreferences {
  NativeTypingMode mode = NativeTypingMode::RomanizedTraditional;
  bool inlinePreviewEnabled = true;
  bool customCandidatePanelEnabled = false;
  bool proofreadAsYouTypeEnabled = true;
  bool smartPunctuationEnabled = true;
  bool personalizationEnabled = false;
  bool nextWordPredictionEnabled = true;
  std::vector<std::wstring> excludedApplicationIdentifiers;
};

WindowsPreferences readWindowsPreferences();
bool writeWindowsTypingMode(NativeTypingMode mode);
NativeTypingMode nextWindowsTypingMode(NativeTypingMode mode);
const wchar_t* nativeTypingModeName(NativeTypingMode mode);
bool personalizationAllowedForForegroundApplication(const WindowsPreferences& preferences);

} // namespace lekh::tsf
