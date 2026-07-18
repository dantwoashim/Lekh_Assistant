#include "TsfEditSession.h"

#include <inputscope.h>
#include <oleauto.h>
#include <windows.h>

#include <limits>
#include <new>

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

class ScopeEditSession final : public ITfEditSession {
public:
  explicit ScopeEditSession(ITfContext* context) : context_(context) {
    context_->AddRef();
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
    TF_SELECTION selection = {};
    ULONG selectionCount = 0;
    HRESULT hr = context_->GetSelection(editCookie, TF_DEFAULT_SELECTION, 1, &selection, &selectionCount);
    if (FAILED(hr) || selectionCount != 1 || !selection.range) return FAILED(hr) ? hr : E_FAIL;

    ITfReadOnlyProperty* property = nullptr;
    hr = context_->GetAppProperty(GUID_PROP_INPUTSCOPE, &property);
    if (FAILED(hr) || !property) {
      selection.range->Release();
      return FAILED(hr) ? hr : E_FAIL;
    }

    VARIANT value;
    VariantInit(&value);
    hr = property->GetValue(editCookie, selection.range, &value);
    property->Release();
    selection.range->Release();
    if (FAILED(hr)) {
      VariantClear(&value);
      return hr;
    }

    ITfInputScope* inputScope = nullptr;
    if (value.vt == VT_UNKNOWN && value.punkVal) {
      hr = value.punkVal->QueryInterface(IID_ITfInputScope, reinterpret_cast<void**>(&inputScope));
    } else {
      hr = E_NOINTERFACE;
    }
    VariantClear(&value);
    if (FAILED(hr) || !inputScope) return FAILED(hr) ? hr : E_NOINTERFACE;

    InputScope* scopes = nullptr;
    UINT scopeCount = 0;
    hr = inputScope->GetInputScopes(&scopes, &scopeCount);
    inputScope->Release();
    if (FAILED(hr) || !scopes || scopeCount == 0) {
      if (scopes) CoTaskMemFree(scopes);
      return FAILED(hr) ? hr : E_FAIL;
    }

    classification_ = ContextPrivacy::Safe;
    for (UINT index = 0; index < scopeCount; ++index) {
      if (isSensitiveInputScope(scopes[index])) {
        classification_ = ContextPrivacy::Sensitive;
        break;
      }
      if (!isKnownInputScope(scopes[index])) classification_ = ContextPrivacy::Unknown;
    }
    CoTaskMemFree(scopes);
    inspected_ = true;
    return S_OK;
  }

  bool inspected() const { return inspected_; }
  ContextPrivacy classification() const { return classification_; }

private:
  ~ScopeEditSession() {
    context_->Release();
  }

  long refCount_ = 1;
  ITfContext* context_;
  bool inspected_ = false;
  ContextPrivacy classification_ = ContextPrivacy::Unknown;
};

