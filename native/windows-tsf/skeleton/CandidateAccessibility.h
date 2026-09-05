#pragma once

#include "TsfProtocol.h"

#include <windows.h>

#include <cstddef>
#include <vector>

namespace lekh::tsf {

inline constexpr UINT kCandidateAccessibilitySelectMessage = WM_APP + 0x431;

// A small server-side UI Automation provider for the non-activating candidate
// popup. It keeps Narrator semantics independent from the visual rendering.
class CandidateAccessibility;

CandidateAccessibility* createCandidateAccessibility(HWND window);
void releaseCandidateAccessibility(CandidateAccessibility** accessibility);
void detachCandidateAccessibility(CandidateAccessibility* accessibility);
void updateCandidateAccessibility(
  CandidateAccessibility* accessibility,
  const std::vector<Candidate>& candidates,
  std::size_t selectedIndex,
  int rowHeight,
  bool visible
);
void notifyCandidateMenuOpened(CandidateAccessibility* accessibility);
void notifyCandidateMenuClosed(CandidateAccessibility* accessibility);
void notifyCandidateSelectionChanged(CandidateAccessibility* accessibility);
LRESULT candidateAccessibilityObject(
  CandidateAccessibility* accessibility,
  WPARAM wParam,
  LPARAM lParam
);

} // namespace lekh::tsf
