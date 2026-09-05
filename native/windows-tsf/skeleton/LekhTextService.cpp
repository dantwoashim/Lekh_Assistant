#include "LekhTextService.h"

#include "Guids.h"

#include <algorithm>
#include <cwchar>
#include <iterator>
#include <new>
#include <optional>
#include <string>
#include <utility>

extern long g_objectCount;

namespace {

std::wstring logicalKey(WPARAM wParam, LPARAM lParam) {
  switch (wParam) {
    case VK_SPACE: return L" ";
    case VK_BACK: return L"Backspace";
    case VK_RETURN: return L"Enter";
    case VK_ESCAPE: return L"Escape";
    case VK_TAB: return L"Tab";
    case VK_RIGHT: return L"ArrowRight";
    default: break;
  }

  BYTE keyboardState[256] = {};
  if (!GetKeyboardState(keyboardState)) return L"";
  wchar_t translated[8] = {};
  const UINT scanCode = static_cast<UINT>((static_cast<ULONG_PTR>(lParam) >> 16) & 0xff);
  const int translatedCount = ToUnicodeEx(
    static_cast<UINT>(wParam),
    scanCode,
    keyboardState,
    translated,
    static_cast<int>(std::size(translated)),
    0x4,
    GetKeyboardLayout(0)
  );
  if (translatedCount <= 0) return L"";
  return std::wstring(
    translated,
    translated + std::min(translatedCount, static_cast<int>(std::size(translated)))
  );
}

bool isRomanizedLetter(const std::wstring& key) {
  return key.size() == 1 && (
    (key[0] >= L'a' && key[0] <= L'z') ||
    (key[0] >= L'A' && key[0] <= L'Z')
  );
}

std::optional<lekh::tsf::CandidateCommand> candidateCommand(WPARAM wParam) {
  using lekh::tsf::CandidateCommand;
  switch (wParam) {
    case VK_UP: return CandidateCommand::Previous;
    case VK_DOWN: return CandidateCommand::Next;
    case VK_SPACE: return CandidateCommand::ConfirmWithSpace;
    case VK_RETURN: return CandidateCommand::ConfirmWithEnter;
    case L'1':
    case VK_NUMPAD1: return CandidateCommand::Digit1;
    case L'2':
    case VK_NUMPAD2: return CandidateCommand::Digit2;
    case L'3':
    case VK_NUMPAD3: return CandidateCommand::Digit3;
    case L'4':
    case VK_NUMPAD4: return CandidateCommand::Digit4;
    case L'5':
    case VK_NUMPAD5: return CandidateCommand::Digit5;
    case L'6':
    case VK_NUMPAD6: return CandidateCommand::Digit6;
    case L'7':
    case VK_NUMPAD7: return CandidateCommand::Digit7;
    case L'8':
    case VK_NUMPAD8: return CandidateCommand::Digit8;
    default: return std::nullopt;
  }
}

std::wstring physicalKeyCode(WPARAM wParam, LPARAM lParam) {
  if (wParam >= L'A' && wParam <= L'Z') {
    return L"Key" + std::wstring(1, static_cast<wchar_t>(wParam));
  }
  switch (wParam) {
    case VK_SPACE: return L"Space";
    case VK_BACK: return L"Backspace";
    case VK_RETURN: return L"Enter";
    case VK_ESCAPE: return L"Escape";
    case VK_TAB: return L"Tab";
    case VK_RIGHT: return L"ArrowRight";
    default: {
      const unsigned long scanCode = static_cast<unsigned long>((lParam >> 16) & 0xff);
      return L"Scan" + std::to_wstring(scanCode);
    }
  }
}

lekh::tsf::KeyEvent makeKeyEvent(WPARAM wParam, LPARAM lParam) {
  lekh::tsf::KeyEvent event;
  event.key = logicalKey(wParam, lParam);
  event.code = physicalKeyCode(wParam, lParam);
  event.shift = GetKeyState(VK_SHIFT) < 0;
  event.ctrl = GetKeyState(VK_CONTROL) < 0;
  event.alt = GetKeyState(VK_MENU) < 0;
  event.meta = GetKeyState(VK_LWIN) < 0 || GetKeyState(VK_RWIN) < 0;
  event.repeat = (static_cast<unsigned long long>(lParam) & (1ull << 30)) != 0;
  event.timestamp = GetTickCount64();
  event.nativeCode = static_cast<std::uint32_t>(wParam);
  return event;
}

void removeLastUnicodeScalar(std::wstring& value) {
  if (value.empty()) return;
  value.pop_back();
  if (!value.empty() && value.back() >= 0xd800 && value.back() <= 0xdbff) value.pop_back();
}

std::wstring failOpenTextAfterKey(
  const std::wstring& current,
  const lekh::tsf::KeyEvent& event
) {
  std::wstring next = current;
  if (event.key == L"Backspace") {
    removeLastUnicodeScalar(next);
  } else if (event.key == L"Enter") {
    next.push_back(L'\n');
  } else if (event.key == L"Escape") {
    // Escape is a composition command, not literal text. Preserve the Roman
    // keys already consumed if the composition edit itself cannot be applied.
  } else if (event.key.size() == 1) {
    next.append(event.key);
  }
  return next;
}

std::wstring failOpenTextForDecision(
  const std::wstring& current,
  const lekh::tsf::KeyEvent& event,
  const lekh::tsf::EngineDecision& decision
) {
  if (decision.action == lekh::tsf::EngineAction::Compose) return decision.compositionText;
  if (decision.action == lekh::tsf::EngineAction::Cancel) return current;
  return failOpenTextAfterKey(current, event);
}

std::wstring makeClientInstanceId() {
  GUID guid = {};
  wchar_t value[64] = {};
  if (SUCCEEDED(CoCreateGuid(&guid)) && StringFromGUID2(guid, value, static_cast<int>(std::size(value))) > 0) {
    return L"windows_tsf_" + std::wstring(value);
  }
  return L"windows_tsf_" + std::to_wstring(GetCurrentProcessId()) + L"_" + std::to_wstring(GetTickCount64());
}

std::uint64_t unixEpochMilliseconds() {
  FILETIME fileTime = {};
  GetSystemTimeAsFileTime(&fileTime);
  ULARGE_INTEGER ticks = {};
  ticks.LowPart = fileTime.dwLowDateTime;
  ticks.HighPart = fileTime.dwHighDateTime;
  constexpr std::uint64_t kWindowsToUnixEpochTicks = 116444736000000000ULL;
  return ticks.QuadPart < kWindowsToUnixEpochTicks ? 0 :
    (ticks.QuadPart - kWindowsToUnixEpochTicks) / 10000ULL;
}

} // namespace