HRESULT setSelectionToEnd(ITfContext* context, TfEditCookie editCookie, ITfRange* range) {
  ITfRange* caretRange = nullptr;
  HRESULT hr = range->Clone(&caretRange);
  if (FAILED(hr) || !caretRange) return FAILED(hr) ? hr : E_FAIL;
  hr = caretRange->Collapse(editCookie, TF_ANCHOR_END);
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

class DocumentEditSession final : public ITfEditSession {
public:
  DocumentEditSession(
    ITfContext* context,
    ITfComposition** activeComposition,
    ITfCompositionSink* compositionSink,
    const EngineDecision& decision
  ) : context_(context),
      activeComposition_(activeComposition),
      compositionSink_(compositionSink),
      decision_(decision) {
    context_->AddRef();
    compositionSink_->AddRef();
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
    HRESULT hr = E_UNEXPECTED;
    switch (decision_.action) {
      case EngineAction::Compose:
        hr = compose(editCookie);
        break;
      case EngineAction::Commit:
        hr = commit(editCookie);
        break;
      case EngineAction::Cancel:
        hr = cancel(editCookie);
        break;
      case EngineAction::PassThrough:
        hr = E_INVALIDARG;
        break;
    }
    completed_ = SUCCEEDED(hr);
    return hr;
  }

  bool keyEffectApplied() const { return keyEffectApplied_; }
  bool completed() const { return completed_; }

private:
  ~DocumentEditSession() {
    compositionSink_->Release();
    context_->Release();
  }

  HRESULT compose(TfEditCookie editCookie) {
    if (decision_.compositionText.size() > static_cast<std::size_t>(std::numeric_limits<LONG>::max())) return E_INVALIDARG;
    if (*activeComposition_) return updateComposition(editCookie);
    if (decision_.compositionText.empty()) return S_FALSE;

    ITfInsertAtSelection* insert = nullptr;
    HRESULT hr = context_->QueryInterface(IID_ITfInsertAtSelection, reinterpret_cast<void**>(&insert));
    if (FAILED(hr) || !insert) return FAILED(hr) ? hr : E_NOINTERFACE;

    ITfRange* insertedRange = nullptr;
    hr = insert->InsertTextAtSelection(
      editCookie,
      TF_IAS_NO_DEFAULT_COMPOSITION,
      decision_.compositionText.c_str(),
      static_cast<LONG>(decision_.compositionText.size()),
      &insertedRange
    );
    insert->Release();
    if (FAILED(hr) || !insertedRange) return FAILED(hr) ? hr : E_FAIL;
    keyEffectApplied_ = true;

    ITfContextComposition* compositionContext = nullptr;
    hr = context_->QueryInterface(IID_ITfContextComposition, reinterpret_cast<void**>(&compositionContext));
    ITfComposition* composition = nullptr;
    if (SUCCEEDED(hr) && compositionContext) {
      hr = compositionContext->StartComposition(editCookie, insertedRange, compositionSink_, &composition);
      compositionContext->Release();
    }

    if (FAILED(hr) || !composition) {
      setSelectionToEnd(context_, editCookie, insertedRange);
      insertedRange->Release();
      // InsertTextAtSelection already represented this physical key. A host
      // that rejects composition ownership must not make us delete that text
      // and replay the key through a second path.
      return FAILED(hr) ? hr : TF_E_COMPOSITION_REJECTED;
    }

    *activeComposition_ = composition;
    hr = setSelectionToEnd(context_, editCookie, insertedRange);
    insertedRange->Release();
    return hr;
  }

  HRESULT updateComposition(TfEditCookie editCookie) {
    ITfRange* range = nullptr;
    HRESULT hr = (*activeComposition_)->GetRange(&range);
    if (FAILED(hr) || !range) return FAILED(hr) ? hr : E_FAIL;
    hr = range->SetText(
      editCookie,
      0,
      decision_.compositionText.c_str(),
      static_cast<LONG>(decision_.compositionText.size())
    );
    if (SUCCEEDED(hr)) {
      keyEffectApplied_ = true;
      hr = setSelectionToEnd(context_, editCookie, range);
      if (SUCCEEDED(hr) && decision_.compositionText.empty()) {
        hr = (*activeComposition_)->EndComposition(editCookie);
        if (SUCCEEDED(hr)) releaseActiveComposition(activeComposition_);
      }
    }
    range->Release();
    return hr;
  }

  HRESULT commit(TfEditCookie editCookie) {
    if (decision_.committedText.size() > static_cast<std::size_t>(std::numeric_limits<LONG>::max())) return E_INVALIDARG;
    if (*activeComposition_) {
      ITfRange* range = nullptr;
      HRESULT hr = (*activeComposition_)->GetRange(&range);
      if (FAILED(hr) || !range) return FAILED(hr) ? hr : E_FAIL;
      hr = range->SetText(
        editCookie,
        0,
        decision_.committedText.c_str(),
        static_cast<LONG>(decision_.committedText.size())
      );
      if (SUCCEEDED(hr)) {
        keyEffectApplied_ = true;
        const HRESULT selectionResult = setSelectionToEnd(context_, editCookie, range);
        const HRESULT endResult = (*activeComposition_)->EndComposition(editCookie);
        if (SUCCEEDED(endResult)) {
          releaseActiveComposition(activeComposition_);
        }
        hr = FAILED(selectionResult) ? selectionResult : endResult;
      }
      range->Release();
      return hr;
    }

    if (decision_.committedText.empty()) return S_FALSE;
    ITfInsertAtSelection* insert = nullptr;
    HRESULT hr = context_->QueryInterface(IID_ITfInsertAtSelection, reinterpret_cast<void**>(&insert));
    if (FAILED(hr) || !insert) return FAILED(hr) ? hr : E_NOINTERFACE;
    hr = insert->InsertTextAtSelection(
      editCookie,
      TF_IAS_NOQUERY,
      decision_.committedText.c_str(),
      static_cast<LONG>(decision_.committedText.size()),
      nullptr
    );
    insert->Release();
    keyEffectApplied_ = SUCCEEDED(hr);
    return hr;
  }

  HRESULT cancel(TfEditCookie editCookie) {
    if (!*activeComposition_) return S_FALSE;
    // Escape dismisses Lekh ownership while preserving the canonical raw
    // range exactly once. A denied EndComposition is not an applied Escape:
    // the caller must relinquish local ownership and return the physical key
    // to the host instead of silently swallowing it.
    const HRESULT hr = (*activeComposition_)->EndComposition(editCookie);
    if (SUCCEEDED(hr)) {
      keyEffectApplied_ = true;
      releaseActiveComposition(activeComposition_);
    }
    return hr;
  }

  long refCount_ = 1;
  ITfContext* context_;
  ITfComposition** activeComposition_;
  ITfCompositionSink* compositionSink_;
  EngineDecision decision_;
  bool keyEffectApplied_ = false;
  bool completed_ = false;
};

class FinishEditSession final : public ITfEditSession {
public:
  explicit FinishEditSession(ITfComposition** activeComposition)
    : activeComposition_(activeComposition) {}

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
    if (!*activeComposition_) return S_FALSE;
    const HRESULT hr = (*activeComposition_)->EndComposition(editCookie);
    if (SUCCEEDED(hr)) {
      finished_ = true;
      releaseActiveComposition(activeComposition_);
    }
    return hr;
  }

  bool finished() const { return finished_; }

private:
  ~FinishEditSession() = default;

  long refCount_ = 1;
  ITfComposition** activeComposition_;
  bool finished_ = false;
};

} // namespace

