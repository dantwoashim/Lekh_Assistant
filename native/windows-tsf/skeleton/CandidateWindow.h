#pragma once

#include "TsfProtocol.h"

#include <windows.h>

#include <cstddef>
#include <string>
#include <vector>

namespace lekh::tsf {

class CandidateWindow {
public:
  CandidateWindow() = default;
  ~CandidateWindow();

  CandidateWindow(const CandidateWindow&) = delete;
  CandidateWindow& operator=(const CandidateWindow&) = delete;

  bool show(const std::vector<Candidate>& candidates, std::size_t selectedIndex);
  void hide();

private:
  bool ensureCreated();
  void paint();
  void replaceFont(UINT dpi);
  std::wstring rowText(const Candidate& candidate, std::size_t index) const;
  static LRESULT CALLBACK windowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam);

  HWND window_ = nullptr;
  HFONT font_ = nullptr;
  std::vector<Candidate> candidates_;
  std::size_t selectedIndex_ = 0;
  int rowHeight_ = 0;
  int horizontalPadding_ = 0;
};

} // namespace lekh::tsf
