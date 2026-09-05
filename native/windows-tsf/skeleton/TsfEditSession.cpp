#include "TsfEditSession.h"

#include <inputscope.h>
#include <oleauto.h>
#include <windows.h>

#include <algorithm>
#include <cwchar>
#include <limits>
#include <new>
#include <utility>

extern long g_objectCount;

namespace lekh::tsf {
namespace {

bool isSensitiveInputScope(InputScope scope) {
  switch (scope) {
    case IS_PASSWORD:
    case IS_PRIVATE:
    case IS_NUMERIC_PASSWORD:
    case IS_NUMERIC_PIN:
    case IS_ALPHANUMERIC_PIN:
    case IS_ALPHANUMERIC_PIN_SET:
      return true;
    default:
      return false;
  }
}

bool isKnownInputScope(InputScope scope) {
  const int value = static_cast<int>(scope);
  if (value >= static_cast<int>(IS_DEFAULT) &&
      value <= static_cast<int>(IS_CHAT_WITHOUT_EMOJI)) {
    return true;
  }
  switch (scope) {
    case IS_PHRASELIST:
    case IS_REGULAREXPRESSION:
    case IS_SRGS:
    case IS_XML:
    case IS_ENUMSTRING:
      return true;
    default:
      return false;
  }
}

bool contextCompartmentIsSet(ITfContext* context, REFGUID compartmentId) {
  ITfCompartmentMgr* manager = nullptr;
  HRESULT hr = context->QueryInterface(IID_ITfCompartmentMgr, reinterpret_cast<void**>(&manager));
  if (FAILED(hr) || !manager) return false;
  ITfCompartment* compartment = nullptr;
  hr = manager->GetCompartment(compartmentId, &compartment);
  manager->Release();
  if (FAILED(hr) || !compartment) return false;
  VARIANT value;
  VariantInit(&value);
  hr = compartment->GetValue(&value);
  compartment->Release();
  const bool isSet = SUCCEEDED(hr) && (
    (value.vt == VT_I4 && value.lVal != 0) ||
    (value.vt == VT_BOOL && value.boolVal != VARIANT_FALSE)
  );
  VariantClear(&value);
  return isSet;
}

bool windowUsesPasswordMask(HWND window) {
  if (!window) return false;
  wchar_t className[64] = {};
  const int classLength = GetClassNameW(window, className, static_cast<int>(std::size(className)));
  const bool editClass = classLength > 0 && (
    _wcsicmp(className, L"Edit") == 0 ||
    _wcsnicmp(className, L"RichEdit", 8) == 0
  );
  if (editClass && (GetWindowLongPtrW(window, GWL_STYLE) & ES_PASSWORD) != 0) return true;

  DWORD_PTR passwordCharacter = 0;
  return editClass && SendMessageTimeoutW(
    window,
    EM_GETPASSWORDCHAR,
    0,
    0,
    SMTO_ABORTIFHUNG | SMTO_BLOCK,
    25,
    &passwordCharacter
  ) != 0 && passwordCharacter != 0;
}

bool contextUsesPasswordWindow(ITfContext* context) {
  if (!context) return false;
  if (windowUsesPasswordMask(GetFocus())) return true;
  ITfContextView* view = nullptr;
  HWND window = nullptr;
  const HRESULT hr = context->GetActiveView(&view);
  if (SUCCEEDED(hr) && view) view->GetWnd(&window);
  if (view) view->Release();
  return windowUsesPasswordMask(window);
}

HRESULT inspectInputScopeAtSelection(
  ITfContext* context,
  TfEditCookie editCookie,
  ContextPrivacy* classification
) {
  if (!context || !classification) return E_INVALIDARG;
  *classification = ContextPrivacy::Unknown;

  TF_SELECTION selection = {};
  ULONG selectionCount = 0;
  HRESULT hr = context->GetSelection(
    editCookie,
    TF_DEFAULT_SELECTION,
    1,
    &selection,
    &selectionCount
  );
  if (FAILED(hr) || selectionCount != 1 || !selection.range) {
    return FAILED(hr) ? hr : E_FAIL;
  }
  if (contextUsesPasswordWindow(context)) {
    selection.range->Release();
    *classification = ContextPrivacy::Sensitive;
    return S_OK;
  }

  ITfReadOnlyProperty* property = nullptr;
  hr = context->GetAppProperty(GUID_PROP_INPUTSCOPE, &property);
  // A context owner that does not implement input scopes is the normal path
  // for classic desktop edit controls. Explicit metadata, when present, is
  // still evaluated conservatively below.
  if (hr == S_FALSE || hr == E_NOTIMPL) {
    selection.range->Release();
    *classification = ContextPrivacy::Safe;
    return S_OK;
  }
  if (FAILED(hr) || !property) {
    selection.range->Release();
    return FAILED(hr) ? hr : E_FAIL;
  }

  VARIANT value;
  VariantInit(&value);
  BOOL selectionEmpty = FALSE;
  const HRESULT emptyResult = selection.range->IsEmpty(editCookie, &selectionEmpty);
  const bool collapsedSelection = SUCCEEDED(emptyResult) && selectionEmpty != FALSE;
  hr = property->GetValue(editCookie, selection.range, &value);
  property->Release();
  selection.range->Release();

  // S_FALSE is ambiguous for a non-empty range: it can be uncovered or contain
  // multiple values. A collapsed caret cannot span multiple property values,
  // so in that one case it means there is no input-scope value at the caret.
  if (hr == S_FALSE) {
    VariantClear(&value);
    if (collapsedSelection) *classification = ContextPrivacy::Safe;
    return S_OK;
  }
  if (FAILED(hr)) {
    const bool unsupportedEmptyProperty = hr == E_FAIL && collapsedSelection &&
      (value.vt == VT_EMPTY || value.vt == VT_NULL);
    VariantClear(&value);
    if (unsupportedEmptyProperty) {
      // Some classic/ACP stores surface an unimplemented optional app property
      // as E_FAIL plus VT_EMPTY. Password HWNDs were rejected above, and a
      // non-collapsed/mixed range is never promoted through this compatibility path.
      *classification = ContextPrivacy::Safe;
      return S_OK;
    }
    return hr;
  }
  if (value.vt == VT_EMPTY || value.vt == VT_NULL) {
    VariantClear(&value);
    *classification = ContextPrivacy::Safe;
    return S_OK;
  }

  ITfInputScope* inputScope = nullptr;
  if (value.vt == VT_UNKNOWN && value.punkVal) {
    hr = value.punkVal->QueryInterface(IID_ITfInputScope, reinterpret_cast<void**>(&inputScope));
  } else {
    hr = E_NOINTERFACE;
  }
  VariantClear(&value);
  if (FAILED(hr) || !inputScope) return S_OK;

  InputScope* scopes = nullptr;
  UINT scopeCount = 0;
  hr = inputScope->GetInputScopes(&scopes, &scopeCount);
  inputScope->Release();
  if (hr == S_FALSE || hr == E_NOTIMPL) {
    if (scopes) CoTaskMemFree(scopes);
    return S_OK;
  }
  if (FAILED(hr)) {
    if (scopes) CoTaskMemFree(scopes);
    return hr;
  }
  if (scopeCount == 0) {
    if (scopes) CoTaskMemFree(scopes);
    *classification = ContextPrivacy::Safe;
    return S_OK;
  }
  if (!scopes) return S_OK;

  *classification = classifyInputScopes(scopes, scopeCount);
  CoTaskMemFree(scopes);
  return S_OK;
}

class ScopeEditSession final : public ITfEditSession {
public:
  ScopeEditSession(
    ITfContext* context,
    std::uint64_t contextGeneration = 0,
    PrivacyInspectionCallback callback = {}
  ) : context_(context),
      contextGeneration_(contextGeneration),
      callback_(callback) {
    context_->AddRef();
    if (callback_.lifetimeOwner) callback_.lifetimeOwner->AddRef();
    outcome_.context = context_;
    outcome_.contextGeneration = contextGeneration_;
    InterlockedIncrement(&g_objectCount);
  }