LekhTextService::LekhTextService()
  : compositionState_(lekh::tsf::createCompositionState()),
    clientInstanceId_(makeClientInstanceId()) {
  candidateWindow_.setCandidateInvokedCallback([this](std::size_t index) {
    if (!activeContext_ || !candidateState_.visible() || index >= candidateState_.candidates().size()) return;
    commitCandidate(activeContext_, candidateState_.candidates()[index], rawComposition_);
  });
  InterlockedIncrement(&g_objectCount);
}

LekhTextService::~LekhTextService() {
  closeActiveContext(true);
  lekh::tsf::releaseCompositionState(&compositionState_);
  unadviseSinks();
  if (threadMgr_) threadMgr_->Release();
  InterlockedDecrement(&g_objectCount);
}

STDMETHODIMP LekhTextService::QueryInterface(REFIID riid, void** object) {
  if (!object) return E_POINTER;
  *object = nullptr;
  if (riid == IID_IUnknown || riid == IID_ITfTextInputProcessor || riid == IID_ITfTextInputProcessorEx) {
    *object = static_cast<ITfTextInputProcessorEx*>(this);
  } else if (riid == IID_ITfKeyEventSink) {
    *object = static_cast<ITfKeyEventSink*>(this);
  } else if (riid == IID_ITfThreadMgrEventSink) {
    *object = static_cast<ITfThreadMgrEventSink*>(this);
  } else if (riid == IID_ITfTextEditSink) {
    *object = static_cast<ITfTextEditSink*>(this);
  } else if (riid == IID_ITfDisplayAttributeProvider) {
    *object = static_cast<ITfDisplayAttributeProvider*>(this);
  } else {
    return E_NOINTERFACE;
  }
  AddRef();
  return S_OK;
}

STDMETHODIMP_(ULONG) LekhTextService::AddRef() {
  return static_cast<ULONG>(InterlockedIncrement(&refCount_));
}

STDMETHODIMP_(ULONG) LekhTextService::Release() {
  const ULONG ref = static_cast<ULONG>(InterlockedDecrement(&refCount_));
  if (ref == 0) delete this;
  return ref;
}

STDMETHODIMP LekhTextService::Activate(ITfThreadMgr* threadMgr, TfClientId clientId) {
  return ActivateEx(threadMgr, clientId, 0);
}

STDMETHODIMP LekhTextService::ActivateEx(ITfThreadMgr* threadMgr, TfClientId clientId, DWORD flags) {
  if (!threadMgr || clientId == TF_CLIENTID_NULL) return E_INVALIDARG;
  closeActiveContext(true);
  unadviseSinks();
  if (threadMgr_) threadMgr_->Release();
  threadMgr_ = threadMgr;
  threadMgr_->AddRef();
  clientId_ = clientId;
  activationFlags_ = flags;
  contextSuppressed_ = false;
  failOpenPending_ = false;
  preferences_ = lekh::tsf::readWindowsPreferences();
  HRESULT hr = candidateWindow_.initializeDispatcher() ? S_OK : E_FAIL;
  if (SUCCEEDED(hr)) hr = lekh::tsf::registerCompositionDisplayAttribute(&compositionDisplayAttribute_);
  if (SUCCEEDED(hr)) {
    // Ghost styling is progressive enhancement. If registration is unavailable,
    // keep normal transliteration functional and simply omit the suggestion.
    lekh::tsf::registerGhostDisplayAttribute(&ghostDisplayAttribute_);
  }
  if (SUCCEEDED(hr)) hr = adviseSinks();
  if (FAILED(hr)) {
    unadviseSinks();
    clientId_ = TF_CLIENTID_NULL;
    activationFlags_ = 0;
    compositionDisplayAttribute_ = TF_INVALID_GUIDATOM;
    ghostDisplayAttribute_ = TF_INVALID_GUIDATOM;
    threadMgr_->Release();
    threadMgr_ = nullptr;
  } else {
    primeFocusedContext();
  }
  return hr;
}

STDMETHODIMP LekhTextService::Deactivate() {
  closeActiveContext(true);
  unadviseSinks();
  clientId_ = TF_CLIENTID_NULL;
  activationFlags_ = 0;
  compositionDisplayAttribute_ = TF_INVALID_GUIDATOM;
  ghostDisplayAttribute_ = TF_INVALID_GUIDATOM;
  activeGhostVisible_ = false;
  if (threadMgr_) {
    threadMgr_->Release();
    threadMgr_ = nullptr;
  }
  return S_OK;
}

STDMETHODIMP LekhTextService::OnSetFocus(BOOL foreground) {
  if (!foreground) {
    closeActiveContext(true);
    contextSuppressed_ = false;
  } else {
    primeFocusedContext();
  }
  return S_OK;
}

STDMETHODIMP LekhTextService::OnTestKeyDown(ITfContext*, WPARAM wParam, LPARAM lParam, BOOL* eaten) {
  if (!eaten) return E_POINTER;
  // This callback is prediction only. It must not inspect the context, open a
  // daemon session, switch document state, or perform IPC.
  *eaten = shouldHandleKey(wParam, lParam) ? TRUE : FALSE;
  return S_OK;
}

STDMETHODIMP LekhTextService::OnKeyDown(ITfContext* context, WPARAM wParam, LPARAM lParam, BOOL* eaten) {
  if (!eaten) return E_POINTER;
  *eaten = FALSE;
  if (!shouldHandleKey(wParam, lParam) || !prepareSafeContext(context)) return S_OK;
  *eaten = processKey(context, wParam, lParam) ? TRUE : FALSE;
  return S_OK;
}

STDMETHODIMP LekhTextService::OnTestKeyUp(ITfContext*, WPARAM, LPARAM, BOOL* eaten) {
  if (!eaten) return E_POINTER;
  *eaten = FALSE;
  return S_OK;
}

STDMETHODIMP LekhTextService::OnKeyUp(ITfContext*, WPARAM, LPARAM, BOOL* eaten) {
  if (!eaten) return E_POINTER;
  *eaten = FALSE;
  return S_OK;
}

