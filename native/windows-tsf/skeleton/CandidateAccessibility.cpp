#include "CandidateAccessibility.h"

#include <ole2.h>
#include <oleauto.h>
#include <UIAutomation.h>

#include <algorithm>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace lekh::tsf {
namespace {

HRESULT stringVariant(const std::wstring& value, VARIANT* result) {
  result->vt = VT_BSTR;
  result->bstrVal = SysAllocStringLen(value.data(), static_cast<UINT>(value.size()));
  return result->bstrVal || value.empty() ? S_OK : E_OUTOFMEMORY;
}

void booleanVariant(bool value, VARIANT* result) {
  result->vt = VT_BOOL;
  result->boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
}

void integerVariant(LONG value, VARIANT* result) {
  result->vt = VT_I4;
  result->lVal = value;
}

std::wstring accessibleSingleLine(std::wstring value) {
  std::replace_if(value.begin(), value.end(), [](wchar_t character) {
    return character < 0x20 || character == 0x7f;
  }, L' ');
  return value;
}

class CandidateUiaItem;

} // namespace

class CandidateAccessibility final :
  public IRawElementProviderSimple,
  public IRawElementProviderFragment,
  public IRawElementProviderFragmentRoot,
  public ISelectionProvider {
public:
  explicit CandidateAccessibility(HWND window) : window_(window) {}

  STDMETHODIMP QueryInterface(REFIID iid, void** object) override;
  STDMETHODIMP_(ULONG) AddRef() override;
  STDMETHODIMP_(ULONG) Release() override;

  STDMETHODIMP get_ProviderOptions(ProviderOptions* result) override;
  STDMETHODIMP GetPatternProvider(PATTERNID patternId, IUnknown** result) override;
  STDMETHODIMP GetPropertyValue(PROPERTYID propertyId, VARIANT* result) override;
  STDMETHODIMP get_HostRawElementProvider(IRawElementProviderSimple** result) override;

  STDMETHODIMP Navigate(NavigateDirection direction, IRawElementProviderFragment** result) override;
  STDMETHODIMP GetRuntimeId(SAFEARRAY** result) override;
  STDMETHODIMP get_BoundingRectangle(UiaRect* result) override;
  STDMETHODIMP GetEmbeddedFragmentRoots(SAFEARRAY** result) override;
  STDMETHODIMP SetFocus() override;
  STDMETHODIMP get_FragmentRoot(IRawElementProviderFragmentRoot** result) override;

  STDMETHODIMP ElementProviderFromPoint(double x, double y, IRawElementProviderFragment** result) override;
  STDMETHODIMP GetFocus(IRawElementProviderFragment** result) override;

  STDMETHODIMP GetSelection(SAFEARRAY** result) override;
  STDMETHODIMP get_CanSelectMultiple(BOOL* result) override;
  STDMETHODIMP get_IsSelectionRequired(BOOL* result) override;

  void detach();
  void update(
    const std::vector<Candidate>& candidates,
    std::size_t selectedIndex,
    int rowHeight,
    bool visible
  );
  void raiseMenuEvent(EVENTID eventId);
  void raiseSelectionEvent();
  LRESULT returnProvider(WPARAM wParam, LPARAM lParam);

  bool itemSnapshot(
    std::size_t index,
    std::wstring* name,
    std::wstring* helpText,
    bool* selected,
    bool* visible
  ) const;
  std::size_t itemCount() const;
  std::size_t selectedIndex() const;
  UiaRect itemRectangle(std::size_t index) const;
  CandidateUiaItem* createItem(std::size_t index);
  bool requestSelection(std::size_t index);

private:
  ~CandidateAccessibility() = default;

  mutable std::mutex mutex_;
  long refCount_ = 1;
  HWND window_ = nullptr;
  std::vector<std::pair<std::wstring, std::wstring>> candidates_;
  std::size_t selectedIndex_ = 0;
  int rowHeight_ = 0;
  bool visible_ = false;
};

