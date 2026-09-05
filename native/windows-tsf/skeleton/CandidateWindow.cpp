#include "CandidateWindow.h"

#include "CandidateAccessibility.h"

#include <algorithm>
#include <cwchar>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <utility>

extern HMODULE g_module;

namespace lekh::tsf {
namespace {

constexpr wchar_t kCandidateWindowClass[] = L"LekhCandidateWindow.v1";
constexpr UINT kRunPostedCallbackMessage = WM_APP + 0x71;

int scaled(int value, UINT dpi) {
  return MulDiv(value, static_cast<int>(dpi), 96);
}

POINT fallbackCandidateAnchor() {
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
  detachCandidateAccessibility(accessibility_);
  if (dispatcherWindow_) DestroyWindow(dispatcherWindow_);
  if (window_) DestroyWindow(window_);
  releaseCandidateAccessibility(&accessibility_);
  if (font_ && ownsFont_) DeleteObject(font_);
}

void CandidateWindow::setCandidateInvokedCallback(std::function<void(std::size_t)> callback) {
  candidateInvoked_ = std::move(callback);
}

bool CandidateWindow::initializeDispatcher() {
  return ensureDispatcherCreated();
}

bool CandidateWindow::post(std::function<void()> callback) {
  if (!callback || !dispatcherWindow_) return false;
  auto* posted = new (std::nothrow) std::function<void()>(std::move(callback));
  if (!posted) return false;
  if (!PostMessageW(dispatcherWindow_, kRunPostedCallbackMessage, 0, reinterpret_cast<LPARAM>(posted))) {
    delete posted;
    return false;
  }
  return true;
}

bool CandidateWindow::show(
  const std::vector<Candidate>& candidates,
  std::size_t selectedIndex,
  const RECT* textExtent,
  HWND ownerWindow
) {
  if (candidates.empty() || selectedIndex >= candidates.size() || !ensureCreated()) {
    hide();
    return false;
  }

  const bool wasVisible = IsWindowVisible(window_) == TRUE;
  const std::size_t previousSelectedIndex = selectedIndex_;
  const std::wstring previousSelectedText =
    previousSelectedIndex < candidates_.size() ? candidates_[previousSelectedIndex].text : L"";
  candidates_ = candidates;
  if (candidates_.size() > kMaximumCandidateCount) candidates_.resize(kMaximumCandidateCount);
  selectedIndex_ = std::min(selectedIndex, candidates_.size() - 1);
  if (textExtent) textAnchor_ = POINT{textExtent->left, textExtent->bottom};

  HWND requestedOwner = ownerWindow;
  if (!requestedOwner) requestedOwner = ownerWindow_;
  if (!requestedOwner) requestedOwner = GetForegroundWindow();
  if (requestedOwner) {
    const HWND rootOwner = GetAncestor(requestedOwner, GA_ROOT);
    ownerWindow_ = rootOwner ? rootOwner : requestedOwner;
    SetWindowLongPtrW(window_, GWLP_HWNDPARENT, reinterpret_cast<LONG_PTR>(ownerWindow_));
  }

  const HWND dpiWindow = ownerWindow_ ? ownerWindow_ : GetForegroundWindow();
  const UINT dpi = dpiWindow ? GetDpiForWindow(dpiWindow) : GetDpiForSystem();
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
    rowHeight_ = std::max(scaled(34, dpi), static_cast<int>(metrics.tmHeight) + scaled(14, dpi));
  } else {
    rowHeight_ = scaled(38, dpi);
  }
  horizontalPadding_ = scaled(14, dpi);
  for (std::size_t index = 0; index < candidates_.size(); ++index) {
    const std::wstring row = rowText(candidates_[index], index);
    SIZE extent = {};
    if (GetTextExtentPoint32W(device, row.c_str(), static_cast<int>(row.size()), &extent)) {
      contentWidth = std::max(contentWidth, static_cast<int>(extent.cx));
    }
  }
  SelectObject(device, previousFont);
  ReleaseDC(window_, device);

  const int width = std::clamp(contentWidth + horizontalPadding_ * 2, scaled(250, dpi), scaled(620, dpi));
  const int height = rowHeight_ * static_cast<int>(candidates_.size()) + scaled(2, dpi);
  const POINT anchor = textAnchor_.value_or(fallbackCandidateAnchor());
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