ContextPrivacy inspectContextPrivacy(ITfContext* context, TfClientId clientId) {
  if (!context || clientId == TF_CLIENTID_NULL) return ContextPrivacy::Unknown;
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

EngineDecisionApplication applyEngineDecision(
  ITfContext* context,
  TfClientId clientId,
  ITfComposition** activeComposition,
  ITfCompositionSink* compositionSink,
  const EngineDecision& decision
) {
  if (!context || clientId == TF_CLIENTID_NULL || !activeComposition || !compositionSink ||
      decision.action == EngineAction::PassThrough) {
    return EngineDecisionApplication::NotApplied;
  }
  auto* editSession = new (std::nothrow) DocumentEditSession(
    context,
    activeComposition,
    compositionSink,
    decision
  );
  if (!editSession) return EngineDecisionApplication::NotApplied;
  HRESULT sessionResult = E_FAIL;
  const HRESULT requestResult = context->RequestEditSession(
    clientId,
    editSession,
    TF_ES_SYNC | TF_ES_READWRITE,
    &sessionResult
  );
  // A host-applied key effect is the decisive no-key-loss signal. It can be a
  // text mutation or Escape ending/relinquishing composition ownership.
  const bool applied = SUCCEEDED(requestResult) && editSession->keyEffectApplied();
  const bool completed = applied && SUCCEEDED(sessionResult) && editSession->completed();
  editSession->Release();
  if (!applied) return EngineDecisionApplication::NotApplied;
  return completed
    ? EngineDecisionApplication::Applied
    : EngineDecisionApplication::AppliedWithOwnershipCleanupRequired;
}

bool finishActiveComposition(
  ITfContext* context,
  TfClientId clientId,
  ITfComposition** activeComposition
) {
  if (!activeComposition || !*activeComposition) return true;
  if (!context || clientId == TF_CLIENTID_NULL) return false;
  auto* editSession = new (std::nothrow) FinishEditSession(activeComposition);
  if (!editSession) return false;
  HRESULT sessionResult = E_FAIL;
  const HRESULT requestResult = context->RequestEditSession(
    clientId,
    editSession,
    TF_ES_SYNC | TF_ES_READWRITE,
    &sessionResult
  );
  const bool finished = SUCCEEDED(requestResult) && SUCCEEDED(sessionResult) && editSession->finished();
  editSession->Release();
  return finished;
}

void releaseActiveComposition(ITfComposition** activeComposition) {
  if (!activeComposition || !*activeComposition) return;
  (*activeComposition)->Release();
  *activeComposition = nullptr;
}

} // namespace lekh::tsf
