#include "TsfEditSession.h"
#include "Guids.h"

#include <msctf.h>
#include <textstor.h>
#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <string>
#include <utility>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

class TestTextStore final : public ITextStoreACP, public ITfContextOwnerCompositionSink {
public:
  explicit TestTextStore(std::wstring initialText)
    : text_(std::move(initialText)), selectionStart_(checkedLength()), selectionEnd_(checkedLength()) {}

  STDMETHODIMP QueryInterface(REFIID riid, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (riid == IID_IUnknown || riid == IID_ITextStoreACP) {
      *object = static_cast<ITextStoreACP*>(this);
    } else if (riid == IID_ITfContextOwnerCompositionSink) {
      *object = static_cast<ITfContextOwnerCompositionSink*>(this);
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

  STDMETHODIMP AdviseSink(REFIID riid, IUnknown* unknown, DWORD) override {
    if (riid != IID_ITextStoreACPSink || !unknown) return E_INVALIDARG;
    ITextStoreACPSink* sink = nullptr;
    const HRESULT hr = unknown->QueryInterface(IID_ITextStoreACPSink, reinterpret_cast<void**>(&sink));
    if (FAILED(hr) || !sink) return FAILED(hr) ? hr : E_NOINTERFACE;
    if (sink_) {
      sink->Release();
      return E_UNEXPECTED;
    }
    sink_ = sink;
    return S_OK;
  }

  STDMETHODIMP UnadviseSink(IUnknown* unknown) override {
    if (!unknown || !sink_) return E_INVALIDARG;
    ITextStoreACPSink* sink = nullptr;
    const HRESULT hr = unknown->QueryInterface(IID_ITextStoreACPSink, reinterpret_cast<void**>(&sink));
    if (FAILED(hr) || !sink) return FAILED(hr) ? hr : E_NOINTERFACE;
    const bool matches = sink == sink_;
    sink->Release();
    if (!matches) return E_INVALIDARG;
    sink_->Release();
    sink_ = nullptr;
    return S_OK;
  }

  STDMETHODIMP RequestLock(DWORD lockFlags, HRESULT* sessionResult) override {
    if (!sessionResult) return E_POINTER;
    if (!sink_) {
      *sessionResult = E_UNEXPECTED;
      return E_UNEXPECTED;
    }
    *sessionResult = sink_->OnLockGranted(lockFlags);
    return S_OK;
  }

  STDMETHODIMP GetStatus(TS_STATUS* status) override {
    if (!status) return E_POINTER;
    status->dwDynamicFlags = 0;
    status->dwStaticFlags = TS_SS_NOHIDDENTEXT;
    return S_OK;
  }

  STDMETHODIMP QueryInsert(
    LONG testStart,
    LONG testEnd,
    ULONG,
    LONG* resultStart,
    LONG* resultEnd
  ) override {
    if (!resultStart || !resultEnd || !validRange(testStart, testEnd)) {
      return E_INVALIDARG;
    }
    *resultStart = testStart;
    *resultEnd = testEnd;
    return S_OK;
  }

  STDMETHODIMP GetSelection(
    ULONG index,
    ULONG count,
    TS_SELECTION_ACP* selection,
    ULONG* fetched
  ) override {
    if (!selection || !fetched || count == 0) return E_INVALIDARG;
    *fetched = 0;
    if (index != TS_DEFAULT_SELECTION && index != 0) return TS_E_NOSELECTION;
    selection[0].acpStart = selectionStart_;
    selection[0].acpEnd = selectionEnd_;
    selection[0].style.ase = TS_AE_END;
    selection[0].style.fInterimChar = FALSE;
    *fetched = 1;
    return S_OK;
  }

  STDMETHODIMP SetSelection(ULONG count, const TS_SELECTION_ACP* selection) override {
    if (!selection || count != 1 || !validRange(selection[0].acpStart, selection[0].acpEnd)) {
      return E_INVALIDARG;
    }
    selectionStart_ = selection[0].acpStart;
    selectionEnd_ = selection[0].acpEnd;
    return S_OK;
  }

  STDMETHODIMP GetText(
    LONG start,
    LONG end,
    WCHAR* plainText,
    ULONG plainCapacity,
    ULONG* plainLength,
    TS_RUNINFO* runInfo,
    ULONG runCapacity,
    ULONG* runCount,
    LONG* nextPosition
  ) override {
    if (!plainLength || !runCount || !nextPosition) return E_POINTER;
    const LONG resolvedEnd = end == -1 ? checkedLength() : end;
    if (!validRange(start, resolvedEnd)) return TS_E_INVALIDPOS;
    const ULONG available = static_cast<ULONG>(resolvedEnd - start);
    const ULONG copied = std::min(available, plainCapacity);
    if (copied > 0 && !plainText) return E_POINTER;
    if (copied > 0) {
      text_.copy(plainText, copied, static_cast<std::size_t>(start));
    }
    *plainLength = copied;
    *runCount = 0;
    if (runCapacity > 0) {
      if (!runInfo) return E_POINTER;
      runInfo[0].uCount = copied;
      runInfo[0].type = TS_RT_PLAIN;
      *runCount = 1;
    }
    *nextPosition = start + static_cast<LONG>(copied);
    return S_OK;
  }

  STDMETHODIMP SetText(
    DWORD,
    LONG start,
    LONG end,
    const WCHAR* text,
    ULONG length,
    TS_TEXTCHANGE* change
  ) override {
    return replaceText(start, end, text, length, change);
  }

  STDMETHODIMP GetFormattedText(LONG, LONG, IDataObject**) override { return E_NOTIMPL; }
  STDMETHODIMP GetEmbedded(LONG, REFGUID, REFIID, IUnknown**) override { return E_NOTIMPL; }

  STDMETHODIMP QueryInsertEmbedded(const GUID*, const FORMATETC*, BOOL* insertable) override {
    if (!insertable) return E_POINTER;
    *insertable = FALSE;
    return S_OK;
  }

  STDMETHODIMP InsertEmbedded(DWORD, LONG, LONG, IDataObject*, TS_TEXTCHANGE*) override {
    return E_NOTIMPL;
  }

  STDMETHODIMP InsertTextAtSelection(
    DWORD flags,
    const WCHAR* text,
    ULONG length,
    LONG* start,
    LONG* end,
    TS_TEXTCHANGE* change
  ) override {
    ++insertionCalls_;
    lastInsertionFlags_ = flags;
    const LONG insertionStart = selectionStart_;
    const LONG insertionEnd = selectionEnd_;
    if ((flags & TS_IAS_QUERYONLY) != 0) {
      if (start) *start = insertionStart;
      if (end) *end = insertionStart + static_cast<LONG>(length);
      if (change) {
        change->acpStart = insertionStart;
        change->acpOldEnd = insertionEnd;
        change->acpNewEnd = insertionStart + static_cast<LONG>(length);
      }
      return S_OK;
    }
    const HRESULT hr = replaceText(insertionStart, insertionEnd, text, length, change);
    if (SUCCEEDED(hr) && (flags & TS_IAS_NOQUERY) == 0) {
      if (start) *start = insertionStart;
      if (end) *end = insertionStart + static_cast<LONG>(length);
    }
    return hr;
  }

  STDMETHODIMP InsertEmbeddedAtSelection(DWORD, IDataObject*, LONG*, LONG*, TS_TEXTCHANGE*) override {
    return E_NOTIMPL;
  }

  STDMETHODIMP RequestSupportedAttrs(DWORD, ULONG, const TS_ATTRID*) override { return S_OK; }
  STDMETHODIMP RequestAttrsAtPosition(LONG, ULONG, const TS_ATTRID*, DWORD) override { return S_OK; }
  STDMETHODIMP RequestAttrsTransitioningAtPosition(LONG, ULONG, const TS_ATTRID*, DWORD) override { return S_OK; }

  STDMETHODIMP FindNextAttrTransition(
    LONG start,
    LONG,
    ULONG,
    const TS_ATTRID*,
    DWORD,
    LONG* next,
    BOOL* found,
    LONG* foundOffset
  ) override {
    if (!next || !found || !foundOffset) return E_POINTER;
    *next = start;
    *found = FALSE;
    *foundOffset = 0;
    return S_OK;
  }

  STDMETHODIMP RetrieveRequestedAttrs(ULONG, TS_ATTRVAL*, ULONG* fetched) override {
    if (!fetched) return E_POINTER;
    *fetched = 0;
    return S_OK;
  }

  STDMETHODIMP GetEndACP(LONG* end) override {
    if (!end) return E_POINTER;
    *end = checkedLength();
    return S_OK;
  }

  STDMETHODIMP GetActiveView(TsViewCookie* view) override {
    if (!view) return E_POINTER;
    *view = 1;
    return S_OK;
  }

  STDMETHODIMP GetACPFromPoint(TsViewCookie, const POINT*, DWORD, LONG*) override { return E_NOTIMPL; }
  STDMETHODIMP GetTextExt(TsViewCookie, LONG, LONG, RECT*, BOOL*) override { return E_NOTIMPL; }
  STDMETHODIMP GetScreenExt(TsViewCookie, RECT*) override { return E_NOTIMPL; }

  STDMETHODIMP GetWnd(TsViewCookie, HWND* window) override {
    if (!window) return E_POINTER;
    *window = nullptr;
    return S_OK;
  }

  STDMETHODIMP OnStartComposition(ITfCompositionView* composition, BOOL* accepted) override {
    if (!accepted) return E_POINTER;
    if (composition) composition->AddRef();
    if (compositionView_) compositionView_->Release();
    compositionView_ = composition;
    *accepted = TRUE;
    return S_OK;
  }

  STDMETHODIMP OnUpdateComposition(ITfCompositionView* composition, ITfRange*) override {
    if (composition) composition->AddRef();
    if (compositionView_) compositionView_->Release();
    compositionView_ = composition;
    return S_OK;
  }

  STDMETHODIMP OnEndComposition(ITfCompositionView*) override {
    if (compositionView_) {
      compositionView_->Release();
      compositionView_ = nullptr;
    }
    return S_OK;
  }

  const std::wstring& text() const { return text_; }
  ULONG insertionCalls() const { return insertionCalls_; }
  DWORD lastInsertionFlags() const { return lastInsertionFlags_; }

private:
  ~TestTextStore() {
    if (compositionView_) compositionView_->Release();
    if (sink_) sink_->Release();
  }

  LONG checkedLength() const {
    require(text_.size() <= static_cast<std::size_t>(std::numeric_limits<LONG>::max()), "test text exceeded ACP range");
    return static_cast<LONG>(text_.size());
  }

  bool validRange(LONG start, LONG end) const {
    return start >= 0 && end >= start && end <= checkedLength();
  }

  HRESULT replaceText(LONG start, LONG end, const WCHAR* text, ULONG length, TS_TEXTCHANGE* change) {
    if (!validRange(start, end) || (length > 0 && !text) ||
        length > static_cast<ULONG>(std::numeric_limits<LONG>::max()) ||
        start > std::numeric_limits<LONG>::max() - static_cast<LONG>(length)) {
      return E_INVALIDARG;
    }
    const std::wstring replacement = length == 0 ? std::wstring() : std::wstring(text, text + length);
    text_.replace(
      static_cast<std::size_t>(start),
      static_cast<std::size_t>(end - start),
      replacement
    );
    const LONG newEnd = start + static_cast<LONG>(length);
    TS_TEXTCHANGE localChange = {start, end, newEnd};
    if (change) *change = localChange;
    selectionStart_ = newEnd;
    selectionEnd_ = newEnd;
    return S_OK;
  }

  long refCount_ = 1;
  ITextStoreACPSink* sink_ = nullptr;
  ITfCompositionView* compositionView_ = nullptr;
  std::wstring text_;
  LONG selectionStart_ = 0;
  LONG selectionEnd_ = 0;
  ULONG insertionCalls_ = 0;
  DWORD lastInsertionFlags_ = 0;
};

} // namespace

int main() {
  using namespace lekh::tsf;

  const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  require(SUCCEEDED(initialized), "COM initialization failed");

  ITfThreadMgr* threadManager = nullptr;
  HRESULT hr = CoCreateInstance(
    CLSID_TF_ThreadMgr,
    nullptr,
    CLSCTX_INPROC_SERVER,
    IID_ITfThreadMgr,
    reinterpret_cast<void**>(&threadManager)
  );
  require(SUCCEEDED(hr) && threadManager, "Windows TSF thread manager unavailable");

  TfClientId applicationClientId = TF_CLIENTID_NULL;
  hr = threadManager->Activate(&applicationClientId);
  require(SUCCEEDED(hr) && applicationClientId != TF_CLIENTID_NULL, "Windows TSF activation failed");

  ITfClientId* clientIdProvider = nullptr;
  hr = threadManager->QueryInterface(IID_ITfClientId, reinterpret_cast<void**>(&clientIdProvider));
  require(SUCCEEDED(hr) && clientIdProvider, "Windows TSF client-ID provider unavailable");
  TfClientId textServiceClientId = TF_CLIENTID_NULL;
  hr = clientIdProvider->GetClientId(CLSID_LekhTextService, &textServiceClientId);
  clientIdProvider->Release();
  require(
    SUCCEEDED(hr) && textServiceClientId != TF_CLIENTID_NULL && textServiceClientId != applicationClientId,
    "Windows TSF did not issue a distinct Lekh text-service client ID"
  );

  ITfDocumentMgr* documentManager = nullptr;
  hr = threadManager->CreateDocumentMgr(&documentManager);
  require(SUCCEEDED(hr) && documentManager, "Windows TSF document manager creation failed");

  auto* sink = new TestTextStore(L"Latin remains: ");
  ITfContext* context = nullptr;
  TfEditCookie editCookie = 0;
  hr = documentManager->CreateContext(
    applicationClientId,
    0,
    static_cast<ITextStoreACP*>(sink),
    &context,
    &editCookie
  );
  require(SUCCEEDED(hr) && context, "Windows TSF context creation failed");
  hr = documentManager->Push(context);
  require(SUCCEEDED(hr), "Windows TSF context push failed");
  hr = threadManager->SetFocus(documentManager);
  require(SUCCEEDED(hr), "Windows TSF document focus failed");

  ITfComposition* activeComposition = nullptr;
  EngineDecision commit;
  commit.action = EngineAction::Commit;
  commit.committedText = L"\u0928\u092e\u0938\u094d\u0924\u0947";
  EditSessionDiagnostics commitDiagnostics;
  const bool commitApplied = applyEngineDecision(
    context,
    textServiceClientId,
    &activeComposition,
    commit,
    &commitDiagnostics
  );
  if (!commitApplied) {
    std::cerr << "commit diagnostics: target_length=" << sink->text().size()
              << " insertion_calls=" << sink->insertionCalls()
              << " insertion_flags=0x" << std::hex << sink->lastInsertionFlags()
              << " request_hresult=0x" << static_cast<std::uint32_t>(commitDiagnostics.requestResult)
              << " session_hresult=0x" << static_cast<std::uint32_t>(commitDiagnostics.sessionResult)
              << " host_mutated=" << (commitDiagnostics.hostTextMutated ? "true" : "false") << '\n';
  }
  require(commitApplied, "TSF commit edit session did not inject the deterministic Devanagari result");
  require(activeComposition == nullptr, "TSF composition remained active after commit");
  require(
    sink->text() == L"Latin remains: \u0928\u092e\u0938\u094d\u0924\u0947",
    "committed Devanagari text did not reach the target exactly or corrupted existing Latin text"
  );

  threadManager->SetFocus(nullptr);
  documentManager->Pop(TF_POPF_ALL);
  context->Release();
  documentManager->Release();
  sink->Release();
  threadManager->Deactivate();
  threadManager->Release();
  CoUninitialize();

  std::cout << "Windows TSF Devanagari injection integration test passed\n";
  return 0;
}