  if (!SetWindowPos(
    window_, HWND_TOP, x, y, width, height,
    SWP_NOACTIVATE | SWP_SHOWWINDOW
  )) {
    hide();
    return false;
  }
  RedrawWindow(window_, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN);
  updateCandidateAccessibility(accessibility_, candidates_, selectedIndex_, rowHeight_, true);
  NotifyWinEvent(
    wasVisible ? EVENT_OBJECT_IME_CHANGE : EVENT_OBJECT_IME_SHOW,
    window_,
    OBJID_CLIENT,
    CHILDID_SELF
  );
  if (!wasVisible) {
    notifyCandidateMenuOpened(accessibility_);
    notifyCandidateSelectionChanged(accessibility_);
  } else if (selectedIndex_ != previousSelectedIndex ||
             candidates_[selectedIndex_].text != previousSelectedText) {
    notifyCandidateSelectionChanged(accessibility_);
  }
  return true;
}

void CandidateWindow::hide() {
  const bool wasVisible = window_ && IsWindowVisible(window_) == TRUE;
  candidates_.clear();
  selectedIndex_ = 0;
  textAnchor_.reset();
  ownerWindow_ = nullptr;
  if (window_) {
    ShowWindow(window_, SW_HIDE);
    SetWindowLongPtrW(window_, GWLP_HWNDPARENT, 0);
  }
  updateCandidateAccessibility(accessibility_, candidates_, selectedIndex_, rowHeight_, false);
  if (wasVisible) {
    NotifyWinEvent(EVENT_OBJECT_IME_HIDE, window_, OBJID_CLIENT, CHILDID_SELF);
    notifyCandidateMenuClosed(accessibility_);
  }
}

bool CandidateWindow::ensureDispatcherCreated() {
  if (dispatcherWindow_) return true;
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
  dispatcherWindow_ = CreateWindowExW(
    0,
    kCandidateWindowClass,
    L"",
    0,
    0, 0, 0, 0,
    HWND_MESSAGE, nullptr, g_module, this
  );
  return dispatcherWindow_ != nullptr;
}

bool CandidateWindow::ensureCreated() {
  if (window_) return true;
  if (!ensureDispatcherCreated()) return false;
  window_ = CreateWindowExW(
    WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
    kCandidateWindowClass,
    L"Lekh suggestions",
    WS_POPUP | WS_BORDER,
    0, 0, 0, 0,
    nullptr, nullptr, g_module, this
  );
  if (window_) accessibility_ = createCandidateAccessibility(window_);
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
  if (font_ && fontDpi_ == dpi) return;
  if (font_) {
    if (ownsFont_) DeleteObject(font_);
    font_ = nullptr;
    ownsFont_ = false;
  }
  font_ = CreateFontW(
    -scaled(16, dpi), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
    DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
    DEFAULT_PITCH | FF_DONTCARE, L"Nirmala UI"
  );
  ownsFont_ = font_ != nullptr;
  if (!font_) font_ = static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
  fontDpi_ = dpi;
}

std::wstring CandidateWindow::rowText(const Candidate& candidate, std::size_t index) const {
  const std::wstring shortcut = candidate.shortcut.empty() ? std::to_wstring(index + 1) : singleLine(candidate.shortcut);
  std::wstring output = shortcut + L".  " + singleLine(candidate.text);
  if (!candidate.label.empty()) output += L"    " + singleLine(candidate.label);
  return output;
}

void CandidateWindow::invokeCandidateAt(int y) {
  if (y < 0 || rowHeight_ <= 0 || !candidateInvoked_) return;
  const std::size_t index = static_cast<std::size_t>(y / rowHeight_);
  if (index < candidates_.size()) candidateInvoked_(index);
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
      if (self && window == self->window_) self->paint();
      else ValidateRect(window, nullptr);
      return 0;
    case WM_ERASEBKGND:
      return 1;
    case WM_MOUSEACTIVATE:
      return MA_NOACTIVATE;
    case WM_LBUTTONUP:
      if (self) self->invokeCandidateAt(static_cast<int>(static_cast<short>(HIWORD(lParam))));
      return 0;
    case kCandidateAccessibilitySelectMessage:
      if (self && wParam < self->candidates_.size() && self->rowHeight_ > 0) {
        self->invokeCandidateAt(static_cast<int>(wParam) * self->rowHeight_);
      }
      return 0;
    case kRunPostedCallbackMessage: {
      std::unique_ptr<std::function<void()>> callback(
        reinterpret_cast<std::function<void()>*>(lParam)
      );
      if (callback && *callback) (*callback)();
      return 0;
    }
    case WM_GETOBJECT:
      if (self && window == self->window_) {
        const LRESULT provider = candidateAccessibilityObject(self->accessibility_, wParam, lParam);
        if (provider) return provider;
      }
      break;
    default:
      break;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

} // namespace lekh::tsf