STDMETHODIMP LekhTextService::OnPreservedKey(ITfContext*, REFGUID guid, BOOL* eaten) {
  if (!eaten) return E_POINTER;
  *eaten = FALSE;
  lekh::tsf::NativeTypingMode mode;
  if (IsEqualGUID(guid, GUID_LekhCycleTypingMode)) {
    mode = lekh::tsf::nextWindowsTypingMode(preferences_.mode);
  } else if (IsEqualGUID(guid, GUID_LekhRomanizedTraditionalMode)) {
    mode = lekh::tsf::NativeTypingMode::RomanizedTraditional;
  } else if (IsEqualGUID(guid, GUID_LekhRomanizedRomanizedMode)) {
    mode = lekh::tsf::NativeTypingMode::RomanizedRomanized;
  } else {
    return S_OK;
  }
  if (!lekh::tsf::writeWindowsTypingMode(mode)) return S_OK;
  closeActiveContext(true);
  preferences_.mode = mode;
  primeFocusedContext();
  *eaten = TRUE;
  return S_OK;
}

STDMETHODIMP LekhTextService::OnInitDocumentMgr(ITfDocumentMgr*) {
  return S_OK;
}

STDMETHODIMP LekhTextService::OnUninitDocumentMgr(ITfDocumentMgr*) {
  closeActiveContext(true);
  contextSuppressed_ = false;
  return S_OK;
}

STDMETHODIMP LekhTextService::OnSetFocus(ITfDocumentMgr* focus, ITfDocumentMgr*) {
  closeActiveContext(true);
  contextSuppressed_ = false;
  if (focus) {
    ITfContext* context = nullptr;
    if (SUCCEEDED(focus->GetTop(&context)) && context) {
      primeContextPrivacy(context);
      context->Release();
    }
  }
  return S_OK;
}

STDMETHODIMP LekhTextService::OnPushContext(ITfContext* context) {
  closeActiveContext(true);
  contextSuppressed_ = false;
  primeContextPrivacy(context);
  return S_OK;
}

STDMETHODIMP LekhTextService::OnPopContext(ITfContext*) {
  closeActiveContext(true);
  contextSuppressed_ = false;
  primeFocusedContext();
  return S_OK;
}

STDMETHODIMP LekhTextService::OnEndEdit(
  ITfContext* context,
  TfEditCookie,
  ITfEditRecord* editRecord
) {
  if (!context || !editRecord || context != activeContext_ || clientId_ == TF_CLIENTID_NULL) {
    return S_OK;
  }
  // Our own SetText/SetSelection calls are expected and preserve the privacy
  // result for the same tracked field. External selection or input-scope
  // changes invalidate queued work before another key can reach the engine.
  BOOL ownWriteSession = FALSE;
  if (SUCCEEDED(context->InWriteSession(clientId_, &ownWriteSession)) && ownWriteSession) return S_OK;

  BOOL selectionChanged = FALSE;
  editRecord->GetSelectionStatus(&selectionChanged);

  bool inputScopeChanged = false;
  const GUID* properties[] = {&GUID_PROP_INPUTSCOPE};
  IEnumTfRanges* changedRanges = nullptr;
  if (SUCCEEDED(editRecord->GetTextAndPropertyUpdates(0, properties, 1, &changedRanges)) && changedRanges) {
    ITfRange* changedRange = nullptr;
    ULONG fetched = 0;
    inputScopeChanged = changedRanges->Next(1, &changedRange, &fetched) == S_OK && fetched == 1;
    if (changedRange) changedRange->Release();
    changedRanges->Release();
  }
  if (!selectionChanged && !inputScopeChanged) return S_OK;

  context->AddRef();
  closeActiveContext(true);
  contextSuppressed_ = false;
  primeContextPrivacy(context);
  context->Release();
  return S_OK;
}

STDMETHODIMP LekhTextService::EnumDisplayAttributeInfo(
  IEnumTfDisplayAttributeInfo** enumerator
) {
  return lekh::tsf::createDisplayAttributeEnumerator(enumerator);
}

STDMETHODIMP LekhTextService::GetDisplayAttributeInfo(
  REFGUID guid,
  ITfDisplayAttributeInfo** information
) {
  return lekh::tsf::createDisplayAttributeInfo(guid, information);
}

bool LekhTextService::shouldHandleKey(WPARAM wParam, LPARAM lParam) const {
  if (contextSuppressed_ || (activationFlags_ & TF_TMAE_SECUREMODE) != 0) return false;
  if (GetKeyState(VK_CONTROL) < 0 || GetKeyState(VK_MENU) < 0 ||
      GetKeyState(VK_LWIN) < 0 || GetKeyState(VK_RWIN) < 0) {
    return false;
  }
  if (preferences_.customCandidatePanelEnabled && candidateState_.visible() && candidateCommand(wParam)) return true;
  if (preferences_.mode != lekh::tsf::NativeTypingMode::RomanizedTraditional &&
      preferences_.mode != lekh::tsf::NativeTypingMode::RomanizedRomanized) {
    return false;
  }
  if (isRomanizedLetter(logicalKey(wParam, lParam))) return true;
  const bool hasTrackedText = failOpenPending_ || !rawComposition_.empty() ||
    lekh::tsf::compositionStateIsActive(compositionState_);
  if (!hasTrackedText) return false;
  if (activeGhostVisible_ && !lekh::tsf::compositionStateHasPendingOperations(compositionState_) &&
      (wParam == VK_TAB || wParam == VK_RIGHT)) {
    return true;
  }
  return wParam == VK_SPACE || wParam == VK_BACK || wParam == VK_RETURN || wParam == VK_ESCAPE;
}

void LekhTextService::primeFocusedContext() {
  if (!threadMgr_ || clientId_ == TF_CLIENTID_NULL) return;
  ITfDocumentMgr* documentManager = nullptr;
  if (FAILED(threadMgr_->GetFocus(&documentManager)) || !documentManager) return;
  ITfContext* context = nullptr;
  if (SUCCEEDED(documentManager->GetTop(&context)) && context) {
    primeContextPrivacy(context);
    context->Release();
  }
  documentManager->Release();
}

