#pragma once

#include "TsfProtocol.h"

#include <windows.h>

#include <cstddef>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace lekh::tsf {

class CandidateAccessibility;

class CandidateWindow {
public:
  CandidateWindow() = default;
  ~CandidateWindow();

  CandidateWindow(const CandidateWindow&) = delete;
  CandidateWindow& operator=(const CandidateWindow&) = delete;

  bool show(
    const std::vector<Candidate>& candidates,
    std::size_t selectedIndex,
    const RECT* textExtent = nullptr,
    HWND ownerWindow = nullptr
  );
  void setCandidateInvokedCallback(std::function<void(std::size_t)> callback);
  bool initializeDispatcher();
  bool post(std::function<void()> callback);
  void hide();

private:
  bool ensureCreated();
  bool ensureDispatcherCreated();
  void paint();
  void replaceFont(UINT dpi);
  std::wstring rowText(const Candidate& candidate, std::size_t index) const;
  void invokeCandidateAt(int y);
  static LRESULT CALLBACK windowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam);

  HWND window_ = nullptr;
  HWND dispatcherWindow_ = nullptr;
  HFONT font_ = nullptr;
  UINT fontDpi_ = 0;
  bool ownsFont_ = false;
  std::vector<Candidate> candidates_;
  std::size_t selectedIndex_ = 0;
  int rowHeight_ = 0;
  int horizontalPadding_ = 0;
  std::optional<POINT> textAnchor_;
  HWND ownerWindow_ = nullptr;
  CandidateAccessibility* accessibility_ = nullptr;
  std::function<void(std::size_t)> candidateInvoked_;
};

} // namespace lekh::tsf