namespace {

class CandidateUiaItem final :
  public IRawElementProviderSimple,
  public IRawElementProviderFragment,
  public ISelectionItemProvider {
public:
  CandidateUiaItem(CandidateAccessibility* root, std::size_t index)
    : root_(root), index_(index) {
    root_->AddRef();
  }

  STDMETHODIMP QueryInterface(REFIID iid, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (iid == IID_IUnknown || iid == IID_IRawElementProviderSimple) {
      *object = static_cast<IRawElementProviderSimple*>(this);
    } else if (iid == IID_IRawElementProviderFragment) {
      *object = static_cast<IRawElementProviderFragment*>(this);
    } else if (iid == IID_ISelectionItemProvider) {
      *object = static_cast<ISelectionItemProvider*>(this);
    } else {
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }

  STDMETHODIMP_(ULONG) AddRef() override {
    return static_cast<ULONG>(InterlockedIncrement(&refCount_));
  }

  STDMETHODIMP_(ULONG) Release() override {
    const ULONG count = static_cast<ULONG>(InterlockedDecrement(&refCount_));
    if (count == 0) delete this;
    return count;
  }

  STDMETHODIMP get_ProviderOptions(ProviderOptions* result) override {
    if (!result) return E_POINTER;
    *result = ProviderOptions_ServerSideProvider;
    return S_OK;
  }

  STDMETHODIMP GetPatternProvider(PATTERNID patternId, IUnknown** result) override {
    if (!result) return E_POINTER;
    *result = nullptr;
    if (patternId != UIA_SelectionItemPatternId) return S_OK;
    *result = static_cast<ISelectionItemProvider*>(this);
    AddRef();
    return S_OK;
  }

  STDMETHODIMP GetPropertyValue(PROPERTYID propertyId, VARIANT* result) override {
    if (!result) return E_POINTER;
    VariantInit(result);
    std::wstring name;
    std::wstring helpText;
    bool selected = false;
    bool visible = false;
    if (!root_->itemSnapshot(index_, &name, &helpText, &selected, &visible)) return S_OK;

    switch (propertyId) {
      case UIA_ControlTypePropertyId:
        integerVariant(UIA_ListItemControlTypeId, result);
        return S_OK;
      case UIA_NamePropertyId:
        return stringVariant(name, result);
      case UIA_HelpTextPropertyId:
        return stringVariant(helpText, result);
      case UIA_AutomationIdPropertyId:
        return stringVariant(L"IME_Candidate_" + std::to_wstring(index_ + 1), result);
      case UIA_IsEnabledPropertyId:
      case UIA_IsControlElementPropertyId:
      case UIA_IsContentElementPropertyId:
        booleanVariant(true, result);
        return S_OK;
      case UIA_HasKeyboardFocusPropertyId:
      case UIA_IsKeyboardFocusablePropertyId:
        booleanVariant(false, result);
        return S_OK;
      case UIA_IsOffscreenPropertyId:
        booleanVariant(!visible, result);
        return S_OK;
      case UIA_SelectionItemIsSelectedPropertyId:
        booleanVariant(selected, result);
        return S_OK;
      default:
        return S_OK;
    }
  }

  STDMETHODIMP get_HostRawElementProvider(IRawElementProviderSimple** result) override {
    if (!result) return E_POINTER;
    *result = nullptr;
    return S_OK;
  }

  STDMETHODIMP Navigate(NavigateDirection direction, IRawElementProviderFragment** result) override {
    if (!result) return E_POINTER;
    *result = nullptr;
    if (direction == NavigateDirection_Parent) {
      return root_->QueryInterface(IID_IRawElementProviderFragment, reinterpret_cast<void**>(result));
    }
    std::size_t target = index_;
    if (direction == NavigateDirection_NextSibling) {
      ++target;
    } else if (direction == NavigateDirection_PreviousSibling && target > 0) {
      --target;
    } else {
      return S_OK;
    }
    CandidateUiaItem* item = root_->createItem(target);
    if (!item) return S_OK;
    *result = static_cast<IRawElementProviderFragment*>(item);
    return S_OK;
  }

  STDMETHODIMP GetRuntimeId(SAFEARRAY** result) override {
    if (!result) return E_POINTER;
    *result = SafeArrayCreateVector(VT_I4, 0, 2);
    if (!*result) return E_OUTOFMEMORY;
    LONG position = 0;
    LONG value = UiaAppendRuntimeId;
    HRESULT hr = SafeArrayPutElement(*result, &position, &value);
    position = 1;
    value = static_cast<LONG>(index_ + 1);
    if (SUCCEEDED(hr)) hr = SafeArrayPutElement(*result, &position, &value);
    if (FAILED(hr)) {
      SafeArrayDestroy(*result);
      *result = nullptr;
    }
    return hr;
  }

  STDMETHODIMP get_BoundingRectangle(UiaRect* result) override {
    if (!result) return E_POINTER;
    *result = root_->itemRectangle(index_);
    return S_OK;
  }

  STDMETHODIMP GetEmbeddedFragmentRoots(SAFEARRAY** result) override {
    if (!result) return E_POINTER;
    *result = nullptr;
    return S_OK;
  }

  STDMETHODIMP SetFocus() override {
    return UIA_E_NOTSUPPORTED;
  }

  STDMETHODIMP get_FragmentRoot(IRawElementProviderFragmentRoot** result) override {
    if (!result) return E_POINTER;
    return root_->QueryInterface(IID_IRawElementProviderFragmentRoot, reinterpret_cast<void**>(result));
  }

  STDMETHODIMP Select() override {
    return root_->requestSelection(index_) ? S_OK : UIA_E_ELEMENTNOTAVAILABLE;
  }

  STDMETHODIMP AddToSelection() override {
    return Select();
  }

  STDMETHODIMP RemoveFromSelection() override {
    return UIA_E_NOTSUPPORTED;
  }

  STDMETHODIMP get_IsSelected(BOOL* result) override {
    if (!result) return E_POINTER;
    bool selected = false;
    if (!root_->itemSnapshot(index_, nullptr, nullptr, &selected, nullptr)) {
      *result = FALSE;
      return UIA_E_ELEMENTNOTAVAILABLE;
    }
    *result = selected ? TRUE : FALSE;
    return S_OK;
  }

  STDMETHODIMP get_SelectionContainer(IRawElementProviderSimple** result) override {
    if (!result) return E_POINTER;
    return root_->QueryInterface(IID_IRawElementProviderSimple, reinterpret_cast<void**>(result));
  }

private:
  ~CandidateUiaItem() {
    root_->Release();
  }

  long refCount_ = 1;
  CandidateAccessibility* root_;
  std::size_t index_;
};

} // namespace

STDMETHODIMP CandidateAccessibility::QueryInterface(REFIID iid, void** object) {
  if (!object) return E_POINTER;
  *object = nullptr;
  if (iid == IID_IUnknown || iid == IID_IRawElementProviderSimple) {
    *object = static_cast<IRawElementProviderSimple*>(this);
  } else if (iid == IID_IRawElementProviderFragment) {
    *object = static_cast<IRawElementProviderFragment*>(this);
  } else if (iid == IID_IRawElementProviderFragmentRoot) {
    *object = static_cast<IRawElementProviderFragmentRoot*>(this);
  } else if (iid == IID_ISelectionProvider) {
    *object = static_cast<ISelectionProvider*>(this);
  } else {
    return E_NOINTERFACE;
  }
  AddRef();
  return S_OK;
}

STDMETHODIMP_(ULONG) CandidateAccessibility::AddRef() {
  return static_cast<ULONG>(InterlockedIncrement(&refCount_));
}

STDMETHODIMP_(ULONG) CandidateAccessibility::Release() {
  const ULONG count = static_cast<ULONG>(InterlockedDecrement(&refCount_));
  if (count == 0) delete this;
  return count;
}

STDMETHODIMP CandidateAccessibility::get_ProviderOptions(ProviderOptions* result) {
  if (!result) return E_POINTER;
  *result = ProviderOptions_ServerSideProvider;
  return S_OK;
}

STDMETHODIMP CandidateAccessibility::GetPatternProvider(PATTERNID patternId, IUnknown** result) {
  if (!result) return E_POINTER;
  *result = nullptr;
  if (patternId != UIA_SelectionPatternId) return S_OK;
  *result = static_cast<ISelectionProvider*>(this);
  AddRef();
  return S_OK;
}

STDMETHODIMP CandidateAccessibility::GetPropertyValue(PROPERTYID propertyId, VARIANT* result) {
  if (!result) return E_POINTER;
  VariantInit(result);
  HWND window = nullptr;
  bool visible = false;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    window = window_;
    visible = visible_;
  }
  switch (propertyId) {
    case UIA_ControlTypePropertyId:
      integerVariant(UIA_ListControlTypeId, result);
      return S_OK;
    case UIA_NamePropertyId:
      return stringVariant(L"Lekh Keyboard suggestions", result);
    case UIA_AutomationIdPropertyId:
      return stringVariant(L"IME_Candidate_Window", result);
    case UIA_IsEnabledPropertyId:
    case UIA_IsControlElementPropertyId:
    case UIA_IsContentElementPropertyId:
      booleanVariant(true, result);
      return S_OK;
    case UIA_HasKeyboardFocusPropertyId:
    case UIA_IsKeyboardFocusablePropertyId:
      booleanVariant(false, result);
      return S_OK;
    case UIA_IsOffscreenPropertyId:
      booleanVariant(!visible, result);
      return S_OK;
    case UIA_NativeWindowHandlePropertyId:
      integerVariant(static_cast<LONG>(reinterpret_cast<LONG_PTR>(window)), result);
      return S_OK;
    default:
      return S_OK;
  }
}