void LekhTextService::primeContextPrivacy(ITfContext* context) {
  if (!context || clientId_ == TF_CLIENTID_NULL || (activationFlags_ & TF_TMAE_SECUREMODE) != 0) return;
  if (activeContext_ != context) {
    closeActiveContext(true);
    activeContext_ = context;
    activeContext_->AddRef();
    ++contextGeneration_;
    contextSuppressed_ = false;
    contextPrivacy_ = lekh::tsf::ContextPrivacy::Unknown;
    privacyInspectionPending_ = false;
    if (FAILED(adviseContextSink(activeContext_))) {
      textEditSinkCookie_ = TF_INVALID_COOKIE;
    }
  }
  if (contextPrivacy_ != lekh::tsf::ContextPrivacy::Unknown || privacyInspectionPending_) return;

  const lekh::tsf::PrivacyInspectionCallback callback{
    static_cast<IUnknown*>(static_cast<ITfTextInputProcessorEx*>(this)),
    this,
    &LekhTextService::privacyInspectionCompleted
  };
  privacyInspectionPending_ = true;
  const lekh::tsf::PrivacyInspectionSubmission submission =
    lekh::tsf::submitContextPrivacyInspection(
      context,
      clientId_,
      contextGeneration_,
      callback
    );
  if (submission.status == lekh::tsf::EditSubmissionStatus::Completed) {
    privacyInspectionPending_ = false;
    handlePrivacyInspectionCompleted(submission.outcome);
  } else if (submission.status == lekh::tsf::EditSubmissionStatus::Rejected) {
    privacyInspectionPending_ = false;
  }
}

bool LekhTextService::prepareSafeContext(ITfContext* context) {
  if (!context || clientId_ == TF_CLIENTID_NULL || contextSuppressed_ ||
      (activationFlags_ & TF_TMAE_SECUREMODE) != 0) {
    return false;
  }

  if (activeContext_ != context) primeContextPrivacy(context);
  if (activeContext_ != context) return false;

  // Focus-time ASYNCDONTCARE inspection covers hosts such as Word that refuse
  // synchronous key-handler edit sessions. The synchronous READ fast path keeps
  // the first key responsive in ordinary Win32 hosts. Unknown never means safe.
  const lekh::tsf::ContextPrivacy immediate = lekh::tsf::inspectContextPrivacy(context, clientId_);
  if (immediate == lekh::tsf::ContextPrivacy::Sensitive) {
    contextPrivacy_ = immediate;
    contextSuppressed_ = true;
    return false;
  }
  if (immediate == lekh::tsf::ContextPrivacy::Safe) {
    contextPrivacy_ = immediate;
  } else if (textEditSinkCookie_ == TF_INVALID_COOKIE) {
    // Without selection/property invalidation, an older asynchronous Safe
    // result cannot be trusted for the field currently under the caret.
    contextPrivacy_ = lekh::tsf::ContextPrivacy::Unknown;
    return false;
  }
  if (contextPrivacy_ != lekh::tsf::ContextPrivacy::Safe) {
    if (contextPrivacy_ == lekh::tsf::ContextPrivacy::Sensitive) contextSuppressed_ = true;
    return false;
  }

  if (!compositionState_) replaceCompositionState();
  if (!compositionState_) return false;
  if (failOpenPending_ || lekh::tsf::compositionStateIsFailOpen(compositionState_)) return true;
  if (session_.sessionId.empty()) preferences_ = lekh::tsf::readWindowsPreferences();
  if (!session_.sessionId.empty()) return true;
  return beginDaemonSession();
}

bool LekhTextService::negotiateDaemon() {
  if (!serverInstanceId_.empty()) return true;
  const lekh::tsf::RequestMetadata request = nextRequestMetadata(L"negotiate", kLekhHotPathTimeoutMs);
  const std::optional<std::wstring> response = ipc_.request(
    lekh::tsf::makeProtocolNegotiationRequest(request),
    kLekhHotPathTimeoutMs
  );
  if (!response) return false;
  const std::optional<lekh::tsf::NegotiatedProtocol> negotiated =
    lekh::tsf::parseProtocolNegotiationResponse(*response, request);
  if (!negotiated) return false;
  serverInstanceId_ = negotiated->serverInstanceId;
  return true;
}

bool LekhTextService::beginDaemonSession() {
  if (!session_.sessionId.empty()) return true;
  if (!negotiateDaemon()) return false;
  const lekh::tsf::RequestMetadata request = nextRequestMetadata(L"begin", kLekhHotPathTimeoutMs);
  const lekh::tsf::BeginSessionOptions options{
    lekh::tsf::nativeTypingModeName(preferences_.mode),
    preferences_.proofreadAsYouTypeEnabled,
    (activationFlags_ & TF_TMF_IMMERSIVEMODE) == 0 &&
      lekh::tsf::personalizationAllowedForForegroundApplication(preferences_),
    preferences_.nextWordPredictionEnabled
  };
  const std::optional<std::wstring> response = ipc_.request(
    lekh::tsf::makeBeginSessionRequest(request, options),
    kLekhHotPathTimeoutMs
  );
  if (!response) {
    serverInstanceId_.clear();
    return false;
  }
  const std::optional<lekh::tsf::SessionHandle> session =
    lekh::tsf::parseBeginSessionResponse(*response, request, serverInstanceId_);
  if (!session) {
    serverInstanceId_.clear();
    return false;
  }
  session_ = *session;
  sessionPersonalizationEnabled_ = options.personalizationEnabled;
  return true;
}

