#include "CandidateWindow.h"

#include <algorithm>
#include <cwchar>
#include <mutex>
#include <string>

extern HMODULE g_module;

namespace lekh::tsf {
namespace {

constexpr wchar_t kCandidateWindowClass[] = L"LekhCandidateWindow.v1";

int scaled(int value, UINT dpi) {
  return MulDiv(value, static_cast<int>(dpi), 96);
}

POINT candidateAnchor() {
  const HWND foreground = GetForegroundWindow();
  if (foreground) {
    GUITHREADINFO information = {};
    information.cbSize = sizeof(information);
    const DWORD threadId = GetWindowThreadProcessId(foreground, nullptr);
    if (threadId != 0 && GetGUIThreadInfo(threadId, &information) && information.hwndCaret) {
      POINT point{information.rcCaret.left, information.rcCaret.bottom};
      if (ClientToScreen(information.hwndCaret, &point)) return point;
    }
  }
  POINT cursor = {};
  if (GetCursorPos(&cursor)) return cursor;
  return {0, 0};
}

std::wstring singleLine(std::wstring value) {
  std::replace_if(value.begin(), value.end(), [](wchar_t character) {
    return character < 0x20 || character == 0x7f;
  }, L' ');
  return value;
}

} // namespace

CandidateWindow::~CandidateWindow() {
  hide();
  if (window_) DestroyWindow(window_);
  if (font_) DeleteObject(font_);
}

bool CandidateWindow::show(const std::vector<Candidate>& candidates, std::size_t selectedIndex) {
  if (candidates.empty() || selectedIndex >= candidates.size() || !ensureCreated()) {
    hide();
    return false;
  }

  candidates_ = candidates;
  if (candidates_.size() > kMaximumCandidateCount) candidates_.resize(kMaximumCandidateCount);
  selectedIndex_ = std::min(selectedIndex, candidates_.size() - 1);

  const HWND foreground = GetForegroundWindow();
  const UINT dpi = foreground ? GetDpiForWindow(foreground) : GetDpiForSystem();
  replaceFont(dpi == 0 ? 96 : dpi);

  HDC device = GetDC(window_);
  if (!device) {
    hide();
    return false;
  }
  const HGDIOBJ previousFont = SelectObject(device, font_);
  int contentWidth = 0;
  TEXTMETRICW metrics = {};
  if (GetTextMetricsW(device, &metrics)) {
    rowHeight_ = std::max(scaled(34, dpi), metrics.tmHeight + scaled(14, dpi));
  } else {
    rowHeight_ = scaled(38, dpi);
  }
  horizontalPadding_ = scaled(14, dpi);
  for (std::size_t index = 0; index < candidates_.size(); ++index) {
    const std::wstring row = rowText(candidates_[index], index);
    SIZE extent = {};
    if (GetTextExtentPoint32W(device, row.c_str(), static_cast<int>(row.size()), &extent)) {
      contentWidth = std::max(contentWidth, extent.cx);
    }
  }
  SelectObject(device, previousFont);
  ReleaseDC(window_, device);

  const int width = std::clamp(contentWidth + horizontalPadding_ * 2, scaled(250, dpi), scaled(620, dpi));
  const int height = rowHeight_ * static_cast<int>(candidates_.size()) + scaled(2, dpi);
  const POINT anchor = candidateAnchor();
  MONITORINFO monitor = {};
  monitor.cbSize = sizeof(monitor);
  const HMONITOR nearest = MonitorFromPoint(anchor, MONITOR_DEFAULTTONEAREST);
  RECT workArea{0, 0, width, height};
  if (nearest) GetMonitorInfoW(nearest, &monitor);
  if (monitor.rcWork.right > monitor.rcWork.left && monitor.rcWork.bottom > monitor.rcWork.top) {
    workArea = monitor.rcWork;
  }

  const int margin = scaled(6, dpi);
  int x = anchor.x;
  int y = anchor.y + margin;
  if (x + width > workArea.right) x = workArea.right - width;
  if (x < workArea.left) x = workArea.left;
  if (y + height > workArea.bottom) y = anchor.y - height - margin;
  if (y < workArea.top) y = workArea.top;

  SetWindowPos(
    window_, HWND_TOPMOST, x, y, width, height,
    SWP_NOACTIVATE | SWP_SHOWWINDOW
  );
  RedrawWindow(window_, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN);
  return true;
}

void CandidateWindow::hide() {
  candidates_.clear();
  selectedIndex_ = 0;
  if (window_) ShowWindow(window_, SW_HIDE);
}

bool CandidateWindow::ensureCreated() {
  if (window_) return true;
  static std::once_flag registration;
  static bool registered = false;
  std::call_once(registration, [] {
    WNDCLASSEXW windowClass = {};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.lpfnWndProc = CandidateWindow::windowProcedure;
    windowClass.hInstance = g_module;
    windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    windowClass.lpszClassName = kCandidateWindowClass;
    registered = RegisterClassExW(&windowClass) != 0 || GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
  });
  if (!registered) return false;
  window_ = CreateWindowExW(
    WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE,
    kCandidateWindowClass,
    L"Lekh suggestions",
    WS_POPUP | WS_BORDER,
    0, 0, 0, 0,
    nullptr, nullptr, g_module, this
  );
  return window_ != nullptr;
}

void CandidateWindow::paint() {
  PAINTSTRUCT painting = {};
  HDC device = BeginPaint(window_, &painting);
  if (!device) return;
  RECT client = {};
  GetClientRect(window_, &client);
  FillRect(device, &client, GetSysColorBrush(COLOR_WINDOW));
  const HGDIOBJ previousFont = SelectObject(device, font_);
  SetBkMode(device, TRANSPARENT);

  for (std::size_t index = 0; index < candidates_.size(); ++index) {
    RECT row{
      0,
      static_cast<LONG>(index * static_cast<std::size_t>(rowHeight_)),
      client.right,
      static_cast<LONG>((index + 1) * static_cast<std::size_t>(rowHeight_))
    };
    const bool selected = index == selectedIndex_;
    if (selected) FillRect(device, &row, GetSysColorBrush(COLOR_HIGHLIGHT));
    SetTextColor(device, GetSysColor(selected ? COLOR_HIGHLIGHTTEXT : COLOR_WINDOWTEXT));
    row.left += horizontalPadding_;
    row.right -= horizontalPadding_;
    const std::wstring text = rowText(candidates_[index], index);
    DrawTextW(device, text.c_str(), static_cast<int>(text.size()), &row,
      DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);
  }

  SelectObject(device, previousFont);
  EndPaint(window_, &painting);
}

void CandidateWindow::replaceFont(UINT dpi) {
  if (font_) {
    DeleteObject(font_);
    font_ = nullptr;
  }
  font_ = CreateFontW(
    -scaled(16, dpi), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
    DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
    DEFAULT_PITCH | FF_DONTCARE, L"Nirmala UI"
  );
  if (!font_) font_ = static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
}

std::wstring CandidateWindow::rowText(const Candidate& candidate, std::size_t index) const {
  const std::wstring shortcut = candidate.shortcut.empty() ? std::to_wstring(index + 1) : singleLine(candidate.shortcut);
  std::wstring output = shortcut + L".  " + singleLine(candidate.text);
  if (!candidate.label.empty()) output += L"    " + singleLine(candidate.label);
  return output;
}

LRESULT CALLBACK CandidateWindow::windowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  CandidateWindow* self = reinterpret_cast<CandidateWindow*>(GetWindowLongPtrW(window, GWLP_USERDATA));
  if (message == WM_NCCREATE) {
    const auto* create = reinterpret_cast<const CREATESTRUCTW*>(lParam);
    self = static_cast<CandidateWindow*>(create->lpCreateParams);
    SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
  }
  switch (message) {
    case WM_PAINT:
      if (self) self->paint();
      return 0;
    case WM_ERASEBKGND:
      return 1;
    case WM_NCHITTEST:
      return HTTRANSPARENT;
    case WM_MOUSEACTIVATE:
      return MA_NOACTIVATEANDEAT;
    default:
      return DefWindowProcW(window, message, wParam, lParam);
  }
}

} // namespace lekh::tsf