STDMETHODIMP CandidateAccessibility::get_HostRawElementProvider(IRawElementProviderSimple** result) {
  if (!result) return E_POINTER;
  HWND window = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    window = window_;
  }
  *result = nullptr;
  return window ? UiaHostProviderFromHwnd(window, result) : UIA_E_ELEMENTNOTAVAILABLE;
}

STDMETHODIMP CandidateAccessibility::Navigate(
  NavigateDirection direction,
  IRawElementProviderFragment** result
) {
  if (!result) return E_POINTER;
  *result = nullptr;
  if (direction != NavigateDirection_FirstChild && direction != NavigateDirection_LastChild) return S_OK;
  const std::size_t count = itemCount();
  if (count == 0) return S_OK;
  CandidateUiaItem* item = createItem(direction == NavigateDirection_FirstChild ? 0 : count - 1);
  if (item) *result = static_cast<IRawElementProviderFragment*>(item);
  return S_OK;
}

STDMETHODIMP CandidateAccessibility::GetRuntimeId(SAFEARRAY** result) {
  if (!result) return E_POINTER;
  *result = nullptr;
  return S_OK;
}

STDMETHODIMP CandidateAccessibility::get_BoundingRectangle(UiaRect* result) {
  if (!result) return E_POINTER;
  HWND window = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    window = window_;
  }
  RECT rectangle = {};
  if (!window || !GetWindowRect(window, &rectangle)) {
    *result = {};
    return S_OK;
  }
  *result = {
    static_cast<double>(rectangle.left),
    static_cast<double>(rectangle.top),
    static_cast<double>(rectangle.right - rectangle.left),
    static_cast<double>(rectangle.bottom - rectangle.top)
  };
  return S_OK;
}