bool LekhTextService::processKey(ITfContext* context, WPARAM wParam, LPARAM lParam) {
  if (context != activeContext_ || !compositionState_) return false;

  // A host may terminate a composition independently (selection change, undo,
  // document replacement). Never send a new key against stale daemon text.
  if (!rawComposition_.empty() &&
      !lekh::tsf::compositionStateIsActive(compositionState_) &&
      !lekh::tsf::compositionStateIsFailOpen(compositionState_) &&
      !lekh::tsf::compositionStateHasPendingOperations(compositionState_)) {
    rawComposition_.clear();
    resetCandidateUi();
    abandonDaemonSession();
    replaceCompositionState();
    if (!compositionState_ || !beginDaemonSession()) return false;
  }

  const bool acceptGhostWithSpace = activeGhostVisible_ && wParam == VK_SPACE && GetKeyState(VK_SHIFT) >= 0;
  const lekh::tsf::KeyEvent event = makeKeyEvent(wParam, lParam);
  activeGhostVisible_ = false;

  if (failOpenPending_ || lekh::tsf::compositionStateIsFailOpen(compositionState_)) {
    return queueFailOpenText(context, failOpenTextAfterKey(rawComposition_, event));
  }

  if (session_.sessionId.empty() || serverInstanceId_.empty()) return false;
  if (candidateState_.visible()) {
    const std::optional<lekh::tsf::CandidateCommand> command = candidateCommand(wParam);
    if (command) {
      const lekh::tsf::CandidateInteraction interaction = candidateState_.handle(*command);
      if (interaction.type == lekh::tsf::CandidateInteractionType::SelectionChanged) {
        if (!candidateWindow_.show(candidateState_.candidates(), candidateState_.selectedIndex())) {
          candidateState_.reset();
        }
        return true;
      }
      if (interaction.type == lekh::tsf::CandidateInteractionType::CommitRequested && interaction.candidate) {
        return commitCandidate(
          context,
          *interaction.candidate,
          failOpenTextAfterKey(rawComposition_, event)
        );
      }
      return false;
    }
  }

  lekh::tsf::KeyEvent engineEvent = event;
  if (acceptGhostWithSpace && !candidateState_.visible()) {
    engineEvent.key = L"Tab";
    engineEvent.code = L"Tab";
  }
  const lekh::tsf::RequestMetadata request = nextRequestMetadata(L"key", kLekhHotPathTimeoutMs);
  const std::optional<std::wstring> response = ipc_.request(
    lekh::tsf::makeProcessKeyRequest(request, session_, engineEvent),
    kLekhHotPathTimeoutMs
  );
  if (!response) {
    return queueFailOpenText(context, failOpenTextAfterKey(rawComposition_, event));
  }

  std::optional<lekh::tsf::EngineDecision> decision = lekh::tsf::parseProcessKeyResponse(
    *response,
    request,
    serverInstanceId_,
    session_
  );
  if (!decision || decision->action == lekh::tsf::EngineAction::PassThrough) {
    if (rawComposition_.empty() && !lekh::tsf::compositionStateIsActive(compositionState_)) {
      abandonDaemonSession();
      return false;
    }
    return queueFailOpenText(context, failOpenTextAfterKey(rawComposition_, event));
  }
  if (acceptGhostWithSpace && decision->action == lekh::tsf::EngineAction::Commit) {
    decision->committedText.push_back(L' ');
  }

  return applyDecision(
    context,
    *decision,
    failOpenTextForDecision(rawComposition_, event, *decision)
  );
}

void LekhTextService::scheduleCommittedCandidateLearning(std::uint64_t commitEpoch) {
  if (commitEpoch == 0 || session_.sessionId.empty() || serverInstanceId_.empty()) return;
  // Completion callbacks run after the edit session releases the host lock.
  // Learning remains ordered on the same protocol client and is never sent
  // before the corresponding host commit succeeds.
  const lekh::tsf::RequestMetadata request = nextRequestMetadata(L"learn", kLekhHotPathTimeoutMs);
  const std::optional<std::wstring> response = ipc_.request(
    lekh::tsf::makeMemoryLearnRequest(request, session_, commitEpoch),
    kLekhHotPathTimeoutMs
  );
  if (response) {
    lekh::tsf::parseMemoryLearnResponse(*response, request, serverInstanceId_, session_);
  }
}

bool LekhTextService::commitCandidate(
  ITfContext* context,
  const lekh::tsf::Candidate& candidate,
  const std::wstring& failOpenText
) {
  if (candidate.id.empty() || session_.sessionId.empty() || serverInstanceId_.empty() || context != activeContext_) {
    return false;
  }
  const lekh::tsf::RequestMetadata request = nextRequestMetadata(L"candidate", kLekhHotPathTimeoutMs);
  const std::optional<std::wstring> response = ipc_.request(
    lekh::tsf::makeCommitCandidateRequest(request, session_, candidate.id),
    kLekhHotPathTimeoutMs
  );
  if (!response) return queueFailOpenText(context, failOpenText);

  std::optional<lekh::tsf::EngineDecision> decision = lekh::tsf::parseCommitCandidateResponse(
    *response,
    request,
    serverInstanceId_,
    session_
  );
  if (!decision || decision->action == lekh::tsf::EngineAction::PassThrough) {
    return queueFailOpenText(context, failOpenText);
  }
  if (decision->action == lekh::tsf::EngineAction::Compose) {
    decision->compositionText = candidate.text;
    decision->displayText = candidate.text;
    decision->caret = candidate.text.size();
  }
  return applyDecision(context, *decision, failOpenText);
}

bool LekhTextService::applyDecision(
  ITfContext* context,
  const lekh::tsf::EngineDecision& decision,
  const std::wstring& failOpenText
) {
  if (!context || context != activeContext_ || !compositionState_ ||
      decision.action == lekh::tsf::EngineAction::PassThrough) {
    return false;
  }

  lekh::tsf::EngineDecision visibleDecision = decision;
  const bool previousGhostVisible = activeGhostVisible_;
  if (visibleDecision.action == lekh::tsf::EngineAction::Compose) {
    // Keep exactly what the user typed as the solid, host-owned composition.
    // The proposed conversion is a visually distinct, non-authoritative tail.
    visibleDecision.displayText = visibleDecision.compositionText;
    visibleDecision.caret = visibleDecision.displayText.size();
    const bool validGhost = preferences_.inlinePreviewEnabled &&
      ghostDisplayAttribute_ != TF_INVALID_GUIDATOM &&
      !visibleDecision.inlineCompletionText.empty() &&
      !visibleDecision.inlineCompletionDisplayText.empty();
    if (!validGhost) {
      visibleDecision.inlineCompletionText.clear();
      visibleDecision.inlineCompletionDisplayText.clear();
    }
    activeGhostVisible_ = validGhost;
  } else {
    activeGhostVisible_ = false;
  }

  const std::wstring previousRaw = rawComposition_;
  const std::wstring previousPresented = lastPresentedText_;
  rawComposition_ = visibleDecision.action == lekh::tsf::EngineAction::Compose
    ? visibleDecision.compositionText
    : L"";
  lastPresentedText_ = visibleDecision.action == lekh::tsf::EngineAction::Compose
    ? visibleDecision.displayText
    : L"";

  const lekh::tsf::EditSessionCallback callback{
    static_cast<IUnknown*>(static_cast<ITfTextInputProcessorEx*>(this)),
    this,
    &LekhTextService::editSessionCompleted
  };
  lekh::tsf::EditSubmissionResult submission = lekh::tsf::submitEngineDecision(
    context,
    clientId_,
    compositionState_,
    visibleDecision,
    failOpenText,
    contextGeneration_,
    callback,
    compositionDisplayAttribute_,
    ghostDisplayAttribute_
  );

  if (submission.status == lekh::tsf::EditSubmissionStatus::Rejected) {
    rawComposition_ = previousRaw;
    lastPresentedText_ = previousPresented;
    activeGhostVisible_ = previousGhostVisible;
    abandonDaemonSession();
    return false;
  }
  if (submission.status == lekh::tsf::EditSubmissionStatus::Completed) {
    handleEditSessionCompleted(submission.outcome);
    return submission.outcome.consumed;
  }
  return true;
}

