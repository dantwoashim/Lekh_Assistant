#include "CandidateState.h"
#include "Guids.h"
#include "TsfEditSession.h"

#include <msctf.h>
#include <olectl.h>
#include <textstor.h>
#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <iterator>
#include <limits>
#include <optional>
#include <string>
#include <utility>

long g_objectCount = 0;

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

bool livePipelineRequested() {
  wchar_t value[8] = {};
  const DWORD length = GetEnvironmentVariableW(
    L"LEKH_TSF_LIVE_PIPELINE_TEST",
    value,
    static_cast<DWORD>(std::size(value))
  );
  return length == 1 && value[0] == L'1';
}

LPARAM keyMessageParameter(WPARAM virtualKey) {
  const UINT scanCode = MapVirtualKeyW(static_cast<UINT>(virtualKey), MAPVK_VK_TO_VSC);
  return static_cast<LPARAM>(scanCode << 16);
}

void pumpMessages() {
  MSG message = {};
  while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
    if (message.message == WM_QUIT) continue;
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
}

bool focusHostWindow(HWND window) {
  if (!window) return false;
  const HWND foregroundWindow = GetForegroundWindow();
  const DWORD foregroundThread = foregroundWindow
    ? GetWindowThreadProcessId(foregroundWindow, nullptr)
    : 0;
  const DWORD currentThread = GetCurrentThreadId();
  const bool attached = foregroundThread != 0 && foregroundThread != currentThread &&
    AttachThreadInput(currentThread, foregroundThread, TRUE) != FALSE;
  ShowWindow(window, SW_SHOWNORMAL);
  SetWindowPos(window, HWND_TOPMOST, 40, 40, 320, 120, SWP_SHOWWINDOW);
  const BOOL foreground = SetForegroundWindow(window);
  SetActiveWindow(window);
  SetFocus(window);
  if (attached) AttachThreadInput(currentThread, foregroundThread, FALSE);
  pumpMessages();
  return foreground != FALSE && GetFocus() == window;
}

bool containsDevanagari(const std::wstring& text) {
  return std::any_of(text.begin(), text.end(), [](wchar_t character) {
    return character >= L'\u0900' && character <= L'\u097f';
  });
}

class TestTextStore final : public ITextStoreACP, public ITfContextOwnerCompositionSink {
public:
  struct Options {
    bool forceAsyncWrites = false;
    bool rejectWriteLocks = false;
    bool rejectCompositions = false;
    bool forceAsyncReads = false;
  };