STDMETHODIMP CandidateAccessibility::GetEmbeddedFragmentRoots(SAFEARRAY** result) {
  if (!result) return E_POINTER;
  *result = nullptr;
  return S_OK;
}

STDMETHODIMP CandidateAccessibility::SetFocus() {
  return UIA_E_NOTSUPPORTED;
}

STDMETHODIMP CandidateAccessibility::get_FragmentRoot(IRawElementProviderFragmentRoot** result) {
  if (!result) return E_POINTER;
  *result = static_cast<IRawElementProviderFragmentRoot*>(this);
  AddRef();
  return S_OK;
}

STDMETHODIMP CandidateAccessibility::ElementProviderFromPoint(
  double x,
  double y,
  IRawElementProviderFragment** result
) {
  if (!result) return E_POINTER;
  *result = nullptr;
  HWND window = nullptr;
  int rowHeight = 0;
  bool visible = false;
  std::size_t count = 0;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    window = window_;
    rowHeight = rowHeight_;
    visible = visible_;
    count = candidates_.size();
  }
  RECT rectangle = {};
  if (!window || !visible || rowHeight <= 0 || !GetWindowRect(window, &rectangle) ||
      x < rectangle.left || x >= rectangle.right || y < rectangle.top || y >= rectangle.bottom) {
    return S_OK;
  }
  const std::size_t index = static_cast<std::size_t>((y - rectangle.top) / rowHeight);
  if (index >= count) return S_OK;
  CandidateUiaItem* item = createItem(index);
  if (item) *result = static_cast<IRawElementProviderFragment*>(item);
  return S_OK;
}