bool LekhTextService::queueFailOpenText(ITfContext* context, const std::wstring& failOpenText) {
  if (!context || context != activeContext_ || !compositionState_) return false;
  const std::wstring previousRaw = rawComposition_;
  rawComposition_ = failOpenText;
  failOpenPending_ = true;

  const lekh::tsf::EditSessionCallback callback{
    static_cast<IUnknown*>(static_cast<ITfTextInputProcessorEx*>(this)),
    this,
    &LekhTextService::editSessionCompleted
  };
  lekh::tsf::EditSubmissionResult submission = lekh::tsf::submitFailOpenText(
    context,
    clientId_,
    compositionState_,
    failOpenText,
    contextGeneration_,
    callback
  );
  if (submission.status == lekh::tsf::EditSubmissionStatus::Rejected) {
    rawComposition_ = previousRaw;
    failOpenPending_ = lekh::tsf::compositionStateIsFailOpen(compositionState_);
    abandonDaemonSession();
    return false;
  }

  // No future key may be sent to a daemon session whose state diverged from
  // the literal fallback range. Already-queued host edits remain state-owned.
  abandonDaemonSession();
  if (submission.status == lekh::tsf::EditSubmissionStatus::Completed) {
    handleEditSessionCompleted(submission.outcome);
    return submission.outcome.consumed;
  }
  return true;
}

void __stdcall LekhTextService::privacyInspectionCompleted(
  void* context,
  const lekh::tsf::PrivacyInspectionOutcome& outcome
) {
  if (!context) return;
  auto* service = static_cast<LekhTextService*>(context);
  struct DeferredPrivacy {
    LekhTextService* service = nullptr;
    lekh::tsf::PrivacyInspectionOutcome outcome;
  };
  auto* deferred = new (std::nothrow) DeferredPrivacy{service, outcome};
  if (!deferred) {
    service->privacyInspectionPending_ = false;
    service->contextSuppressed_ = true;
    return;
  }
  if (deferred->outcome.context) deferred->outcome.context->AddRef();
  service->AddRef();
  const bool posted = service->candidateWindow_.post([deferred]() {
    deferred->service->handlePrivacyInspectionCompleted(deferred->outcome);
    if (deferred->outcome.context) deferred->outcome.context->Release();
    deferred->service->Release();
    delete deferred;
  });
  if (!posted) {
    service->privacyInspectionPending_ = false;
    service->contextSuppressed_ = true;
    if (deferred->outcome.context) deferred->outcome.context->Release();
    service->Release();
    delete deferred;
  }
}

void LekhTextService::handlePrivacyInspectionCompleted(
  const lekh::tsf::PrivacyInspectionOutcome& outcome
) {
  if (outcome.contextGeneration != contextGeneration_ || outcome.context != activeContext_) return;
  privacyInspectionPending_ = false;
  if (!outcome.editSessionRan || FAILED(outcome.operationResult)) return;
  contextPrivacy_ = outcome.privacy;
  if (contextPrivacy_ != lekh::tsf::ContextPrivacy::Safe) {
    contextSuppressed_ = true;
    closeActiveContext(true);
  }
}

void __stdcall LekhTextService::editSessionCompleted(
  void* context,
  const lekh::tsf::EditSessionOutcome& outcome
) {
  if (!context) return;
  auto* service = static_cast<LekhTextService*>(context);

  struct DeferredCompletion {
    LekhTextService* service = nullptr;
    lekh::tsf::EditSessionOutcome outcome;
  };

  auto* deferred = new (std::nothrow) DeferredCompletion{service, outcome};
  if (!deferred) {
    // Do not run completion work while the host may still hold its document
    // lock. Stop intercepting this context rather than risking re-entrancy.
    service->contextSuppressed_ = true;
    return;
  }

  if (deferred->outcome.context) deferred->outcome.context->AddRef();
  lekh::tsf::addRefCompositionState(deferred->outcome.state);
  service->AddRef();

  const bool posted = service->candidateWindow_.post([deferred]() {
    deferred->service->handleEditSessionCompleted(deferred->outcome);
    if (deferred->outcome.context) deferred->outcome.context->Release();
    lekh::tsf::releaseCompositionState(&deferred->outcome.state);
    deferred->service->Release();
    delete deferred;
  });
  if (!posted) {
    service->contextSuppressed_ = true;
    if (deferred->outcome.context) deferred->outcome.context->Release();
    lekh::tsf::releaseCompositionState(&deferred->outcome.state);
    service->Release();
    delete deferred;
  }
}