  TestTextStore(std::wstring initialText, HWND window, Options options = {})
    : text_(std::move(initialText)),
      selectionStart_(checkedLength()),
      selectionEnd_(checkedLength()),
      window_(window),
      options_(options) {}

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
      return CONNECT_E_ADVISELIMIT;
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
    if (!matches) return CONNECT_E_NOCONNECTION;
    sink_->Release();
    sink_ = nullptr;
    return S_OK;
  }

  STDMETHODIMP RequestLock(DWORD lockFlags, HRESULT* sessionResult) override {
    if (!sessionResult) return E_POINTER;
    *sessionResult = E_FAIL;
    if (!sink_) return E_UNEXPECTED;

    constexpr DWORD kAllowedFlags = TS_LF_SYNC | TS_LF_READWRITE;
    if ((lockFlags & ~kAllowedFlags) != 0 || (lockFlags & TS_LF_READ) == 0) {
      *sessionResult = E_INVALIDARG;
      return E_INVALIDARG;
    }
    const DWORD access = (lockFlags & TS_LF_READWRITE) == TS_LF_READWRITE
      ? TS_LF_READWRITE
      : TS_LF_READ;
    const bool synchronous = (lockFlags & TS_LF_SYNC) != 0;
    const bool write = access == TS_LF_READWRITE;
    ++lockRequestCount_;

    if (write && options_.rejectWriteLocks) {
      *sessionResult = TS_E_READONLY;
      return S_OK;
    }
    const bool forceAsync = write ? options_.forceAsyncWrites : options_.forceAsyncReads;
    if (grantedLock_ != 0 || forceAsync) {
      if (synchronous) {
        *sessionResult = TS_E_SYNCHRONOUS;
        return S_OK;
      }
      pendingLock_ = mergeAccess(pendingLock_, access);
      ++asyncLockRequestCount_;
      *sessionResult = TS_S_ASYNC;
      return S_OK;
    }

    *sessionResult = grantLock(access);
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
    if (!hasReadLock()) return TS_E_NOLOCK;
    if (!resultStart || !resultEnd || !validRange(testStart, testEnd)) return E_INVALIDARG;
    // A query result describes a valid range in the current document. It must
    // never manufacture a future endpoint beyond GetEndACP().
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
    if (!hasReadLock()) return TS_E_NOLOCK;
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
    if (!hasWriteLock()) return TS_E_NOLOCK;
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
    if (!hasReadLock()) return TS_E_NOLOCK;
    if (!plainLength || !runCount || !nextPosition) return E_POINTER;
    const LONG resolvedEnd = end == -1 ? checkedLength() : end;
    if (!validRange(start, resolvedEnd)) return TS_E_INVALIDPOS;
    const ULONG available = static_cast<ULONG>(resolvedEnd - start);
    const ULONG copied = std::min(available, plainCapacity);
    if (copied > 0 && !plainText) return E_POINTER;
    if (copied > 0) text_.copy(plainText, copied, static_cast<std::size_t>(start));
    *plainLength = copied;
    *runCount = 0;
    if (runCapacity > 0 && copied > 0) {
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
    if (!hasWriteLock()) return TS_E_NOLOCK;
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
    if (!hasWriteLock()) return TS_E_NOLOCK;
    ++insertionCalls_;
    lastInsertionFlags_ = flags;
    lastInsertionLength_ = length;
    const LONG insertionStart = selectionStart_;
    const LONG insertionEnd = selectionEnd_;
    if ((flags & TS_IAS_QUERYONLY) != 0) {
      if (start) *start = insertionStart;
      if (end) *end = insertionEnd;
      if (change) *change = TS_TEXTCHANGE{insertionStart, insertionEnd, insertionEnd};
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
    if (!hasReadLock()) return TS_E_NOLOCK;
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

  STDMETHODIMP GetTextExt(TsViewCookie, LONG start, LONG end, RECT* rectangle, BOOL* clipped) override {
    if (!hasReadLock()) return TS_E_NOLOCK;
    if (!rectangle || !clipped || !validRange(start, end)) return E_INVALIDARG;
    *rectangle = RECT{100, 200, 101, 220};
    *clipped = FALSE;
    return S_OK;
  }

  STDMETHODIMP GetScreenExt(TsViewCookie, RECT* rectangle) override {
    if (!rectangle) return E_POINTER;
    *rectangle = RECT{0, 0, 800, 600};
    return S_OK;
  }

  STDMETHODIMP GetWnd(TsViewCookie, HWND* window) override {
    if (!window) return E_POINTER;
    *window = window_;
    return S_OK;
  }

  STDMETHODIMP OnStartComposition(ITfCompositionView* composition, BOOL* accepted) override {
    if (!accepted) return E_POINTER;
    ++compositionStartCalls_;
    *accepted = options_.rejectCompositions ? FALSE : TRUE;
    if (!*accepted) return S_OK;
    if (composition) composition->AddRef();
    if (compositionView_) compositionView_->Release();
    compositionView_ = composition;
    return S_OK;
  }

  STDMETHODIMP OnUpdateComposition(ITfCompositionView* composition, ITfRange*) override {
    if (composition) composition->AddRef();
    if (compositionView_) compositionView_->Release();
    compositionView_ = composition;
    return S_OK;
  }

  STDMETHODIMP OnEndComposition(ITfCompositionView*) override {
    ++compositionEndCalls_;
    if (compositionView_) {
      compositionView_->Release();
      compositionView_ = nullptr;
    }
    return S_OK;
  }

  bool grantPendingLock() {
    if (!pendingLock_ || !sink_) return false;
    const DWORD access = pendingLock_;
    pendingLock_ = 0;
    lastAsyncLockResult_ = grantLock(access);
    return true;
  }

  bool hasPendingLock() const { return pendingLock_ != 0; }
  const std::wstring& text() const { return text_; }
  ULONG insertionCalls() const { return insertionCalls_; }
  DWORD lastInsertionFlags() const { return lastInsertionFlags_; }
  ULONG lastInsertionLength() const { return lastInsertionLength_; }
  ULONG compositionStartCalls() const { return compositionStartCalls_; }
  ULONG compositionEndCalls() const { return compositionEndCalls_; }
  ULONG asyncLockRequestCount() const { return asyncLockRequestCount_; }
  DWORD lastGrantedLockFlags() const { return lastGrantedLockFlags_; }
  HRESULT lastAsyncLockResult() const { return lastAsyncLockResult_; }

private:
  ~TestTextStore() {
    if (compositionView_) compositionView_->Release();
    if (sink_) sink_->Release();
  }

  static DWORD mergeAccess(DWORD current, DWORD requested) {
    if (current == TS_LF_READWRITE || requested == TS_LF_READWRITE) return TS_LF_READWRITE;
    return TS_LF_READ;
  }

  HRESULT grantLock(DWORD access) {
    require(access == TS_LF_READ || access == TS_LF_READWRITE, "test store granted invalid lock flags");
    grantedLock_ = access;
    lastGrantedLockFlags_ = access;
    const HRESULT hr = sink_->OnLockGranted(access);
    grantedLock_ = 0;
    return hr;
  }

  bool hasReadLock() const {
    return grantedLock_ == TS_LF_READ || grantedLock_ == TS_LF_READWRITE;
  }

  bool hasWriteLock() const {
    return grantedLock_ == TS_LF_READWRITE;
  }

  LONG checkedLength() const {
    require(text_.size() <= static_cast<std::size_t>(std::numeric_limits<LONG>::max()),
      "test text exceeded ACP range");
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
    if (change) *change = TS_TEXTCHANGE{start, end, newEnd};
    selectionStart_ = newEnd;
    selectionEnd_ = newEnd;
    return S_OK;
  }

  LONG refCount_ = 1;
  ITextStoreACPSink* sink_ = nullptr;
  ITfCompositionView* compositionView_ = nullptr;
  std::wstring text_;
  LONG selectionStart_ = 0;
  LONG selectionEnd_ = 0;
  HWND window_ = nullptr;
  Options options_;
  DWORD grantedLock_ = 0;
  DWORD pendingLock_ = 0;
  DWORD lastGrantedLockFlags_ = 0;
  HRESULT lastAsyncLockResult_ = S_OK;
  ULONG lockRequestCount_ = 0;
  ULONG asyncLockRequestCount_ = 0;
  ULONG insertionCalls_ = 0;
  DWORD lastInsertionFlags_ = 0;
  ULONG lastInsertionLength_ = 0;
  ULONG compositionStartCalls_ = 0;
  ULONG compositionEndCalls_ = 0;
};

class HostContext final {
public:
  HostContext(
    ITfThreadMgr* threadManager,
    TfClientId applicationClientId,
    HWND window,
    std::wstring initialText,
    TestTextStore::Options options = {}
  ) : threadManager_(threadManager), window_(window) {
    store_ = new TestTextStore(std::move(initialText), window, options);
    HRESULT hr = threadManager_->CreateDocumentMgr(&documentManager_);
    require(SUCCEEDED(hr) && documentManager_, "Windows TSF document manager creation failed");
    TfEditCookie editCookie = 0;
    hr = documentManager_->CreateContext(
      applicationClientId,
      0,
      static_cast<ITextStoreACP*>(store_),
      &context_,
      &editCookie
    );
    require(SUCCEEDED(hr) && context_, "Windows TSF context creation failed");
    hr = documentManager_->Push(context_);
    require(SUCCEEDED(hr), "Windows TSF context push failed");
    ITfDocumentMgr* previous = nullptr;
    hr = threadManager_->AssociateFocus(window_, documentManager_, &previous);
    if (previous) previous->Release();
    require(SUCCEEDED(hr), "Windows TSF window association failed");
    hr = threadManager_->SetFocus(documentManager_);
    require(SUCCEEDED(hr), "Windows TSF document focus failed");
    require(focusHostWindow(window_), "Windows TSF host window could not receive OS focus");
  }

  ~HostContext() {
    ITfDocumentMgr* previous = nullptr;
    threadManager_->AssociateFocus(window_, nullptr, &previous);
    if (previous) previous->Release();
    threadManager_->SetFocus(nullptr);
    if (documentManager_) documentManager_->Pop(TF_POPF_ALL);
    if (context_) context_->Release();
    if (documentManager_) documentManager_->Release();
    if (store_) store_->Release();
  }

  ITfContext* context() const { return context_; }
  TestTextStore* store() const { return store_; }

private:
  ITfThreadMgr* threadManager_ = nullptr;
  HWND window_ = nullptr;
  ITfDocumentMgr* documentManager_ = nullptr;
  ITfContext* context_ = nullptr;
  TestTextStore* store_ = nullptr;
};

struct CompletionCapture {
  ULONG calls = 0;
  lekh::tsf::EditSessionOutcome outcome;
};

struct PrivacyCapture {
  ULONG calls = 0;
  lekh::tsf::PrivacyInspectionOutcome outcome;
};

void __stdcall capturePrivacy(
  void* context,
  const lekh::tsf::PrivacyInspectionOutcome& outcome
) {
  auto* capture = static_cast<PrivacyCapture*>(context);
  ++capture->calls;
  capture->outcome = outcome;
  capture->outcome.context = nullptr;
}

void __stdcall captureCompletion(void* context, const lekh::tsf::EditSessionOutcome& outcome) {
  auto* capture = static_cast<CompletionCapture*>(context);
  ++capture->calls;
  capture->outcome = outcome;
  capture->outcome.context = nullptr;
  capture->outcome.state = nullptr;
}

template <typename Predicate>
bool drainUntil(TestTextStore* store, Predicate predicate, DWORD timeoutMs = 2000) {
  const ULONGLONG deadline = GetTickCount64() + timeoutMs;
  while (GetTickCount64() <= deadline) {
    while (store && store->grantPendingLock()) {
      require(SUCCEEDED(store->lastAsyncLockResult()), "queued text-store lock failed");
    }
    pumpMessages();
    if (predicate()) return true;
    Sleep(1);
  }
  return predicate();
}

void testPrivacyClassifier() {
  using namespace lekh::tsf;
  require(classifyInputScopes(nullptr, 0) == ContextPrivacy::Safe,
    "absent optional input-scope metadata was not safe");
  const InputScope normal[] = {IS_DEFAULT, IS_SEARCH};
  require(classifyInputScopes(normal, static_cast<UINT>(std::size(normal))) == ContextPrivacy::Safe,
    "ordinary input scopes were not safe");
  const InputScope sensitive[] = {
    IS_PASSWORD,
    IS_PRIVATE,
    IS_NUMERIC_PASSWORD,
    IS_NUMERIC_PIN,
    IS_ALPHANUMERIC_PIN,
    IS_ALPHANUMERIC_PIN_SET
  };
  for (const InputScope scope : sensitive) {
    require(classifyInputScopes(&scope, 1) == ContextPrivacy::Sensitive,
      "an explicit sensitive input scope was not blocked");
  }
  const InputScope malformed = static_cast<InputScope>(0x7fffffff);
  require(classifyInputScopes(&malformed, 1) == ContextPrivacy::Unknown,
    "a malformed input scope was not blocked as unknown");
}

void testAsyncPrivacyInspection(
  ITfThreadMgr* threadManager,
  TfClientId applicationClientId,
  TfClientId textServiceClientId,
  HWND window
) {
  using namespace lekh::tsf;
  HostContext host(
    threadManager,
    applicationClientId,
    window,
    L"Privacy preflight: ",
    TestTextStore::Options{false, false, false, true}
  );
  PrivacyCapture capture;
  const PrivacyInspectionSubmission submission = submitContextPrivacyInspection(
    host.context(),
    textServiceClientId,
    17,
    PrivacyInspectionCallback{nullptr, &capture, &capturePrivacy}
  );
  require(submission.status == EditSubmissionStatus::Queued,
    "async-only privacy host did not queue the read edit session");
  require(drainUntil(host.store(), [&] { return capture.calls == 1; }),
    "queued privacy inspection never completed");
  if (!capture.outcome.editSessionRan || FAILED(capture.outcome.operationResult) ||
      capture.outcome.privacy != ContextPrivacy::Safe) {
    std::cerr << "privacy diagnostic: ran=" << capture.outcome.editSessionRan
              << " hr=0x" << std::hex << static_cast<unsigned long>(capture.outcome.operationResult)
              << " classification=" << static_cast<int>(capture.outcome.privacy) << std::dec << '\n';
  }
  require(capture.outcome.editSessionRan && SUCCEEDED(capture.outcome.operationResult) &&
          capture.outcome.privacy == ContextPrivacy::Safe,
    "absent optional input-scope metadata was not classified safe asynchronously");
  require((host.store()->lastGrantedLockFlags() & TS_LF_SYNC) == 0,
    "the async privacy host forwarded TS_LF_SYNC to OnLockGranted");
}

void testAsyncFirstComposition(
  ITfThreadMgr* threadManager,
  TfClientId applicationClientId,
  TfClientId textServiceClientId,
  HWND window
) {
  using namespace lekh::tsf;
  const std::wstring prefix = L"Latin remains: ";
  HostContext host(
    threadManager,
    applicationClientId,
    window,
    prefix,
    TestTextStore::Options{true, false, false}
  );
  require(inspectContextPrivacy(host.context(), textServiceClientId) == ContextPrivacy::Safe,
    "ordinary context without optional input-scope metadata was suppressed");

  CompositionState* state = createCompositionState();
  require(state != nullptr, "composition state allocation failed");

  EngineDecision first;
  first.action = EngineAction::Compose;
  first.compositionText = L"n";
  first.displayText = L"\u0928";
  first.caret = 1;
  CompletionCapture firstCapture;
  const EditSessionCallback firstCallback{nullptr, &firstCapture, &captureCompletion};
  EditSubmissionResult submission = submitEngineDecision(
    host.context(), textServiceClientId, state, first, L"n", 1, firstCallback
  );
  require(submission.status == EditSubmissionStatus::Queued,
    "async-only host did not queue the first composition edit");
  require(host.store()->text() == prefix,
    "queued first composition mutated text before the host granted its lock");
  require(drainUntil(host.store(), [&] { return firstCapture.calls == 1; }),
    "queued first composition never completed");
  require(firstCapture.outcome.desiredApplied && firstCapture.outcome.consumed,
    "queued first composition was not applied");
  require(firstCapture.outcome.failureStage == EditFailureStage::None,
    "queued first composition reported an unexpected failure stage");
  require(host.store()->text() == prefix + L"\u0928",
    "first composition did not insert the exact Devanagari preview");
  require(compositionStateIsActive(state), "first composition was not retained");
  require(host.store()->compositionStartCalls() == 1,
    "first composition was not created exactly once");
  require(host.store()->lastInsertionFlags() == TF_IAS_QUERYONLY &&
          host.store()->lastInsertionLength() == 1,
    "first composition did not query the actual text over an in-document insertion range");
  require(host.store()->asyncLockRequestCount() > 0,
    "async-only host did not exercise a queued write lock");
  require((host.store()->lastGrantedLockFlags() & TS_LF_SYNC) == 0,
    "the synthetic host forwarded TS_LF_SYNC to OnLockGranted");

  EngineDecision update;
  update.action = EngineAction::Compose;
  update.compositionText = L"nam";
  update.displayText = L"\u0928\u092e";
  update.caret = 3;
  CompletionCapture updateCapture;
  submission = submitEngineDecision(
    host.context(), textServiceClientId, state, update, L"nam", 1,
    EditSessionCallback{nullptr, &updateCapture, &captureCompletion}
  );
  require(submission.status == EditSubmissionStatus::Queued,
    "composition update was not queued on the async-only host");
  require(drainUntil(host.store(), [&] { return updateCapture.calls == 1; }),
    "queued composition update never completed");
  require(updateCapture.outcome.desiredApplied && updateCapture.outcome.consumed,
    "queued composition update was not applied");
  require(host.store()->text() == prefix + L"\u0928\u092e",
    "composition update did not replace the tracked range exactly");

  EngineDecision commit;
  commit.action = EngineAction::Commit;
  commit.committedText = L"\u0928\u092e\u0938\u094d\u0924\u0947 ";
  CompletionCapture commitCapture;
  submission = submitEngineDecision(
    host.context(), textServiceClientId, state, commit, L"namaste ", 1,
    EditSessionCallback{nullptr, &commitCapture, &captureCompletion}
  );
  require(submission.status == EditSubmissionStatus::Queued,
    "composition commit was not queued on the async-only host");
  require(drainUntil(host.store(), [&] { return commitCapture.calls == 1; }),
    "queued composition commit never completed");
  require(commitCapture.outcome.desiredApplied && commitCapture.outcome.consumed,
    "queued composition commit was not applied");
  require(host.store()->text() == prefix + L"\u0928\u092e\u0938\u094d\u0924\u0947 ",
    "commit did not replace the composition with the exact final text");
  require(!compositionStateIsActive(state), "composition remained active after commit");
  require(host.store()->compositionEndCalls() > 0, "host was not notified that composition ended");

  releaseCompositionState(&state);
}

void testCompositionFailureFallsBackExactlyOnce(
  ITfThreadMgr* threadManager,
  TfClientId applicationClientId,
  TfClientId textServiceClientId,
  HWND window
) {
  using namespace lekh::tsf;
  const std::wstring prefix = L"Fallback: ";
  HostContext host(
    threadManager,
    applicationClientId,
    window,
    prefix,
    TestTextStore::Options{false, false, true}
  );
  CompositionState* state = createCompositionState();
  require(state != nullptr, "fallback composition state allocation failed");

  EngineDecision decision;
  decision.action = EngineAction::Compose;
  decision.compositionText = L"n";
  decision.displayText = L"\u0928";
  const EditSubmissionResult submission = submitEngineDecision(
    host.context(), textServiceClientId, state, decision, L"n", 2
  );
  require(submission.status == EditSubmissionStatus::Completed,
    "composition-rejecting host did not complete the literal fallback edit");
  require(submission.outcome.failureStage == EditFailureStage::StartComposition,
    "composition rejection was not pinpointed at StartComposition");
  require(submission.outcome.fallbackApplied && submission.outcome.consumed,
    "composition rejection did not fall open");
  require(host.store()->text() == prefix + L"n",
    "composition rejection lost or duplicated the literal key");
  require(host.store()->compositionStartCalls() <= 2,
    "composition-rejecting host was probed beyond the explicit and manager fallback attempts");
  require(host.store()->insertionCalls() == 2,
    "fallback path did not perform one query and one ordinary literal insertion");
  require(!compositionStateIsActive(state), "rejected composition left tracked host state");

  releaseCompositionState(&state);
}

void testRejectedEditPassesThrough(
  ITfThreadMgr* threadManager,
  TfClientId applicationClientId,
  TfClientId textServiceClientId,
  HWND window
) {
  using namespace lekh::tsf;
  const std::wstring prefix = L"Read only: ";
  HostContext host(
    threadManager,
    applicationClientId,
    window,
    prefix,
    TestTextStore::Options{false, true, false}
  );
  CompositionState* state = createCompositionState();
  require(state != nullptr, "read-only composition state allocation failed");
  EngineDecision decision;
  decision.action = EngineAction::Compose;
  decision.compositionText = L"n";
  decision.displayText = L"\u0928";
  const EditSubmissionResult submission = submitEngineDecision(
    host.context(), textServiceClientId, state, decision, L"n", 3
  );
  require(submission.status == EditSubmissionStatus::Rejected,
    "read-only host edit was not rejected before key consumption");
  require(!submission.outcome.editSessionRan && !submission.outcome.hostTextMutated,
    "read-only host unexpectedly ran or mutated the edit session");
  require(host.store()->text() == prefix,
    "rejected host edit changed text instead of allowing pass-through");
  require(!compositionStateHasPendingOperations(state),
    "rejected edit leaked a pending composition operation");
  releaseCompositionState(&state);
}

void testCandidateState() {
  using namespace lekh::tsf;
  CandidateState candidates;
  candidates.update({
    {L"candidate-1", L"\u0928\u092e\u0938\u094d\u0915\u093e\u0930", L"namaskar", L"1"},
    {L"candidate-2", L"\u0928\u092e\u0938\u094d\u0924\u0947", L"namaste", L"2"}
  }, true);
  const CandidateInteraction selection = candidates.handle(CandidateCommand::Digit2);
  require(selection.type == CandidateInteractionType::CommitRequested && selection.candidate &&
          selection.candidate->text == L"\u0928\u092e\u0938\u094d\u0924\u0947",
    "candidate digit selection did not request the exact candidate commit");
}

void runLiveProfilePipeline(
  ITfThreadMgr* threadManager,
  TfClientId applicationClientId,
  HWND window
) {
  if (!livePipelineRequested()) return;

  const std::wstring prefix = L"Live: ";
  HostContext host(
    threadManager,
    applicationClientId,
    window,
    prefix,
    TestTextStore::Options{true, false, false}
  );

  ITfInputProcessorProfileMgr* profileManager = nullptr;
  HRESULT hr = CoCreateInstance(
    CLSID_TF_InputProcessorProfiles,
    nullptr,
    CLSCTX_INPROC_SERVER,
    IID_ITfInputProcessorProfileMgr,
    reinterpret_cast<void**>(&profileManager)
  );
  require(SUCCEEDED(hr) && profileManager, "live TSF profile manager unavailable");
  hr = profileManager->ActivateProfile(
    TF_PROFILETYPE_INPUTPROCESSOR,
    MAKELANGID(LANG_NEPALI, SUBLANG_DEFAULT),
    CLSID_LekhTextService,
    GUID_LekhTextServiceProfile,
    nullptr,
    TF_IPPMF_FORPROCESS | TF_IPPMF_DONTCARECURRENTINPUTLANGUAGE
  );
  require(SUCCEEDED(hr), "live Lekh profile activation failed");
  require(focusHostWindow(window), "live TSF host lost OS focus after profile activation");

  TF_INPUTPROCESSORPROFILE activeProfile = {};
  hr = profileManager->GetActiveProfile(GUID_TFCAT_TIP_KEYBOARD, &activeProfile);
  require(
    hr == S_OK && activeProfile.dwProfileType == TF_PROFILETYPE_INPUTPROCESSOR &&
    IsEqualGUID(activeProfile.clsid, CLSID_LekhTextService) &&
    IsEqualGUID(activeProfile.guidProfile, GUID_LekhTextServiceProfile),
    "Lekh was not the active live TSF keyboard profile"
  );

  ITfKeystrokeMgr* keystrokeManager = nullptr;
  hr = threadManager->QueryInterface(IID_ITfKeystrokeMgr, reinterpret_cast<void**>(&keystrokeManager));
  require(SUCCEEDED(hr) && keystrokeManager, "live TSF keystroke manager unavailable");

  constexpr WPARAM keys[] = {L'N', L'A', L'M', L'A', L'S', L'T', L'E', VK_SPACE};
  std::size_t previousLength = host.store()->text().size();
  for (std::size_t index = 0; index < std::size(keys); ++index) {
    const WPARAM key = keys[index];
    const LPARAM parameter = keyMessageParameter(key);
    BOOL testEaten = FALSE;
    hr = keystrokeManager->TestKeyDown(key, parameter, &testEaten);
    require(SUCCEEDED(hr) && testEaten == TRUE,
      "live Lekh key was not accepted by OnTestKeyDown");
    BOOL keyEaten = FALSE;
    hr = keystrokeManager->KeyDown(key, parameter, &keyEaten);
    require(SUCCEEDED(hr) && keyEaten == TRUE,
      "live Lekh key was not accepted by OnKeyDown");
    require(drainUntil(host.store(), [&] {
      return !host.store()->hasPendingLock() &&
        (index != 0 || host.store()->text().size() > previousLength);
    }), "live queued TSF edit did not complete");
    if (index == 0) {
      require(host.store()->text().size() > previousLength && containsDevanagari(host.store()->text()),
        "live first key did not create a Devanagari composition");
    }
    previousLength = host.store()->text().size();
  }

  require(host.store()->text().size() > prefix.size() && containsDevanagari(host.store()->text()),
    "live Lekh pipeline produced no Devanagari host text");
  require(host.store()->compositionStartCalls() > 0,
    "live Lekh pipeline bypassed composition creation");

  keystrokeManager->Release();
  profileManager->DeactivateProfile(
    TF_PROFILETYPE_INPUTPROCESSOR,
    MAKELANGID(LANG_NEPALI, SUBLANG_DEFAULT),
    CLSID_LekhTextService,
    GUID_LekhTextServiceProfile,
    nullptr,
    TF_IPPMF_FORPROCESS
  );
  profileManager->Release();
  drainUntil(host.store(), [&] { return !host.store()->hasPendingLock(); });
  std::wcout << L"Live Lekh pipeline inserted: " << host.store()->text().substr(prefix.size()) << L'\n';
}

} // namespace

int main() {
  const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  require(SUCCEEDED(initialized), "COM initialization failed");

  HWND hostWindow = CreateWindowExW(
    WS_EX_TOOLWINDOW,
    L"STATIC",
    L"Lekh Keyboard focused TSF integration host",
    WS_OVERLAPPEDWINDOW,
    40,
    40,
    320,
    120,
    nullptr,
    nullptr,
    GetModuleHandleW(nullptr),
    nullptr
  );
  require(hostWindow != nullptr, "focused TSF host window creation failed");
  require(focusHostWindow(hostWindow), "focused TSF host window could not receive OS focus");

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
    SUCCEEDED(hr) && textServiceClientId != TF_CLIENTID_NULL &&
    textServiceClientId != applicationClientId,
    "Windows TSF did not issue a distinct Lekh text-service client ID"
  );

  testPrivacyClassifier();
  testAsyncPrivacyInspection(threadManager, applicationClientId, textServiceClientId, hostWindow);
  testAsyncFirstComposition(threadManager, applicationClientId, textServiceClientId, hostWindow);
  testCompositionFailureFallsBackExactlyOnce(
    threadManager, applicationClientId, textServiceClientId, hostWindow
  );
  testRejectedEditPassesThrough(threadManager, applicationClientId, textServiceClientId, hostWindow);
  testCandidateState();
  runLiveProfilePipeline(threadManager, applicationClientId, hostWindow);

  threadManager->SetFocus(nullptr);
  threadManager->Deactivate();
  threadManager->Release();
  DestroyWindow(hostWindow);
  CoUninitialize();

  require(g_objectCount == 0, "TSF injection tests leaked asynchronous COM edit-session objects");
  std::cout << "Focused asynchronous TSF composition integration tests passed\n";
  return 0;
}