STDMETHODIMP CandidateAccessibility::GetFocus(IRawElementProviderFragment** result) {
  if (!result) return E_POINTER;
  *result = nullptr;
  CandidateUiaItem* item = createItem(selectedIndex());
  if (item) *result = static_cast<IRawElementProviderFragment*>(item);
  return S_OK;
}

STDMETHODIMP CandidateAccessibility::GetSelection(SAFEARRAY** result) {
  if (!result) return E_POINTER;
  *result = nullptr;
  CandidateUiaItem* item = createItem(selectedIndex());
  if (!item) return S_OK;
  SAFEARRAY* array = SafeArrayCreateVector(VT_UNKNOWN, 0, 1);
  if (!array) {
    item->Release();
    return E_OUTOFMEMORY;
  }
  LONG index = 0;
  IUnknown* value = static_cast<IRawElementProviderSimple*>(item);
  const HRESULT hr = SafeArrayPutElement(array, &index, value);
  item->Release();
  if (FAILED(hr)) {
    SafeArrayDestroy(array);
    return hr;
  }
  *result = array;
  return S_OK;
}

STDMETHODIMP CandidateAccessibility::get_CanSelectMultiple(BOOL* result) {
  if (!result) return E_POINTER;
  *result = FALSE;
  return S_OK;
}

STDMETHODIMP CandidateAccessibility::get_IsSelectionRequired(BOOL* result) {
  if (!result) return E_POINTER;
  *result = TRUE;
  return S_OK;
}

void CandidateAccessibility::detach() {
  std::lock_guard<std::mutex> lock(mutex_);
  window_ = nullptr;
  candidates_.clear();
  selectedIndex_ = 0;
  rowHeight_ = 0;
  visible_ = false;
}

void CandidateAccessibility::update(
  const std::vector<Candidate>& candidates,
  std::size_t selectedIndex,
  int rowHeight,
  bool visible
) {
  std::lock_guard<std::mutex> lock(mutex_);
  candidates_.clear();
  candidates_.reserve(candidates.size());
  for (const Candidate& candidate : candidates) {
    candidates_.emplace_back(
      accessibleSingleLine(candidate.text),
      accessibleSingleLine(candidate.label)
    );
  }
  selectedIndex_ = candidates_.empty() ? 0 : std::min(selectedIndex, candidates_.size() - 1);
  rowHeight_ = std::max(rowHeight, 0);
  visible_ = visible;
}

void CandidateAccessibility::raiseMenuEvent(EVENTID eventId) {
  if (UiaClientsAreListening()) {
    UiaRaiseAutomationEvent(static_cast<IRawElementProviderSimple*>(this), eventId);
  }
}