void LekhTextService::handleEditSessionCompleted(const lekh::tsf::EditSessionOutcome& outcome) {
  if (outcome.contextGeneration != contextGeneration_ || outcome.context != activeContext_ ||
      outcome.state != compositionState_) {
    return;
  }

  if (outcome.privacyBlocked) {
    contextPrivacy_ = lekh::tsf::ContextPrivacy::Unknown;
    contextSuppressed_ = true;
    rawComposition_.clear();
    failOpenPending_ = false;
    resetCandidateUi();
    abandonDaemonSession();
    lekh::tsf::cancelCompositionStatePendingEdits(compositionState_);
    return;
  }

  if (!outcome.consumed) {
    // An accepted asynchronous session that cannot perform either the desired
    // edit or its literal fallback must not trigger a duplicate host key. Stop
    // intercepting this context until focus changes.
    contextSuppressed_ = true;
    rawComposition_.clear();
    failOpenPending_ = false;
    resetCandidateUi();
    abandonDaemonSession();
    return;
  }

  if (outcome.fallbackApplied || outcome.failOpen) {
    resetCandidateUi();
    abandonDaemonSession();
    if (!lekh::tsf::compositionStateHasPendingOperations(compositionState_)) {
      rawComposition_.clear();
      failOpenPending_ = false;
      replaceCompositionState();
    } else {
      // rawComposition_ already holds the newest submitted snapshot. An older
      // completion must never roll burst typing back to its own stale text.
      failOpenPending_ = true;
    }
    return;
  }

  if (!outcome.desiredApplied) {
    // Text changed but a later ownership/cleanup step failed. The key is
    // already represented in the host, so suppress rather than duplicate it.
    contextSuppressed_ = true;
    resetCandidateUi();
    abandonDaemonSession();
    return;
  }

  if (outcome.decision.commitEpoch > 0 && sessionPersonalizationEnabled_) {
    scheduleCommittedCandidateLearning(outcome.decision.commitEpoch);
  }
  if (lekh::tsf::compositionStateHasPendingOperations(compositionState_)) return;

  activeGhostVisible_ = outcome.decision.action == lekh::tsf::EngineAction::Compose &&
    !outcome.decision.inlineCompletionText.empty() &&
    !outcome.decision.inlineCompletionDisplayText.empty();

  updateCandidateUi(
    outcome.decision,
    outcome.hasTextExtent ? &outcome.textExtent : nullptr,
    outcome.candidateOwnerWindow
  );
}

void LekhTextService::updateCandidateUi(
  const lekh::tsf::EngineDecision& decision,
  const RECT* textExtent,
  HWND ownerWindow
) {
  if (!preferences_.customCandidatePanelEnabled ||
      (activationFlags_ & TF_TMAE_UIELEMENTENABLEDONLY) != 0) {
    resetCandidateUi();
    return;
  }
  const bool show = decision.action == lekh::tsf::EngineAction::Compose && decision.shouldShowCandidateUi;
  candidateState_.update(decision.candidates, show);
  if (!candidateState_.visible()) {
    candidateWindow_.hide();
    return;
  }
  if (!candidateWindow_.show(
    candidateState_.candidates(),
    candidateState_.selectedIndex(),
    textExtent,
    ownerWindow
  )) {
    candidateState_.reset();
  }
}

void LekhTextService::resetCandidateUi() {
  candidateWindow_.hide();
  candidateState_.reset();
}

void LekhTextService::endDaemonSession() {
  activeGhostVisible_ = false;
  resetCandidateUi();
  if (session_.sessionId.empty()) return;
  const lekh::tsf::SessionHandle endingSession = session_;
  session_ = {};
  sessionPersonalizationEnabled_ = false;
  if (serverInstanceId_.empty()) return;
  const lekh::tsf::RequestMetadata request = nextRequestMetadata(L"end", kLekhHotPathTimeoutMs);
  const std::optional<std::wstring> response = ipc_.request(
    lekh::tsf::makeSessionRequest(request, endingSession, lekh::tsf::SessionCommand::End),
    kLekhHotPathTimeoutMs
  );
  if (!response || !lekh::tsf::parseSessionResponse(
    *response,
    request,
    serverInstanceId_,
    endingSession,
    lekh::tsf::SessionCommand::End
  )) {
    serverInstanceId_.clear();
  }
}

void LekhTextService::abandonDaemonSession() {
  activeGhostVisible_ = false;
  resetCandidateUi();
  if (session_.sessionId.empty()) return;
  if (!serverInstanceId_.empty()) {
    const lekh::tsf::RequestMetadata request = nextRequestMetadata(L"cancel", kLekhHotPathTimeoutMs);
    ipc_.request(
      lekh::tsf::makeSessionRequest(request, session_, lekh::tsf::SessionCommand::Cancel),
      kLekhHotPathTimeoutMs
    );
  }
  endDaemonSession();
}

void LekhTextService::closeActiveContext(bool finishComposition) {
  resetCandidateUi();
  if (compositionState_) {
    lekh::tsf::cancelCompositionStatePendingEdits(compositionState_);
  }
  if (finishComposition && activeContext_ && compositionState_ &&
      lekh::tsf::compositionStateIsActive(compositionState_) && clientId_ != TF_CLIENTID_NULL) {
    const lekh::tsf::EditSubmissionResult finish = lekh::tsf::submitFinishComposition(
      activeContext_,
      clientId_,
      compositionState_,
      contextGeneration_,
      lastPresentedText_
    );
    if (finish.status == lekh::tsf::EditSubmissionStatus::Rejected) {
      lekh::tsf::abandonCompositionState(compositionState_);
    }
  }
  endDaemonSession();
  unadviseContextSink();
  if (activeContext_) {
    activeContext_->Release();
    activeContext_ = nullptr;
  }
  rawComposition_.clear();
  lastPresentedText_.clear();
  failOpenPending_ = false;
  privacyInspectionPending_ = false;
  contextPrivacy_ = lekh::tsf::ContextPrivacy::Unknown;
  ++contextGeneration_;
  replaceCompositionState();
}

void LekhTextService::replaceCompositionState() {
  lekh::tsf::releaseCompositionState(&compositionState_);
  compositionState_ = lekh::tsf::createCompositionState();
}

HRESULT LekhTextService::adviseContextSink(ITfContext* context) {
  unadviseContextSink();
  if (!context) return E_INVALIDARG;
  ITfSource* source = nullptr;
  HRESULT hr = context->QueryInterface(IID_ITfSource, reinterpret_cast<void**>(&source));
  if (FAILED(hr) || !source) return FAILED(hr) ? hr : E_NOINTERFACE;
  hr = source->AdviseSink(
    IID_ITfTextEditSink,
    static_cast<ITfTextEditSink*>(this),
    &textEditSinkCookie_
  );
  source->Release();
  if (FAILED(hr)) textEditSinkCookie_ = TF_INVALID_COOKIE;
  return hr;
}

void LekhTextService::unadviseContextSink() {
  if (!activeContext_ || textEditSinkCookie_ == TF_INVALID_COOKIE) {
    textEditSinkCookie_ = TF_INVALID_COOKIE;
    return;
  }
  ITfSource* source = nullptr;
  if (SUCCEEDED(activeContext_->QueryInterface(IID_ITfSource, reinterpret_cast<void**>(&source))) && source) {
    source->UnadviseSink(textEditSinkCookie_);
    source->Release();
  }
  textEditSinkCookie_ = TF_INVALID_COOKIE;
}