  STDMETHODIMP QueryInterface(REFIID riid, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (riid != IID_IUnknown && riid != IID_ITfEditSession) return E_NOINTERFACE;
    *object = static_cast<ITfEditSession*>(this);
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

  STDMETHODIMP DoEditSession(TfEditCookie editCookie) override {
    outcome_.editSessionRan = true;
    const HRESULT hr = inspect(editCookie);
    outcome_.operationResult = hr;
    outcome_.privacy = inspected_ ? classification_ : ContextPrivacy::Unknown;
    return hr;
  }

  bool inspected() const { return inspected_; }
  ContextPrivacy classification() const { return classification_; }
  PrivacyInspectionOutcome snapshot() const { return outcome_; }
  void cancelCompletion() { completionArmed_ = false; }
  void disarmCompletion() { completionArmed_ = false; }

private:
  HRESULT inspect(TfEditCookie editCookie) {
    const HRESULT hr = inspectInputScopeAtSelection(context_, editCookie, &classification_);
    inspected_ = SUCCEEDED(hr);
    return hr;
  }

  ~ScopeEditSession() {
    if (!outcome_.editSessionRan && outcome_.operationResult == E_PENDING) {
      outcome_.operationResult = E_ABORT;
    }
    outcome_.context = context_;
    outcome_.contextGeneration = contextGeneration_;
    outcome_.privacy = inspected_ ? classification_ : ContextPrivacy::Unknown;
    if (completionArmed_ && callback_.function) {
      callback_.function(callback_.context, outcome_);
    }
    if (callback_.lifetimeOwner) callback_.lifetimeOwner->Release();
    context_->Release();
    InterlockedDecrement(&g_objectCount);
  }

  LONG refCount_ = 1;
  ITfContext* context_;
  std::uint64_t contextGeneration_ = 0;
  PrivacyInspectionCallback callback_;
  PrivacyInspectionOutcome outcome_;
  bool inspected_ = false;
  bool completionArmed_ = true;
  ContextPrivacy classification_ = ContextPrivacy::Unknown;
};

HRESULT checkedTextLength(const std::wstring& text, LONG* length) {
  if (!length) return E_POINTER;
  if (text.size() > static_cast<std::size_t>(std::numeric_limits<LONG>::max())) return E_INVALIDARG;
  *length = static_cast<LONG>(text.size());
  return S_OK;
}

HRESULT setSelectionToOffset(
  ITfContext* context,
  TfEditCookie editCookie,
  ITfRange* range,
  std::size_t offset
) {
  if (!context || !range) return E_INVALIDARG;
  if (offset > static_cast<std::size_t>(std::numeric_limits<LONG>::max())) return E_INVALIDARG;
  ITfRange* caretRange = nullptr;
  HRESULT hr = range->Clone(&caretRange);
  if (FAILED(hr) || !caretRange) return FAILED(hr) ? hr : E_FAIL;
  hr = caretRange->Collapse(editCookie, TF_ANCHOR_START);
  LONG shifted = 0;
  if (SUCCEEDED(hr) && offset > 0) {
    hr = caretRange->ShiftEnd(editCookie, static_cast<LONG>(offset), &shifted, nullptr);
    if (SUCCEEDED(hr) && shifted != static_cast<LONG>(offset)) hr = E_INVALIDARG;
  }
  if (SUCCEEDED(hr)) hr = caretRange->Collapse(editCookie, TF_ANCHOR_END);
  if (SUCCEEDED(hr)) {
    TF_SELECTION selection = {};
    selection.range = caretRange;
    selection.style.ase = TF_AE_NONE;
    selection.style.fInterimChar = FALSE;
    hr = context->SetSelection(editCookie, 1, &selection);
  }
  caretRange->Release();
  return hr;
}

HRESULT setCompositionDisplayAttribute(
  ITfContext* context,
  TfEditCookie editCookie,
  ITfRange* range,
  TfGuidAtom atom
) {
  if (!context || !range || atom == TF_INVALID_GUIDATOM) return S_FALSE;
  ITfProperty* property = nullptr;
  HRESULT hr = context->GetProperty(GUID_PROP_ATTRIBUTE, &property);
  if (FAILED(hr) || !property) return FAILED(hr) ? hr : E_NOINTERFACE;
  VARIANT value;
  VariantInit(&value);
  value.vt = VT_I4;
  value.lVal = atom;
  hr = property->SetValue(editCookie, range, &value);
  property->Release();
  return hr;
}

void setMarkedTextDisplayAttributes(
  ITfContext* context,
  TfEditCookie editCookie,
  ITfRange* range,
  std::size_t ghostOffset,
  TfGuidAtom compositionAtom,
  TfGuidAtom ghostAtom
) {
  if (!context || !range) return;
  if (compositionAtom != TF_INVALID_GUIDATOM) {
    setCompositionDisplayAttribute(context, editCookie, range, compositionAtom);
  }
  if (ghostAtom == TF_INVALID_GUIDATOM || ghostOffset > static_cast<std::size_t>(LONG_MAX)) return;

  ITfRange* ghostRange = nullptr;
  if (FAILED(range->Clone(&ghostRange)) || !ghostRange) return;
  LONG shifted = 0;
  const HRESULT shiftedResult = ghostRange->ShiftStart(
    editCookie,
    static_cast<LONG>(ghostOffset),
    &shifted,
    nullptr
  );
  if (SUCCEEDED(shiftedResult) && shifted == static_cast<LONG>(ghostOffset)) {
    setCompositionDisplayAttribute(context, editCookie, ghostRange, ghostAtom);
  }
  ghostRange->Release();
}

void clearCompositionDisplayAttribute(
  ITfContext* context,
  TfEditCookie editCookie,
  ITfRange* range
) {
  if (!context || !range) return;
  ITfProperty* property = nullptr;
  if (SUCCEEDED(context->GetProperty(GUID_PROP_ATTRIBUTE, &property)) && property) {
    property->Clear(editCookie, range);
    property->Release();
  }
}

} // namespace

class CompositionState final : public ITfCompositionSink {
public:
  STDMETHODIMP QueryInterface(REFIID riid, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (riid != IID_IUnknown && riid != IID_ITfCompositionSink) return E_NOINTERFACE;
    *object = static_cast<ITfCompositionSink*>(this);
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

  STDMETHODIMP OnCompositionTerminated(TfEditCookie, ITfComposition* composition) override {
    if (composition_ == composition) clearComposition();
    return S_OK;
  }

  ITfComposition* composition() const { return composition_; }
  ITfRange* fallbackRange() const { return fallbackRange_; }

  void takeComposition(ITfComposition* composition) {
    clearComposition();
    clearFallbackRange();
    composition_ = composition; // Takes the reference returned by StartComposition.
  }

  void clearComposition() {
    ITfComposition* composition = composition_;
    composition_ = nullptr;
    if (composition) composition->Release();
  }

  void takeFallbackRange(ITfRange* range) {
    clearFallbackRange();
    fallbackRange_ = range; // Takes the reference returned by InsertTextAtSelection.
  }

  void clearFallbackRange() {
    ITfRange* range = fallbackRange_;
    fallbackRange_ = nullptr;
    if (range) range->Release();
  }

  bool active() const { return composition_ != nullptr || fallbackRange_ != nullptr; }
  bool failOpen() const { return failOpen_; }
  void enterFailOpen() { failOpen_ = true; }
  bool closing() const { return closing_; }
  void markClosing() { closing_ = true; }
  bool pendingEditsCancelled() const { return pendingEditsCancelled_; }
  void cancelPendingEdits() {
    pendingEditsCancelled_ = true;
    closing_ = true;
  }
  void abandon() {
    cancelPendingEdits();
    clearFallbackRange();
    clearComposition();
  }

  void beginOperation() { ++pendingOperations_; }
  std::uint32_t endOperation() {
    if (pendingOperations_ > 0) --pendingOperations_;
    return pendingOperations_;
  }
  std::uint32_t pendingOperations() const { return pendingOperations_; }

private:
  ~CompositionState() {
    clearFallbackRange();
    clearComposition();
  }

  LONG refCount_ = 1;
  ITfComposition* composition_ = nullptr;
  ITfRange* fallbackRange_ = nullptr;
  std::uint32_t pendingOperations_ = 0;
  bool failOpen_ = false;
  bool closing_ = false;
  bool pendingEditsCancelled_ = false;
};

namespace {

enum class EditKind {
  Decision,
  FailOpen,
  Finish
};

class DocumentEditSession final : public ITfEditSession {
public:
  DocumentEditSession(
    ITfContext* context,
    CompositionState* state,
    EditKind kind,
    EngineDecision decision,
    std::wstring failOpenText,
    std::uint64_t contextGeneration,
    EditSessionCallback callback,
    TfGuidAtom compositionDisplayAttribute,
    TfGuidAtom ghostDisplayAttribute
  ) : context_(context),
      state_(state),
      kind_(kind),
      decision_(std::move(decision)),
      failOpenText_(std::move(failOpenText)),
      contextGeneration_(contextGeneration),
      callback_(callback),
      compositionDisplayAttribute_(compositionDisplayAttribute),
      ghostDisplayAttribute_(ghostDisplayAttribute) {
    context_->AddRef();
    state_->AddRef();
    state_->beginOperation();
    if (callback_.lifetimeOwner) callback_.lifetimeOwner->AddRef();
    outcome_.context = context_;
    outcome_.state = state_;
    outcome_.contextGeneration = contextGeneration_;
    outcome_.decision = decision_;
    outcome_.failOpenText = failOpenText_;
    InterlockedIncrement(&g_objectCount);
  }

