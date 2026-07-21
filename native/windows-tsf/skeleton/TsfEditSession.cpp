#include "TsfEditSession.h"

#include <inputscope.h>
#include <oleauto.h>
#include <windows.h>

#include <limits>

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
    const EngineDecision& decision
  ) : context_(context), activeComposition_(activeComposition), decision_(decision) {
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
    switch (decision_.action) {
      case EngineAction::Compose:
        return compose(editCookie);
      case EngineAction::Commit:
        return commit(editCookie);
      case EngineAction::Cancel:
        return cancel(editCookie);
      case EngineAction::PassThrough:
        return E_INVALIDARG;
    }
    return E_UNEXPECTED;
  }

  bool hostTextMutated() const { return hostTextMutated_; }

private:
  ~DocumentEditSession() {
    context_->Release();
  }

  HRESULT compose(TfEditCookie editCookie) {
    if (decision_.displayText.size() > static_cast<std::size_t>(std::numeric_limits<LONG>::max())) return E_INVALIDARG;
    if (*activeComposition_) return updateComposition(editCookie);
    if (decision_.displayText.empty()) return S_FALSE;

    ITfInsertAtSelection* insert = nullptr;
    HRESULT hr = context_->QueryInterface(IID_ITfInsertAtSelection, reinterpret_cast<void**>(&insert));
    if (FAILED(hr) || !insert) return FAILED(hr) ? hr : E_NOINTERFACE;

    ITfRange* insertedRange = nullptr;
    hr = insert->InsertTextAtSelection(
      editCookie,
      TF_IAS_NO_DEFAULT_COMPOSITION,
      decision_.displayText.c_str(),
      static_cast<LONG>(decision_.displayText.size()),
      &insertedRange
    );
    insert->Release();
    if (FAILED(hr) || !insertedRange) return FAILED(hr) ? hr : E_FAIL;
    hostTextMutated_ = true;

    ITfContextComposition* compositionContext = nullptr;
    hr = context_->QueryInterface(IID_ITfContextComposition, reinterpret_cast<void**>(&compositionContext));
    ITfComposition* composition = nullptr;
    if (SUCCEEDED(hr) && compositionContext) {
      hr = compositionContext->StartComposition(editCookie, insertedRange, nullptr, &composition);
      compositionContext->Release();
    }

    if (FAILED(hr) || !composition) {
      const HRESULT rollback = insertedRange->SetText(editCookie, 0, L"", 0);
      insertedRange->Release();
      if (SUCCEEDED(rollback)) hostTextMutated_ = false;
      return FAILED(hr) ? hr : TF_E_COMPOSITION_REJECTED;
    }

    *activeComposition_ = composition;
    setSelectionToEnd(context_, editCookie, insertedRange);
    insertedRange->Release();
    return S_OK;
  }

  HRESULT updateComposition(TfEditCookie editCookie) {
    ITfRange* range = nullptr;
    HRESULT hr = (*activeComposition_)->GetRange(&range);
    if (FAILED(hr) || !range) return FAILED(hr) ? hr : E_FAIL;
    hr = range->SetText(
      editCookie,
      0,
      decision_.displayText.c_str(),
      static_cast<LONG>(decision_.displayText.size())
    );
    if (SUCCEEDED(hr)) {
      hostTextMutated_ = true;
      setSelectionToEnd(context_, editCookie, range);
      if (decision_.displayText.empty() && SUCCEEDED((*activeComposition_)->EndComposition(editCookie))) {
        releaseActiveComposition(activeComposition_);
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
        hostTextMutated_ = true;
        setSelectionToEnd(context_, editCookie, range);
        if (SUCCEEDED((*activeComposition_)->EndComposition(editCookie))) {
          releaseActiveComposition(activeComposition_);
        }
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
    hostTextMutated_ = SUCCEEDED(hr);
    return hr;
  }

  HRESULT cancel(TfEditCookie editCookie) {
    if (!*activeComposition_) return S_FALSE;
    ITfRange* range = nullptr;
    HRESULT hr = (*activeComposition_)->GetRange(&range);
    if (FAILED(hr) || !range) return FAILED(hr) ? hr : E_FAIL;
    hr = range->SetText(editCookie, 0, L"", 0);
    range->Release();
    if (SUCCEEDED(hr)) {
      hostTextMutated_ = true;
      if (SUCCEEDED((*activeComposition_)->EndComposition(editCookie))) {
        releaseActiveComposition(activeComposition_);
      }
    }
    return hr;
  }

  long refCount_ = 1;
  ITfContext* context_;
  ITfComposition** activeComposition_;
  EngineDecision decision_;
  bool hostTextMutated_ = false;
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
  auto* editSession = new ScopeEditSession(context);
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

bool applyEngineDecision(
  ITfContext* context,
  TfClientId clientId,
  ITfComposition** activeComposition,
  const EngineDecision& decision
) {
  if (!context || clientId == TF_CLIENTID_NULL || !activeComposition || decision.action == EngineAction::PassThrough) return false;
  auto* editSession = new DocumentEditSession(context, activeComposition, decision);
  HRESULT sessionResult = E_FAIL;
  const HRESULT requestResult = context->RequestEditSession(
    clientId,
    editSession,
    TF_ES_SYNC | TF_ES_READWRITE,
    &sessionResult
  );
  // A host mutation is the decisive no-key-loss signal. DoEditSession can
  // report a later composition-ownership failure after inserting text; if
  // rollback also fails, passing the original key through would duplicate it.
  const bool applied = SUCCEEDED(requestResult) && editSession->hostTextMutated();
  editSession->Release();
  return applied;
}

bool finishActiveComposition(
  ITfContext* context,
  TfClientId clientId,
  ITfComposition** activeComposition
) {
  if (!activeComposition || !*activeComposition) return true;
  if (!context || clientId == TF_CLIENTID_NULL) return false;
  auto* editSession = new FinishEditSession(activeComposition);
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