lekh::tsf::RequestMetadata LekhTextService::nextRequestMetadata(const wchar_t* operation, DWORD timeoutMs) {
  const std::uint64_t sentAt = unixEpochMilliseconds();
  const auto sequence = static_cast<std::uint64_t>(InterlockedIncrement64(&requestSequence_));
  return {
    clientInstanceId_ + L"_" + operation + L"_" + std::to_wstring(sequence),
    clientInstanceId_,
    sequence,
    sentAt,
    sentAt + timeoutMs
  };
}

HRESULT LekhTextService::adviseSinks() {
  if (!threadMgr_ || clientId_ == TF_CLIENTID_NULL) return E_FAIL;

  ITfKeystrokeMgr* keystrokeManager = nullptr;
  HRESULT hr = threadMgr_->QueryInterface(IID_ITfKeystrokeMgr, reinterpret_cast<void**>(&keystrokeManager));
  if (FAILED(hr) || !keystrokeManager) return FAILED(hr) ? hr : E_NOINTERFACE;
  hr = keystrokeManager->AdviseKeyEventSink(clientId_, static_cast<ITfKeyEventSink*>(this), TRUE);
  if (SUCCEEDED(hr)) {
    keyEventSinkAdvised_ = true;
    hr = preserveModeKeys(keystrokeManager);
  }
  keystrokeManager->Release();
  if (FAILED(hr)) {
    unadviseSinks();
    return hr;
  }

  ITfSource* source = nullptr;
  hr = threadMgr_->QueryInterface(IID_ITfSource, reinterpret_cast<void**>(&source));
  if (FAILED(hr) || !source) {
    unadviseSinks();
    return FAILED(hr) ? hr : E_NOINTERFACE;
  }
  hr = source->AdviseSink(
    IID_ITfThreadMgrEventSink,
    static_cast<ITfThreadMgrEventSink*>(this),
    &threadMgrEventSinkCookie_
  );
  source->Release();
  if (FAILED(hr)) unadviseSinks();
  return hr;
}

HRESULT LekhTextService::preserveModeKeys(ITfKeystrokeMgr* keystrokeManager) {
  if (!keystrokeManager || clientId_ == TF_CLIENTID_NULL) return E_INVALIDARG;
  const TF_PRESERVEDKEY cycle{VK_SPACE, TF_MOD_CONTROL | TF_MOD_ALT};
  const TF_PRESERVEDKEY romanizedTraditional{L'1', TF_MOD_CONTROL | TF_MOD_ALT};
  const TF_PRESERVEDKEY romanizedRomanized{L'2', TF_MOD_CONTROL | TF_MOD_ALT};
  static constexpr wchar_t cycleDescription[] = L"Cycle Lekh typing mode";
  static constexpr wchar_t nepaliDescription[] = L"Lekh English keys to Nepali";
  static constexpr wchar_t romanDescription[] = L"Lekh Roman text";
  HRESULT hr = keystrokeManager->PreserveKey(
    clientId_, GUID_LekhCycleTypingMode, &cycle, cycleDescription, ARRAYSIZE(cycleDescription) - 1
  );
  if (SUCCEEDED(hr)) {
    hr = keystrokeManager->PreserveKey(
      clientId_, GUID_LekhRomanizedTraditionalMode, &romanizedTraditional,
      nepaliDescription, ARRAYSIZE(nepaliDescription) - 1
    );
  }
  if (SUCCEEDED(hr)) {
    hr = keystrokeManager->PreserveKey(
      clientId_, GUID_LekhRomanizedRomanizedMode, &romanizedRomanized,
      romanDescription, ARRAYSIZE(romanDescription) - 1
    );
  }
  if (FAILED(hr)) {
    keystrokeManager->UnpreserveKey(GUID_LekhCycleTypingMode, &cycle);
    keystrokeManager->UnpreserveKey(GUID_LekhRomanizedTraditionalMode, &romanizedTraditional);
    keystrokeManager->UnpreserveKey(GUID_LekhRomanizedRomanizedMode, &romanizedRomanized);
    return hr;
  }
  modeKeysPreserved_ = true;
  return S_OK;
}

void LekhTextService::unpreserveModeKeys(ITfKeystrokeMgr* keystrokeManager) {
  if (!keystrokeManager || !modeKeysPreserved_) return;
  const TF_PRESERVEDKEY cycle{VK_SPACE, TF_MOD_CONTROL | TF_MOD_ALT};
  const TF_PRESERVEDKEY romanizedTraditional{L'1', TF_MOD_CONTROL | TF_MOD_ALT};
  const TF_PRESERVEDKEY romanizedRomanized{L'2', TF_MOD_CONTROL | TF_MOD_ALT};
  keystrokeManager->UnpreserveKey(GUID_LekhCycleTypingMode, &cycle);
  keystrokeManager->UnpreserveKey(GUID_LekhRomanizedTraditionalMode, &romanizedTraditional);
  keystrokeManager->UnpreserveKey(GUID_LekhRomanizedRomanizedMode, &romanizedRomanized);
  modeKeysPreserved_ = false;
}

void LekhTextService::unadviseSinks() {
  if (!threadMgr_) return;
  if (threadMgrEventSinkCookie_ != TF_INVALID_COOKIE) {
    ITfSource* source = nullptr;
    if (SUCCEEDED(threadMgr_->QueryInterface(IID_ITfSource, reinterpret_cast<void**>(&source))) && source) {
      source->UnadviseSink(threadMgrEventSinkCookie_);
      source->Release();
    }
    threadMgrEventSinkCookie_ = TF_INVALID_COOKIE;
  }
  if (keyEventSinkAdvised_ && clientId_ != TF_CLIENTID_NULL) {
    ITfKeystrokeMgr* keystrokeManager = nullptr;
    if (SUCCEEDED(threadMgr_->QueryInterface(IID_ITfKeystrokeMgr, reinterpret_cast<void**>(&keystrokeManager))) && keystrokeManager) {
      unpreserveModeKeys(keystrokeManager);
      keystrokeManager->UnadviseKeyEventSink(clientId_);
      keystrokeManager->Release();
    }
    keyEventSinkAdvised_ = false;
  }
}