  STDMETHODIMP QueryInterface(REFIID riid, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (riid != IID_IUnknown && riid != IID_ITfEditSession) return E_NOINTERFACE;
    *object = static_cast<ITfEditSession*>(this);
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

  STDMETHODIMP DoEditSession(TfEditCookie editCookie) override {
    outcome_.editSessionRan = true;
    HRESULT hr = E_UNEXPECTED;

    if (kind_ != EditKind::Finish && state_->pendingEditsCancelled()) {
      outcome_.operationResult = E_ABORT;
      return E_ABORT;
    }

    if (kind_ != EditKind::Finish) {
      ContextPrivacy privacy = ContextPrivacy::Unknown;
      const HRESULT privacyResult = inspectInputScopeAtSelection(context_, editCookie, &privacy);
      if (contextCompartmentIsSet(context_, GUID_COMPARTMENT_KEYBOARD_DISABLED) ||
          contextCompartmentIsSet(context_, GUID_COMPARTMENT_EMPTYCONTEXT) ||
          FAILED(privacyResult) || privacy != ContextPrivacy::Safe) {
        outcome_.privacyBlocked = true;
        outcome_.operationResult = FAILED(privacyResult) ? privacyResult : E_ACCESSDENIED;
        return outcome_.operationResult;
      }
    }

    if (kind_ == EditKind::Finish) {
      hr = !decision_.committedText.empty() && state_->composition()
        ? updateCompositionText(
            editCookie,
            decision_.committedText,
            decision_.committedText.size(),
            TF_INVALID_GUIDATOM,
            true
          )
        : finishTrackedText(editCookie);
      outcome_.desiredApplied = SUCCEEDED(hr);
      outcome_.consumed = SUCCEEDED(hr);
    } else if (kind_ == EditKind::FailOpen || state_->failOpen()) {
      state_->enterFailOpen();
      hr = applyFailOpenText(editCookie);
      if (FAILED(hr) && outcome_.hostTextMutated) outcome_.consumed = true;
    } else {
      hr = applyDesiredDecision(editCookie);
      if (FAILED(hr) && !outcome_.hostTextMutated) {
        state_->enterFailOpen();
        const HRESULT fallbackResult = applyFailOpenText(editCookie);
        if (SUCCEEDED(fallbackResult)) hr = S_OK;
      } else if (outcome_.hostTextMutated) {
        // Once text has changed, never ask the host to process the physical key
        // as well. A cleanup failure is handled by the state-owned follow-up.
        outcome_.consumed = true;
        if (outcome_.desiredApplied) hr = S_OK;
      }
    }

    outcome_.operationResult = hr;
    return hr;
  }

  EditSessionOutcome snapshot() const {
    EditSessionOutcome snapshot = outcome_;
    snapshot.context = context_;
    snapshot.state = state_;
    snapshot.pendingOperations = state_->pendingOperations() > 0
      ? state_->pendingOperations() - 1
      : 0;
    snapshot.compositionActive = state_->active();
    snapshot.failOpen = state_->failOpen();
    return snapshot;
  }

  void cancelPendingAndCompletion() {
    if (pendingRegistered_) {
      state_->endOperation();
      pendingRegistered_ = false;
    }
    completionArmed_ = false;
  }

  void disarmCompletion() { completionArmed_ = false; }

private:
  ~DocumentEditSession() {
    EditSessionOutcome finalOutcome = outcome_;
    if (!finalOutcome.editSessionRan && finalOutcome.operationResult == E_PENDING) {
      finalOutcome.operationResult = E_ABORT;
    }
    if (pendingRegistered_) {
      finalOutcome.pendingOperations = state_->endOperation();
      pendingRegistered_ = false;
    } else {
      finalOutcome.pendingOperations = state_->pendingOperations();
    }
    if (kind_ == EditKind::Finish && !finalOutcome.desiredApplied) {
      // A context can disappear before an asynchronous cleanup edit runs, or a
      // host can reject EndComposition. Drop our composition/range references
      // so neither the sink nor the host composition is kept alive by a cycle.
      state_->abandon();
    }
    finalOutcome.context = context_;
    finalOutcome.state = state_;
    finalOutcome.compositionActive = state_->active();
    finalOutcome.failOpen = state_->failOpen();

    if (completionArmed_ && callback_.function) {
      callback_.function(callback_.context, finalOutcome);
    }
    if (callback_.lifetimeOwner) callback_.lifetimeOwner->Release();
    state_->Release();
    context_->Release();
    InterlockedDecrement(&g_objectCount);
  }

  void rememberFailure(EditFailureStage stage, HRESULT hr) {
    if (outcome_.failureStage == EditFailureStage::None) outcome_.failureStage = stage;
    if (outcome_.operationResult == E_PENDING) outcome_.operationResult = hr;
  }

  HRESULT getCompositionRange(ITfRange** range) {
    if (!range) return E_POINTER;
    *range = nullptr;
    ITfComposition* composition = state_->composition();
    if (!composition) return E_UNEXPECTED;
    const HRESULT hr = composition->GetRange(range);
    if (FAILED(hr) || !*range) {
      rememberFailure(EditFailureStage::GetCompositionRange, FAILED(hr) ? hr : E_FAIL);
      return FAILED(hr) ? hr : E_FAIL;
    }
    return S_OK;
  }

  HRESULT setRangeText(TfEditCookie editCookie, ITfRange* range, const std::wstring& text) {
    LONG length = 0;
    HRESULT hr = checkedTextLength(text, &length);
    if (FAILED(hr)) return hr;
    hr = range->SetText(editCookie, 0, text.empty() ? nullptr : text.data(), length);
    if (FAILED(hr)) {
      rememberFailure(EditFailureStage::SetText, hr);
      return hr;
    }
    outcome_.hostTextMutated = true;
    return S_OK;
  }

  void captureTextExtent(TfEditCookie editCookie, ITfRange* sourceRange) {
    outcome_.hasTextExtent = false;
    if (!sourceRange) return;

    ITfRange* range = nullptr;
    HRESULT hr = sourceRange->Clone(&range);
    if (FAILED(hr) || !range) return;
    hr = range->Collapse(editCookie, TF_ANCHOR_END);

    ITfContextView* view = nullptr;
    if (SUCCEEDED(hr)) hr = context_->GetActiveView(&view);
    BOOL clipped = FALSE;
    RECT extent = {};
    if (SUCCEEDED(hr) && view) {
      if (FAILED(view->GetWnd(&outcome_.candidateOwnerWindow)) || !outcome_.candidateOwnerWindow) {
        outcome_.candidateOwnerWindow = GetFocus();
      }
      hr = view->GetTextExt(editCookie, range, &extent, &clipped);
      if (FAILED(hr)) {
        // Some ACP stores reject a collapsed GetTextExt range. The full
        // composition range is a valid fallback anchor for the candidate UI.
        hr = view->GetTextExt(editCookie, sourceRange, &extent, &clipped);
      }
    } else {
      outcome_.candidateOwnerWindow = GetFocus();
    }
    if (view) view->Release();
    range->Release();
    if (SUCCEEDED(hr)) {
      outcome_.textExtent = extent;
      outcome_.hasTextExtent = true;
    }
  }

  HRESULT startCompositionWithText(
    TfEditCookie editCookie,
    const std::wstring& text,
    std::size_t caretOffset,
    TfGuidAtom displayAttribute,
    std::size_t ghostOffset,
    TfGuidAtom ghostDisplayAttribute
  ) {
    if (text.size() > static_cast<std::size_t>(std::numeric_limits<LONG>::max())) return E_INVALIDARG;
    HRESULT hr = S_OK;

    ITfInsertAtSelection* insert = nullptr;
    hr = context_->QueryInterface(IID_ITfInsertAtSelection, reinterpret_cast<void**>(&insert));
    if (FAILED(hr) || !insert) {
      rememberFailure(EditFailureStage::QueryInsertionRange, FAILED(hr) ? hr : E_NOINTERFACE);
      return FAILED(hr) ? hr : E_NOINTERFACE;
    }

    LONG textLength = 0;
    hr = checkedTextLength(text, &textLength);
    if (FAILED(hr)) {
      insert->Release();
      rememberFailure(EditFailureStage::QueryInsertionRange, hr);
      return hr;
    }

    ITfRange* insertionRange = nullptr;
    // Query the range for the actual insertion, but do not mutate the store.
    // The returned range must still lie inside the current document; the text
    // is written only after StartComposition has accepted ownership.
    hr = insert->InsertTextAtSelection(
      editCookie,
      TF_IAS_QUERYONLY,
      text.empty() ? nullptr : text.data(),
      textLength,
      &insertionRange
    );
    insert->Release();
    if (FAILED(hr) || !insertionRange) {
      rememberFailure(EditFailureStage::QueryInsertionRange, FAILED(hr) ? hr : E_FAIL);
      return FAILED(hr) ? hr : E_FAIL;
    }

    ITfContextComposition* compositionContext = nullptr;
    hr = context_->QueryInterface(IID_ITfContextComposition, reinterpret_cast<void**>(&compositionContext));
    if (FAILED(hr) || !compositionContext) {
      insertionRange->Release();
      rememberFailure(EditFailureStage::StartComposition, FAILED(hr) ? hr : E_NOINTERFACE);
      return FAILED(hr) ? hr : E_NOINTERFACE;
    }

    ITfComposition* composition = nullptr;
    hr = compositionContext->StartComposition(editCookie, insertionRange, state_, &composition);
    compositionContext->Release();
    insertionRange->Release();
    if (FAILED(hr) || !composition) {
      rememberFailure(EditFailureStage::StartComposition, FAILED(hr) ? hr : TF_E_COMPOSITION_REJECTED);
      return FAILED(hr) ? hr : TF_E_COMPOSITION_REJECTED;
    }
    state_->takeComposition(composition);

    ITfRange* compositionRange = nullptr;
    hr = getCompositionRange(&compositionRange);
    if (FAILED(hr)) {
      // StartComposition succeeded, so release host ownership before falling
      // back to plain text. Merely releasing our ITfComposition reference can
      // strand an active host composition.
      endCurrentComposition(editCookie);
      return hr;
    }
    hr = setRangeText(editCookie, compositionRange, text);
    if (FAILED(hr)) {
      endCurrentComposition(editCookie);
      compositionRange->Release();
      return hr;
    }

    if (!text.empty()) {
      setMarkedTextDisplayAttributes(
        context_,
        editCookie,
        compositionRange,
        ghostOffset,
        displayAttribute,
        ghostDisplayAttribute
      );
    }
    const HRESULT selectionResult = setSelectionToOffset(
      context_,
      editCookie,
      compositionRange,
      std::min(caretOffset, text.size())
    );
    if (FAILED(selectionResult)) {
      rememberFailure(EditFailureStage::SetSelection, selectionResult);
      endCurrentComposition(editCookie);
      compositionRange->Release();
      return selectionResult;
    }
    if (!text.empty()) captureTextExtent(editCookie, compositionRange);
    compositionRange->Release();
    return S_OK;
  }

  HRESULT endCurrentComposition(TfEditCookie editCookie) {
    ITfComposition* composition = state_->composition();
    if (!composition) return S_OK;
    composition->AddRef();
    const HRESULT hr = composition->EndComposition(editCookie);
    if (SUCCEEDED(hr) && state_->composition() == composition) state_->clearComposition();
    composition->Release();
    if (FAILED(hr)) rememberFailure(EditFailureStage::EndComposition, hr);
    return hr;
  }

  HRESULT updateCompositionText(
    TfEditCookie editCookie,
    const std::wstring& text,
    std::size_t caretOffset,
    TfGuidAtom displayAttribute,
    bool finishAfterUpdate,
    std::size_t ghostOffset = 0,
    TfGuidAtom ghostDisplayAttribute = TF_INVALID_GUIDATOM
  ) {
    ITfRange* range = nullptr;
    HRESULT hr = getCompositionRange(&range);
    if (FAILED(hr)) {
      endCurrentComposition(editCookie);
      return hr;
    }
    clearCompositionDisplayAttribute(context_, editCookie, range);
    hr = setRangeText(editCookie, range, text);
    if (SUCCEEDED(hr)) {
      if (!text.empty()) {
        setMarkedTextDisplayAttributes(
          context_,
          editCookie,
          range,
          ghostOffset,
          displayAttribute,
          ghostDisplayAttribute
        );
      }
      const HRESULT selectionResult = setSelectionToOffset(
        context_,
        editCookie,
        range,
        std::min(caretOffset, text.size())
      );
      if (FAILED(selectionResult)) {
        rememberFailure(EditFailureStage::SetSelection, selectionResult);
        hr = selectionResult;
      }
      if (!text.empty()) captureTextExtent(editCookie, range);
      if (finishAfterUpdate || text.empty()) {
        const HRESULT endResult = endCurrentComposition(editCookie);
        if (FAILED(endResult) && SUCCEEDED(hr)) hr = endResult;
      }
    }
    range->Release();
    return hr;
  }

  HRESULT insertPlainText(TfEditCookie editCookie, const std::wstring& text, bool retainRange) {
    LONG length = 0;
    HRESULT hr = checkedTextLength(text, &length);
    if (FAILED(hr)) return hr;
    if (text.empty()) {
      rememberFailure(EditFailureStage::InsertText, E_INVALIDARG);
      return E_INVALIDARG;
    }

    ITfInsertAtSelection* insert = nullptr;
    hr = context_->QueryInterface(IID_ITfInsertAtSelection, reinterpret_cast<void**>(&insert));
    if (FAILED(hr) || !insert) {
      rememberFailure(EditFailureStage::InsertText, FAILED(hr) ? hr : E_NOINTERFACE);
      return FAILED(hr) ? hr : E_NOINTERFACE;
    }
    ITfRange* insertedRange = nullptr;
    hr = insert->InsertTextAtSelection(
      editCookie,
      0,
      text.data(),
      length,
      &insertedRange
    );
    insert->Release();
    if (FAILED(hr) || !insertedRange) {
      rememberFailure(EditFailureStage::InsertText, FAILED(hr) ? hr : E_FAIL);
      if (insertedRange) insertedRange->Release();
      return FAILED(hr) ? hr : E_FAIL;
    }
    outcome_.hostTextMutated = true;
    const HRESULT selectionResult = setSelectionToOffset(context_, editCookie, insertedRange, text.size());
    if (FAILED(selectionResult)) {
      rememberFailure(EditFailureStage::SetSelection, selectionResult);
      insertedRange->Release();
      return selectionResult;
    }
    if (retainRange) {
      state_->takeFallbackRange(insertedRange);
    } else {
      insertedRange->Release();
    }
    return S_OK;
  }

  HRESULT applyDesiredDecision(TfEditCookie editCookie) {
    switch (decision_.action) {
      case EngineAction::Compose: {
        HRESULT hr = S_OK;
        const std::wstring markedText = decision_.displayText + decision_.inlineCompletionDisplayText;
        const std::size_t ghostOffset = decision_.displayText.size();
        const std::size_t caretOffset = decision_.inlineCompletionDisplayText.empty()
          ? decision_.caret
          : ghostOffset;
        if (state_->composition()) {
          hr = updateCompositionText(
            editCookie,
            markedText,
            caretOffset,
            compositionDisplayAttribute_,
            markedText.empty(),
            ghostOffset,
            decision_.inlineCompletionDisplayText.empty() ? TF_INVALID_GUIDATOM : ghostDisplayAttribute_
          );
        } else if (!markedText.empty()) {
          hr = startCompositionWithText(
            editCookie,
            markedText,
            caretOffset,
            compositionDisplayAttribute_,
            ghostOffset,
            decision_.inlineCompletionDisplayText.empty() ? TF_INVALID_GUIDATOM : ghostDisplayAttribute_
          );
        }
        if (SUCCEEDED(hr)) {
          outcome_.desiredApplied = true;
          outcome_.consumed = true;
        }
        return hr;
      }
      case EngineAction::Commit: {
        HRESULT hr = S_OK;
        if (state_->composition()) {
          hr = updateCompositionText(
            editCookie,
            decision_.committedText,
            decision_.committedText.size(),
            TF_INVALID_GUIDATOM,
            true
          );
        } else {
          hr = insertPlainText(editCookie, decision_.committedText, false);
        }
        if (SUCCEEDED(hr)) {
          outcome_.desiredApplied = true;
          outcome_.consumed = true;
        }
        return hr;
      }
      case EngineAction::Cancel: {
        HRESULT hr = S_OK;
        if (state_->composition()) {
          hr = updateCompositionText(editCookie, L"", 0, TF_INVALID_GUIDATOM, true);
        } else if (state_->fallbackRange()) {
          hr = state_->fallbackRange()->SetText(editCookie, 0, nullptr, 0);
          if (SUCCEEDED(hr)) {
            outcome_.hostTextMutated = true;
            state_->clearFallbackRange();
          }
        }
        if (SUCCEEDED(hr)) {
          outcome_.desiredApplied = true;
          outcome_.consumed = true;
        }
        return hr;
      }
      case EngineAction::PassThrough:
        return E_INVALIDARG;
    }
    return E_UNEXPECTED;
  }

  HRESULT applyFailOpenText(TfEditCookie editCookie) {
    state_->enterFailOpen();
    const bool finishAfterUpdate = state_->closing() || state_->pendingOperations() <= 1;
    HRESULT hr = S_OK;

    if (state_->composition()) {
      hr = updateCompositionText(
        editCookie,
        failOpenText_,
        failOpenText_.size(),
        TF_INVALID_GUIDATOM,
        finishAfterUpdate
      );
    } else if (state_->fallbackRange()) {
      ITfRange* range = state_->fallbackRange();
      hr = setRangeText(editCookie, range, failOpenText_);
      if (SUCCEEDED(hr)) {
        const HRESULT selectionResult = setSelectionToOffset(
          context_,
          editCookie,
          range,
          failOpenText_.size()
        );
        if (FAILED(selectionResult)) {
          rememberFailure(EditFailureStage::SetSelection, selectionResult);
          hr = selectionResult;
        }
        if (finishAfterUpdate) state_->clearFallbackRange();
      }
    } else if (failOpenText_.empty()) {
      hr = S_OK;
    } else {
      const bool compositionCreationAlreadyFailed =
        outcome_.failureStage == EditFailureStage::QueryInsertionRange ||
        outcome_.failureStage == EditFailureStage::StartComposition ||
        outcome_.failureStage == EditFailureStage::GetCompositionRange ||
        outcome_.failureStage == EditFailureStage::SetText;
      if (compositionCreationAlreadyFailed) {
        // Do not repeat a composition operation that the host just rejected.
        // Insert the literal Roman snapshot once and let later queued fallbacks
        // replace the returned range.
        hr = insertPlainText(editCookie, failOpenText_, !finishAfterUpdate);
      } else {
        // Prefer a temporary composition so multiple already-queued keys can
        // replace one tracked range rather than append duplicate snapshots.
        hr = startCompositionWithText(
          editCookie,
          failOpenText_,
          failOpenText_.size(),
          TF_INVALID_GUIDATOM,
          failOpenText_.size(),
          TF_INVALID_GUIDATOM
        );
        if (SUCCEEDED(hr) && finishAfterUpdate) {
          const HRESULT endResult = endCurrentComposition(editCookie);
          if (FAILED(endResult)) hr = endResult;
        } else if (FAILED(hr)) {
          // Some hosts refuse compositions but still support ordinary TSF text
          // insertion. Track the returned range while queued fallback edits drain.
          hr = insertPlainText(editCookie, failOpenText_, !finishAfterUpdate);
        }
      }
    }

    if (SUCCEEDED(hr)) {
      outcome_.fallbackApplied = true;
      outcome_.consumed = true;
    }
    return hr;
  }

  HRESULT finishTrackedText(TfEditCookie editCookie) {
    if (state_->composition()) {
      ITfRange* range = nullptr;
      if (SUCCEEDED(getCompositionRange(&range)) && range) {
        clearCompositionDisplayAttribute(context_, editCookie, range);
        range->Release();
      }
      return endCurrentComposition(editCookie);
    }
    state_->clearFallbackRange();
    return S_OK;
  }

  LONG refCount_ = 1;
  ITfContext* context_;
  CompositionState* state_;
  EditKind kind_;
  EngineDecision decision_;
  std::wstring failOpenText_;
  std::uint64_t contextGeneration_ = 0;
  EditSessionCallback callback_;
  TfGuidAtom compositionDisplayAttribute_ = TF_INVALID_GUIDATOM;
  TfGuidAtom ghostDisplayAttribute_ = TF_INVALID_GUIDATOM;
  EditSessionOutcome outcome_;
  bool pendingRegistered_ = true;
  bool completionArmed_ = true;
};

EditSubmissionResult submitEditSession(
  ITfContext* context,
  TfClientId clientId,
  CompositionState* state,
  EditKind kind,
  const EngineDecision& decision,
  const std::wstring& failOpenText,
  std::uint64_t contextGeneration,
  const EditSessionCallback& callback,
  TfGuidAtom compositionDisplayAttribute,
  TfGuidAtom ghostDisplayAttribute
) {
  EditSubmissionResult result;
  if (!context || clientId == TF_CLIENTID_NULL || !state) return result;

  auto* editSession = new (std::nothrow) DocumentEditSession(
    context,
    state,
    kind,
    decision,
    failOpenText,
    contextGeneration,
    callback,
    compositionDisplayAttribute,
    ghostDisplayAttribute
  );
  if (!editSession) {
    result.requestResult = E_OUTOFMEMORY;
    result.sessionResult = E_OUTOFMEMORY;
    return result;
  }

  HRESULT sessionResult = E_FAIL;
  const HRESULT requestResult = context->RequestEditSession(
    clientId,
    editSession,
    TF_ES_ASYNCDONTCARE | TF_ES_READWRITE,
    &sessionResult
  );
  result.requestResult = requestResult;
  result.sessionResult = sessionResult;

  if (FAILED(requestResult)) {
    editSession->cancelPendingAndCompletion();
    editSession->Release();
    return result;
  }

  if (sessionResult == TF_S_ASYNC) {
    result.status = EditSubmissionStatus::Queued;
    editSession->Release();
    return result;
  }

  result.outcome = editSession->snapshot();
  editSession->disarmCompletion();
  result.status = result.outcome.consumed
    ? EditSubmissionStatus::Completed
    : EditSubmissionStatus::Rejected;
  editSession->Release();
  return result;
}

} // namespace

ContextPrivacy classifyInputScopes(const InputScope* scopes, UINT scopeCount) {
  if (scopeCount == 0) return ContextPrivacy::Safe;
  if (!scopes) return ContextPrivacy::Unknown;

  ContextPrivacy classification = ContextPrivacy::Safe;
  for (UINT index = 0; index < scopeCount; ++index) {
    if (isSensitiveInputScope(scopes[index])) return ContextPrivacy::Sensitive;
    if (!isKnownInputScope(scopes[index])) classification = ContextPrivacy::Unknown;
  }
  return classification;
}

ContextPrivacy inspectContextPrivacy(ITfContext* context, TfClientId clientId) {
  if (!context || clientId == TF_CLIENTID_NULL) return ContextPrivacy::Unknown;
  const bool keyboardDisabled = contextCompartmentIsSet(context, GUID_COMPARTMENT_KEYBOARD_DISABLED);
  const bool emptyContext = contextCompartmentIsSet(context, GUID_COMPARTMENT_EMPTYCONTEXT);
  if (keyboardDisabled || emptyContext) return ContextPrivacy::Sensitive;

  auto* editSession = new (std::nothrow) ScopeEditSession(context);
  if (!editSession) return ContextPrivacy::Unknown;
  HRESULT sessionResult = E_FAIL;
  const HRESULT requestResult = context->RequestEditSession(
    clientId,
    editSession,
    TF_ES_SYNC | TF_ES_READ,
    &sessionResult
  );
  const ContextPrivacy result = SUCCEEDED(requestResult) && SUCCEEDED(sessionResult) && editSession->inspected()
    ? editSession->classification()
    : ContextPrivacy::Unknown;
  editSession->Release();
  return result;
}

PrivacyInspectionSubmission submitContextPrivacyInspection(
  ITfContext* context,
  TfClientId clientId,
  std::uint64_t contextGeneration,
  const PrivacyInspectionCallback& callback
) {
  PrivacyInspectionSubmission result;
  if (!context || clientId == TF_CLIENTID_NULL) return result;

  if (contextCompartmentIsSet(context, GUID_COMPARTMENT_KEYBOARD_DISABLED) ||
      contextCompartmentIsSet(context, GUID_COMPARTMENT_EMPTYCONTEXT)) {
    result.status = EditSubmissionStatus::Completed;
    result.requestResult = S_OK;
    result.sessionResult = S_OK;
    result.outcome.context = context;
    result.outcome.contextGeneration = contextGeneration;
    result.outcome.privacy = ContextPrivacy::Sensitive;
    result.outcome.operationResult = S_OK;
    result.outcome.editSessionRan = true;
    return result;
  }

  auto* editSession = new (std::nothrow) ScopeEditSession(context, contextGeneration, callback);
  if (!editSession) {
    result.requestResult = E_OUTOFMEMORY;
    result.sessionResult = E_OUTOFMEMORY;
    return result;
  }

  HRESULT sessionResult = E_FAIL;
  const HRESULT requestResult = context->RequestEditSession(
    clientId,
    editSession,
    TF_ES_ASYNCDONTCARE | TF_ES_READ,
    &sessionResult
  );
  result.requestResult = requestResult;
  result.sessionResult = sessionResult;
  if (FAILED(requestResult)) {
    editSession->cancelCompletion();
    editSession->Release();
    return result;
  }
  if (sessionResult == TF_S_ASYNC) {
    result.status = EditSubmissionStatus::Queued;
    editSession->Release();
    return result;
  }

  result.outcome = editSession->snapshot();
  editSession->disarmCompletion();
  result.status = result.outcome.editSessionRan
    ? EditSubmissionStatus::Completed
    : EditSubmissionStatus::Rejected;
  editSession->Release();
  return result;
}

CompositionState* createCompositionState() {
  return new (std::nothrow) CompositionState();
}

void addRefCompositionState(CompositionState* state) {
  if (state) state->AddRef();
}

void releaseCompositionState(CompositionState** state) {
  if (!state || !*state) return;
  (*state)->Release();
  *state = nullptr;
}

bool compositionStateIsActive(const CompositionState* state) {
  return state && state->active();
}

bool compositionStateIsFailOpen(const CompositionState* state) {
  return state && state->failOpen();
}

bool compositionStateHasPendingOperations(const CompositionState* state) {
  return state && state->pendingOperations() > 0;
}

void markCompositionStateClosing(CompositionState* state) {
  if (state) state->markClosing();
}

void cancelCompositionStatePendingEdits(CompositionState* state) {
  if (state) state->cancelPendingEdits();
}

void abandonCompositionState(CompositionState* state) {
  if (state) state->abandon();
}

EditSubmissionResult submitEngineDecision(
  ITfContext* context,
  TfClientId clientId,
  CompositionState* state,
  const EngineDecision& decision,
  const std::wstring& failOpenText,
  std::uint64_t contextGeneration,
  const EditSessionCallback& callback,
  TfGuidAtom compositionDisplayAttribute,
  TfGuidAtom ghostDisplayAttribute
) {
  if (decision.action == EngineAction::PassThrough) return {};
  return submitEditSession(
    context,
    clientId,
    state,
    EditKind::Decision,
    decision,
    failOpenText,
    contextGeneration,
    callback,
    compositionDisplayAttribute,
    ghostDisplayAttribute
  );
}

EditSubmissionResult submitFailOpenText(
  ITfContext* context,
  TfClientId clientId,
  CompositionState* state,
  const std::wstring& failOpenText,
  std::uint64_t contextGeneration,
  const EditSessionCallback& callback
) {
  EngineDecision decision;
  decision.action = EngineAction::PassThrough;
  return submitEditSession(
    context,
    clientId,
    state,
    EditKind::FailOpen,
    decision,
    failOpenText,
    contextGeneration,
    callback,
    TF_INVALID_GUIDATOM,
    TF_INVALID_GUIDATOM
  );
}

EditSubmissionResult submitFinishComposition(
  ITfContext* context,
  TfClientId clientId,
  CompositionState* state,
  std::uint64_t contextGeneration,
  const std::wstring& finalText,
  const EditSessionCallback& callback
) {
  if (!context || clientId == TF_CLIENTID_NULL || !state) return {};
  state->markClosing();
  EngineDecision decision;
  decision.action = EngineAction::Cancel;
  decision.committedText = finalText;
  return submitEditSession(
    context,
    clientId,
    state,
    EditKind::Finish,
    decision,
    L"",
    contextGeneration,
    callback,
    TF_INVALID_GUIDATOM,
    TF_INVALID_GUIDATOM
  );
}

} // namespace lekh::tsf