void CandidateAccessibility::raiseSelectionEvent() {
  if (!UiaClientsAreListening()) return;
  CandidateUiaItem* item = createItem(selectedIndex());
  if (!item) return;
  UiaRaiseAutomationEvent(
    static_cast<IRawElementProviderSimple*>(item),
    UIA_SelectionItem_ElementSelectedEventId
  );
  item->Release();
}

LRESULT CandidateAccessibility::returnProvider(WPARAM wParam, LPARAM lParam) {
  HWND window = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    window = window_;
  }
  if (!window || static_cast<LONG>(lParam) != UiaRootObjectId) return 0;
  return UiaReturnRawElementProvider(
    window,
    wParam,
    lParam,
    static_cast<IRawElementProviderSimple*>(this)
  );
}

bool CandidateAccessibility::itemSnapshot(
  std::size_t index,
  std::wstring* name,
  std::wstring* helpText,
  bool* selected,
  bool* visible
) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (index >= candidates_.size()) return false;
  if (name) *name = candidates_[index].first;
  if (helpText) *helpText = candidates_[index].second;
  if (selected) *selected = index == selectedIndex_;
  if (visible) *visible = visible_;
  return true;
}

std::size_t CandidateAccessibility::itemCount() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return candidates_.size();
}

std::size_t CandidateAccessibility::selectedIndex() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return selectedIndex_;
}

UiaRect CandidateAccessibility::itemRectangle(std::size_t index) const {
  HWND window = nullptr;
  int rowHeight = 0;
  bool visible = false;
  std::size_t count = 0;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    window = window_;
    rowHeight = rowHeight_;
    visible = visible_;
    count = candidates_.size();
  }
  RECT rectangle = {};
  if (!window || !visible || rowHeight <= 0 || index >= count || !GetWindowRect(window, &rectangle)) return {};
  return {
    static_cast<double>(rectangle.left),
    static_cast<double>(rectangle.top + static_cast<LONG>(index * static_cast<std::size_t>(rowHeight))),
    static_cast<double>(rectangle.right - rectangle.left),
    static_cast<double>(rowHeight)
  };
}

CandidateUiaItem* CandidateAccessibility::createItem(std::size_t index) {
  if (index >= itemCount()) return nullptr;
  return new CandidateUiaItem(this, index);
}

bool CandidateAccessibility::requestSelection(std::size_t index) {
  HWND window = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!visible_ || index >= candidates_.size()) return false;
    window = window_;
  }
  return window && PostMessageW(
    window,
    kCandidateAccessibilitySelectMessage,
    static_cast<WPARAM>(index),
    0
  );
}

CandidateAccessibility* createCandidateAccessibility(HWND window) {
  return window ? new CandidateAccessibility(window) : nullptr;
}

void releaseCandidateAccessibility(CandidateAccessibility** accessibility) {
  if (!accessibility || !*accessibility) return;
  (*accessibility)->Release();
  *accessibility = nullptr;
}

void detachCandidateAccessibility(CandidateAccessibility* accessibility) {
  if (accessibility) accessibility->detach();
}

void updateCandidateAccessibility(
  CandidateAccessibility* accessibility,
  const std::vector<Candidate>& candidates,
  std::size_t selectedIndex,
  int rowHeight,
  bool visible
) {
  if (accessibility) accessibility->update(candidates, selectedIndex, rowHeight, visible);
}

void notifyCandidateMenuOpened(CandidateAccessibility* accessibility) {
  if (accessibility) accessibility->raiseMenuEvent(UIA_MenuOpenedEventId);
}

void notifyCandidateMenuClosed(CandidateAccessibility* accessibility) {
  if (accessibility) accessibility->raiseMenuEvent(UIA_MenuClosedEventId);
}

void notifyCandidateSelectionChanged(CandidateAccessibility* accessibility) {
  if (accessibility) accessibility->raiseSelectionEvent();
}

LRESULT candidateAccessibilityObject(
  CandidateAccessibility* accessibility,
  WPARAM wParam,
  LPARAM lParam
) {
  return accessibility ? accessibility->returnProvider(wParam, lParam) : 0;
}

} // namespace lekh::tsf
