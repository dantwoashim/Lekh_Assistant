#include "LekhTextService.h"

#include "DaemonRetirement.h"
#include "Guids.h"

#include <algorithm>
#include <cwchar>
#include <iterator>
#include <memory>
#include <new>
#include <string>

extern long g_objectCount;
extern long g_pendingDaemonRetirements;
extern HMODULE g_module;

namespace {
constexpr UINT kRetirementCompletedMessage = WM_APP + 0x32A;
constexpr wchar_t kRetirementCompletionWindowClassPrefix[] = L"LekhTsfRetirementCompletionWindow-";
volatile LONGLONG g_nextCompletionToken = 0;

std::wstring logicalKey(WPARAM wParam, LPARAM lParam) {
  switch (wParam) {
    case VK_SPACE: return L" ";
    case VK_BACK: return L"Backspace";
    case VK_RETURN: return L"Enter";
    case VK_ESCAPE: return L"Escape";
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

std::wstring physicalKeyCode(WPARAM wParam, LPARAM lParam) {
  const unsigned long scanCode = static_cast<unsigned long>((lParam >> 16) & 0xff);
  switch (scanCode) {
    case 0x1e: return L"KeyA";
    case 0x30: return L"KeyB";
    case 0x2e: return L"KeyC";
    case 0x20: return L"KeyD";
    case 0x12: return L"KeyE";
    case 0x21: return L"KeyF";
    case 0x22: return L"KeyG";
    case 0x23: return L"KeyH";
    case 0x17: return L"KeyI";
    case 0x24: return L"KeyJ";
    case 0x25: return L"KeyK";
    case 0x26: return L"KeyL";
    case 0x32: return L"KeyM";
    case 0x31: return L"KeyN";
    case 0x18: return L"KeyO";
    case 0x19: return L"KeyP";
    case 0x10: return L"KeyQ";
    case 0x13: return L"KeyR";
    case 0x1f: return L"KeyS";
    case 0x14: return L"KeyT";
    case 0x16: return L"KeyU";
    case 0x2f: return L"KeyV";
    case 0x11: return L"KeyW";
    case 0x2d: return L"KeyX";
    case 0x15: return L"KeyY";
    case 0x2c: return L"KeyZ";
    default: break;
  }
  // Synthetic or incomplete events can omit the scan code. Retain a bounded
  // logical fallback rather than fabricating a physical location.
  if (scanCode == 0 && wParam >= L'A' && wParam <= L'Z') {
    return L"Key" + std::wstring(1, static_cast<wchar_t>(wParam));
  }
  switch (wParam) {
    case VK_SPACE: return L"Space";
    case VK_BACK: return L"Backspace";
    case VK_RETURN: return L"Enter";
    case VK_ESCAPE: return L"Escape";
    default: {
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

struct DaemonRetirementWork {
  HMODULE module = nullptr;
  std::shared_ptr<lekh::tsf::DaemonRetirementTracker> tracker;
  std::shared_ptr<std::atomic_uint64_t> requestSequenceLane;
  std::wstring clientInstanceId;
  std::uint64_t requestSequence = 0;
  std::wstring serverInstanceId;
  lekh::tsf::SessionHandle session;
  lekh::tsf::SessionCommand command = lekh::tsf::SessionCommand::End;
  bool purgeOnly = false;
  std::shared_ptr<LekhRetirementCompletionTarget> completionTarget;
};

bool deliverClientPurge(LekhIpcClient& ipc, const DaemonRetirementWork& work) {
  const std::uint64_t sequence = work.requestSequenceLane->fetch_add(1, std::memory_order_relaxed) + 1;
  const std::uint64_t sentAt = unixEpochMilliseconds();
  const lekh::tsf::RequestMetadata request = {
    work.clientInstanceId + L"_purge_" + std::to_wstring(sequence),
    work.clientInstanceId,
    sequence,
    sentAt,
    sentAt + lekh::tsf::kRetirementLogicalDeadlineMilliseconds
  };
  const std::wstring serializedRequest = lekh::tsf::makeProtocolNegotiationRequest(request);
  return lekh::tsf::deliverDaemonRetirement(
    [&](std::uint32_t timeoutMs) {
      const std::optional<std::wstring> response = ipc.request(serializedRequest, timeoutMs);
      return response && lekh::tsf::parseProtocolNegotiationResponse(*response, request).has_value();
    },
    [](std::size_t retryIndex) {
      const DWORD delays[] = {10, 25};
      Sleep(delays[std::min(retryIndex, std::size(delays) - 1)]);
    }
  );
}

bool deliverExactRetirement(LekhIpcClient& ipc, const DaemonRetirementWork& work) {
  const std::uint64_t sentAt = unixEpochMilliseconds();
  const wchar_t* operation = work.command == lekh::tsf::SessionCommand::Cancel ? L"cancel" : L"end";
  const lekh::tsf::RequestMetadata request = {
    work.clientInstanceId + L"_" + operation + L"_" + std::to_wstring(work.requestSequence),
    work.clientInstanceId,
    work.requestSequence,
    sentAt,
    sentAt + lekh::tsf::kRetirementLogicalDeadlineMilliseconds
  };
  const std::wstring serializedRequest =
    lekh::tsf::makeSessionRequest(request, work.session, work.command);
  return lekh::tsf::deliverDaemonRetirement(
    [&](std::uint32_t timeoutMs) {
      const std::optional<std::wstring> response = ipc.request(serializedRequest, timeoutMs);
      return response && lekh::tsf::parseSessionResponse(
        *response,
        request,
        work.serverInstanceId,
        work.session,
        work.command
      );
    },
    [](std::size_t retryIndex) {
      const DWORD delays[] = {10, 25};
      Sleep(delays[std::min(retryIndex, std::size(delays) - 1)]);
    }
  );
}

DWORD WINAPI deliverDaemonRetirement(LPVOID parameter) {
  std::unique_ptr<DaemonRetirementWork> work(static_cast<DaemonRetirementWork*>(parameter));
  try {
    LekhIpcClient ipc;
    if (work->purgeOnly) {
      work->tracker->finishPurge(deliverClientPurge(ipc, *work));
    } else {
      const bool acknowledged = deliverExactRetirement(ipc, *work);
      work->tracker->finishRetirement(acknowledged);
      if (!acknowledged) {
        // A successful same-client negotiation is an acknowledged atomic purge:
        // daemon protocol state retires every session owned by this client before
        // publishing the negotiation response.
        work->tracker->finishPurge(deliverClientPurge(ipc, *work));
      }
    }
  } catch (...) {
    // No allocation/transport exception may strand the request lane or leak
    // module lifetime. Fail closed into durable quarantine.
    if (!work->purgeOnly) work->tracker->finishRetirement(false);
    work->tracker->finishPurge(false);
  }
  if (!work->tracker->blocksNewSessions() && work->completionTarget) {
    std::lock_guard<std::mutex> lock(work->completionTarget->mutex);
    if (work->completionTarget->window && work->completionTarget->token != 0) {
      PostMessageW(
        work->completionTarget->window,
        kRetirementCompletedMessage,
        static_cast<WPARAM>(work->completionTarget->token),
        0
      );
    }
  }
  HMODULE module = work->module;
  work.reset();
  InterlockedDecrement(&g_pendingDaemonRetirements);
  FreeLibraryAndExitThread(module, 0);
}

bool queueDaemonRetirement(DaemonRetirementWork* work) {
  if (!work) return false;
  const LONG pending = InterlockedIncrement(&g_pendingDaemonRetirements);
  if (pending > lekh::tsf::kMaximumPendingRetirements) {
    InterlockedDecrement(&g_pendingDaemonRetirements);
    delete work;
    return false;
  }

  HMODULE module = nullptr;
  if (!GetModuleHandleExW(
      GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
      reinterpret_cast<LPCWSTR>(&g_pendingDaemonRetirements),
      &module
    )) {
    InterlockedDecrement(&g_pendingDaemonRetirements);
    delete work;
    return false;
  }
  work->module = module;
  HANDLE thread = CreateThread(nullptr, 0, deliverDaemonRetirement, work, 0, nullptr);
  if (!thread) {
    FreeLibrary(module);
    InterlockedDecrement(&g_pendingDaemonRetirements);
    delete work;
    return false;
  }
  CloseHandle(thread);
  return true;
}

bool sameComIdentity(IUnknown* left, IUnknown* right) {
  if (!left || !right) return false;
  IUnknown* leftIdentity = nullptr;
  IUnknown* rightIdentity = nullptr;
  const HRESULT leftResult = left->QueryInterface(IID_IUnknown, reinterpret_cast<void**>(&leftIdentity));
  const HRESULT rightResult = right->QueryInterface(IID_IUnknown, reinterpret_cast<void**>(&rightIdentity));
  const bool matches = SUCCEEDED(leftResult) && SUCCEEDED(rightResult) && leftIdentity == rightIdentity;
  if (leftIdentity) leftIdentity->Release();
  if (rightIdentity) rightIdentity->Release();
  return matches;
}

} // namespace

LekhTextService::LekhTextService() : clientInstanceId_(makeClientInstanceId()) {
  InterlockedIncrement(&g_objectCount);
}

LekhTextService::~LekhTextService() {
  destroyCompletionWindow();
  closeActiveContextForLifecycle(true);
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
  } else if (riid == IID_ITfCompositionSink) {
    *object = static_cast<ITfCompositionSink*>(this);
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
  if ((flags & TF_TMAE_SECUREMODE) != 0 && activeContext_) {
    abandonSensitiveSession();
  }
  closeActiveContextForLifecycle(true);
  unadviseSinks();
  destroyCompletionWindow();
  if (threadMgr_) threadMgr_->Release();
  threadMgr_ = threadMgr;
  threadMgr_->AddRef();
  clientId_ = clientId;
  activationFlags_ = flags;
  acceptsKeystrokes_ = true;
  contextSuppressed_ = false;
  if (!createCompletionWindow()) {
    clientId_ = TF_CLIENTID_NULL;
    activationFlags_ = 0;
    acceptsKeystrokes_ = false;
    threadMgr_->Release();
    threadMgr_ = nullptr;
    return E_FAIL;
  }
  const HRESULT hr = adviseSinks();
  if (SUCCEEDED(hr)) {
    prepareCurrentFocus();
  } else {
    unadviseSinks();
    destroyCompletionWindow();
    clientId_ = TF_CLIENTID_NULL;
    activationFlags_ = 0;
    acceptsKeystrokes_ = false;
    threadMgr_->Release();
    threadMgr_ = nullptr;
  }
  return hr;
}

STDMETHODIMP LekhTextService::Deactivate() {
  closeActiveContextForLifecycle(true);
  unadviseSinks();
  destroyCompletionWindow();
  clientId_ = TF_CLIENTID_NULL;
  activationFlags_ = 0;
  acceptsKeystrokes_ = false;
  if (threadMgr_) {
    threadMgr_->Release();
    threadMgr_ = nullptr;
  }
  return S_OK;
}

STDMETHODIMP LekhTextService::OnSetFocus(BOOL foreground) {
  acceptsKeystrokes_ = foreground != FALSE;
  if (!foreground) {
    closeActiveContextForLifecycle(true);
    contextSuppressed_ = false;
    return S_OK;
  }
  scheduleDaemonReconciliation();
  contextSuppressed_ = false;
  prepareCurrentFocus();
  return S_OK;
}

STDMETHODIMP LekhTextService::OnTestKeyDown(
  ITfContext* context,
  WPARAM wParam,
  LPARAM lParam,
  BOOL* eaten
) {
  if (!eaten) return E_POINTER;
  *eaten = FALSE;
  if (!acceptsKeystrokes_) return S_OK;
  const bool ownsContext = contextIsActive(context);
  if (activeComposition_ && ownsContext) {
    *eaten = TRUE;
    return S_OK;
  }
  if (!experimentalKeyEatingEnabled()) return S_OK;
  // Without an owned composition, unsupported keys never need Lekh state.
  // Keep them host-owned even while a prepared daemon session is available.
  *eaten = sessionStateReadyForContext(context) && shouldHandleKey(wParam, lParam)
    ? TRUE
    : FALSE;
  return S_OK;
}

STDMETHODIMP LekhTextService::OnKeyDown(ITfContext* context, WPARAM wParam, LPARAM lParam, BOOL* eaten) {
  if (!eaten) return E_POINTER;
  *eaten = FALSE;
  if (!acceptsKeystrokes_) return S_OK;
  const bool ownsContext = contextIsActive(context);
  if (activeComposition_ && ownsContext) {
    const bool sensitiveActivation = (activationFlags_ & TF_TMAE_SECUREMODE) != 0;
    const lekh::tsf::ContextPrivacy privacy = sensitiveActivation
      ? lekh::tsf::ContextPrivacy::Sensitive
      : lekh::tsf::inspectContextPrivacy(context, clientId_);
    if (privacy != lekh::tsf::ContextPrivacy::Safe) {
      abandonSensitiveSession();
      return S_OK;
    }
    if (!experimentalKeyEatingEnabled() || !sessionStateReadyForContext(context) ||
        !shouldHandleKey(wParam, lParam)) {
      *eaten = handleRejectedKey(makeKeyEvent(wParam, lParam)) ? TRUE : FALSE;
      return S_OK;
    }
    *eaten = processKey(context, wParam, lParam) ? TRUE : FALSE;
    return S_OK;
  }
  if (!experimentalKeyEatingEnabled()) {
    return S_OK;
  }
  if (!sessionReadyForContext(context)) {
    // A failed/sensitive preparation never grants Lekh ownership of this key.
    *eaten = FALSE;
    return S_OK;
  }
  if (!shouldHandleKey(wParam, lParam)) return S_OK;
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

STDMETHODIMP LekhTextService::OnPreservedKey(ITfContext*, REFGUID, BOOL* eaten) {
  if (!eaten) return E_POINTER;
  *eaten = FALSE;
  return S_OK;
}

STDMETHODIMP LekhTextService::OnCompositionTerminated(
  TfEditCookie,
  ITfComposition* composition
) {
  if (!composition || !activeComposition_ || !sameComIdentity(composition, activeComposition_)) return S_OK;

  const bool detachDaemonState =
    lekh::tsf::shouldDetachDaemonAfterTermination(terminationDisposition_);
  lekh::tsf::releaseActiveComposition(&activeComposition_);
  if (!detachDaemonState) return S_OK;

  // Compose callbacks materialize canonical raw text in the owned TSF range.
  // A host termination therefore needs no later overwrite or caret movement;
  // relinquish immediately and make every later key host-owned.
  clearDaemonBinding();
  contextSuppressed_ = true;
  return S_OK;
}

STDMETHODIMP LekhTextService::OnInitDocumentMgr(ITfDocumentMgr*) {
  return S_OK;
}

STDMETHODIMP LekhTextService::OnUninitDocumentMgr(ITfDocumentMgr* documentManager) {
  if (!documentManagerIsActive(documentManager)) return S_OK;
  closeActiveContextForLifecycle(true);
  contextSuppressed_ = false;
  return S_OK;
}

STDMETHODIMP LekhTextService::OnSetFocus(ITfDocumentMgr* focus, ITfDocumentMgr*) {
  // Thread-manager callbacks can be delivered for document stacks that are not
  // actually foreground. The manager's current focus and top context are the
  // authority; never let a background callback steal key ownership.
  if (!documentManagerIsCurrentFocus(focus)) return S_OK;
  ITfContext* focusedTop = nullptr;
  if (focus) focus->GetTop(&focusedTop);
  if (focusedTop && contextIsActive(focusedTop)) {
    prepareSafeContext(focusedTop, focus);
    focusedTop->Release();
    return S_OK;
  }
  if (focusedTop) focusedTop->Release();
  closeActiveContextForLifecycle(true);
  contextSuppressed_ = false;
  prepareFocusedDocument(focus);
  return S_OK;
}

STDMETHODIMP LekhTextService::OnPushContext(ITfContext* context) {
  if (!context || !threadMgr_) return S_OK;
  ITfDocumentMgr* focusedDocument = nullptr;
  if (FAILED(threadMgr_->GetFocus(&focusedDocument)) || !focusedDocument) return S_OK;
  ITfContext* focusedTop = nullptr;
  const HRESULT topResult = focusedDocument->GetTop(&focusedTop);
  if (FAILED(topResult) || !focusedTop || !sameComIdentity(context, focusedTop)) {
    if (focusedTop) focusedTop->Release();
    focusedDocument->Release();
    return S_OK;
  }
  if (!contextIsActive(focusedTop)) closeActiveContextForLifecycle(true);
  contextSuppressed_ = false;
  prepareSafeContext(focusedTop, focusedDocument);
  focusedTop->Release();
  focusedDocument->Release();
  return S_OK;
}

STDMETHODIMP LekhTextService::OnPopContext(ITfContext* context) {
  if (!contextIsActive(context)) return S_OK;
  // Once our exact active context is popped, it is invalid regardless of
  // focus-callback ordering. Retaining it would leave stale COM ownership.
  closeActiveContextForLifecycle(true);
  contextSuppressed_ = false;
  prepareCurrentFocus();
  return S_OK;
}

bool LekhTextService::shouldHandleKey(WPARAM wParam, LPARAM lParam) const {
  if (contextSuppressed_ || (activationFlags_ & TF_TMAE_SECUREMODE) != 0) return false;
  if (GetKeyState(VK_CONTROL) < 0 || GetKeyState(VK_MENU) < 0 ||
      GetKeyState(VK_LWIN) < 0 || GetKeyState(VK_RWIN) < 0) {
    return false;
  }
  if (isRomanizedLetter(logicalKey(wParam, lParam))) return true;
  if (!activeComposition_) return false;
  return wParam == VK_SPACE || wParam == VK_BACK || wParam == VK_RETURN || wParam == VK_ESCAPE;
}

bool LekhTextService::experimentalKeyEatingEnabled() const {
  wchar_t value[16] = {};
  const DWORD length = GetEnvironmentVariableW(
    L"LEKH_TSF_ENABLE_EXPERIMENTAL_KEY_EATING",
    value,
    static_cast<DWORD>(std::size(value))
  );
  if (length == 0 || length >= std::size(value)) return false;
  return wcscmp(value, L"1") == 0 || _wcsicmp(value, L"true") == 0 || _wcsicmp(value, L"yes") == 0;
}

bool LekhTextService::contextIsActive(ITfContext* context) const {
  return context && activeContext_ && sameComIdentity(context, activeContext_);
}

bool LekhTextService::documentManagerIsActive(ITfDocumentMgr* documentManager) const {
  if (!documentManager || !activeContext_) return false;
  if (activeDocumentManager_ && sameComIdentity(documentManager, activeDocumentManager_)) return true;
  ITfContext* top = nullptr;
  const bool matches = SUCCEEDED(documentManager->GetTop(&top)) && top && contextIsActive(top);
  if (top) top->Release();
  return matches;
}

bool LekhTextService::documentManagerIsCurrentFocus(ITfDocumentMgr* documentManager) const {
  if (!threadMgr_) return false;
  ITfDocumentMgr* focusedDocument = nullptr;
  const HRESULT result = threadMgr_->GetFocus(&focusedDocument);
  const bool matches = SUCCEEDED(result) && (
    documentManager
      ? focusedDocument && sameComIdentity(documentManager, focusedDocument)
      : !focusedDocument
  );
  if (focusedDocument) focusedDocument->Release();
  return matches;
}

bool LekhTextService::sessionStateReadyForContext(ITfContext* context) const {
  return acceptsKeystrokes_ && contextIsActive(context) && !contextSuppressed_ && clientId_ != TF_CLIENTID_NULL &&
    (activationFlags_ & TF_TMAE_SECUREMODE) == 0 && engineWarmed_ &&
    !retirementTracker_->blocksNewSessions() &&
    !serverInstanceId_.empty() && !session_.sessionId.empty();
}

bool LekhTextService::sessionReadyForContext(ITfContext* context) {
  if (!sessionStateReadyForContext(context)) return false;
  if (lekh::tsf::inspectContextPrivacy(context, clientId_) != lekh::tsf::ContextPrivacy::Safe) {
    abandonSensitiveSession();
    return false;
  }
  return true;
}

bool LekhTextService::prepareSafeContext(ITfContext* context, ITfDocumentMgr* documentManager) {
  if (!acceptsKeystrokes_ || !experimentalKeyEatingEnabled() || !context || !documentManager || clientId_ == TF_CLIENTID_NULL ||
      contextSuppressed_ ||
      (activationFlags_ & TF_TMAE_SECUREMODE) != 0) {
    return false;
  }
  if (!documentManagerIsCurrentFocus(documentManager)) return false;
  ITfContext* focusedTop = nullptr;
  const bool isFocusedTop = SUCCEEDED(documentManager->GetTop(&focusedTop)) && focusedTop &&
    sameComIdentity(context, focusedTop);
  if (focusedTop) focusedTop->Release();
  if (!isFocusedTop) return false;
  scheduleDaemonReconciliation();
  if (retirementTracker_->blocksNewSessions()) return false;

  const lekh::tsf::ContextPrivacy privacy = lekh::tsf::inspectContextPrivacy(context, clientId_);
  if (privacy != lekh::tsf::ContextPrivacy::Safe) {
    if (contextIsActive(context)) {
      abandonSensitiveSession();
    } else {
      closeActiveContextForLifecycle(true);
    }
    contextSuppressed_ = true;
    return false;
  }

  if (!contextIsActive(context)) {
    closeActiveContextForLifecycle(true);
    if (retirementTracker_->blocksNewSessions()) return false;
    activeContext_ = context;
    activeContext_->AddRef();
    activeDocumentManager_ = documentManager;
    activeDocumentManager_->AddRef();
    contextSuppressed_ = false;
  } else if (!activeDocumentManager_ || !sameComIdentity(activeDocumentManager_, documentManager)) {
    if (activeDocumentManager_) activeDocumentManager_->Release();
    activeDocumentManager_ = documentManager;
    activeDocumentManager_->AddRef();
  }
  return !session_.sessionId.empty() || beginDaemonSession();
}

void LekhTextService::prepareFocusedDocument(ITfDocumentMgr* documentManager) {
  if (!documentManager || !documentManagerIsCurrentFocus(documentManager)) return;
  ITfContext* context = nullptr;
  if (SUCCEEDED(documentManager->GetTop(&context)) && context) {
    prepareSafeContext(context, documentManager);
    context->Release();
  }
}

void LekhTextService::prepareCurrentFocus() {
  if (!acceptsKeystrokes_) return;
  scheduleDaemonReconciliation();
  if (retirementTracker_->blocksNewSessions()) return;
  if (!threadMgr_) return;
  ITfDocumentMgr* documentManager = nullptr;
  if (SUCCEEDED(threadMgr_->GetFocus(&documentManager)) && documentManager) {
    prepareFocusedDocument(documentManager);
    documentManager->Release();
  }
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
  engineWarmed_ = false;
  return true;
}

bool LekhTextService::warmDaemon() {
  if (engineWarmed_) return true;
  if (serverInstanceId_.empty()) return false;
  const lekh::tsf::RequestMetadata request = nextRequestMetadata(L"warm", kLekhHotPathTimeoutMs);
  const std::optional<std::wstring> response = ipc_.request(
    lekh::tsf::makeEngineWarmRequest(request),
    kLekhHotPathTimeoutMs
  );
  if (!response) return false;
  const std::optional<lekh::tsf::EngineWarmResult> result =
    lekh::tsf::parseEngineWarmResponse(*response, request, serverInstanceId_);
  engineWarmed_ = result && result->ready && !result->partial;
  return engineWarmed_;
}

bool LekhTextService::beginDaemonSession() {
  if (!session_.sessionId.empty()) return true;
  scheduleDaemonReconciliation();
  if (retirementTracker_->blocksNewSessions()) return false;
  if (!negotiateDaemon() || !warmDaemon()) {
    serverInstanceId_.clear();
    engineWarmed_ = false;
    return false;
  }
  const lekh::tsf::RequestMetadata request = nextRequestMetadata(L"begin", kLekhHotPathTimeoutMs);
  const std::optional<std::wstring> response = ipc_.request(
    lekh::tsf::makeBeginSessionRequest(request),
    kLekhHotPathTimeoutMs
  );
  if (!response) {
    serverInstanceId_.clear();
    engineWarmed_ = false;
    return false;
  }
  const std::optional<lekh::tsf::SessionHandle> session =
    lekh::tsf::parseBeginSessionResponse(*response, request, serverInstanceId_);
  if (!session) {
    serverInstanceId_.clear();
    engineWarmed_ = false;
    return false;
  }
  session_ = *session;
  compositionText_.clear();
  return true;
}

bool LekhTextService::processKey(ITfContext* context, WPARAM wParam, LPARAM lParam) {
  if (session_.sessionId.empty() || serverInstanceId_.empty() || !contextIsActive(context)) return false;
  const lekh::tsf::KeyEvent key = makeKeyEvent(wParam, lParam);
  if ((activeComposition_ == nullptr) != compositionText_.empty()) {
    return handleRejectedKey(key);
  }
  const lekh::tsf::RequestMetadata request = nextRequestMetadata(L"key", kLekhHotPathTimeoutMs);
  const std::optional<std::wstring> response = ipc_.request(
    lekh::tsf::makeProcessKeyRequest(
      request,
      session_,
      key
    ),
    kLekhHotPathTimeoutMs
  );
  if (!response) {
    return handleRejectedKey(key);
  }

  const std::optional<lekh::tsf::EngineDecision> decision = lekh::tsf::parseProcessKeyResponse(
    *response,
    request,
    serverInstanceId_,
    session_,
    key,
    compositionText_
  );
  if (!decision || decision->action == lekh::tsf::EngineAction::PassThrough) {
    return handleRejectedKey(key);
  }

  const std::wstring previousCompositionText = compositionText_;
  compositionText_ = decision->action == lekh::tsf::EngineAction::Compose
    ? decision->compositionText
    : L"";
  const lekh::tsf::CompositionTerminationDisposition previousDisposition = terminationDisposition_;
  terminationDisposition_ = decision->action != lekh::tsf::EngineAction::Compose || decision->compositionText.empty()
    ? lekh::tsf::CompositionTerminationDisposition::PreserveAppliedText
    : lekh::tsf::CompositionTerminationDisposition::DetachDaemonState;
  const lekh::tsf::EngineDecisionApplication application = lekh::tsf::applyEngineDecision(
    context,
    clientId_,
    &activeComposition_,
    static_cast<ITfCompositionSink*>(this),
    *decision
  );
  terminationDisposition_ = previousDisposition;
  if (application == lekh::tsf::EngineDecisionApplication::NotApplied) {
    compositionText_ = previousCompositionText;
    return handleRejectedKey(key);
  }
  if (application == lekh::tsf::EngineDecisionApplication::AppliedWithOwnershipCleanupRequired) {
    // SetText already materialized this key as canonical raw (Compose) or final
    // Unicode (Commit). Never pass it a second time and never schedule a later
    // overwrite merely because caret/composition cleanup was denied.
    quarantineAppliedDaemonSession();
    return true;
  }

  const bool compositionRequired = decision->action == lekh::tsf::EngineAction::Compose && !decision->compositionText.empty();
  const bool compositionMustEnd = decision->action == lekh::tsf::EngineAction::Commit ||
    decision->action == lekh::tsf::EngineAction::Cancel || decision->compositionText.empty();
  if ((compositionRequired && !activeComposition_) ||
      (compositionMustEnd && activeComposition_ &&
       !finishAppliedComposition(context))) {
    quarantineAppliedDaemonSession();
  }
  return true;
}

void LekhTextService::retireDaemonSession(lekh::tsf::SessionCommand command) {
  if (session_.sessionId.empty()) return;
  const lekh::tsf::SessionHandle retiringSession = session_;
  const std::wstring retiringServerInstanceId = serverInstanceId_;
  session_ = {};
  serverInstanceId_.clear();
  engineWarmed_ = false;
  if (!retirementTracker_->admitRetirement()) {
    // beginDaemonSession is barred while this state is possible, so this is a
    // defensive invariant guard. The already-scheduled same-client purge is
    // terminal for every session and therefore also covers this detached ID.
    contextSuppressed_ = true;
    return;
  }
  if (retiringServerInstanceId.empty()) {
    retirementTracker_->failRetirementAdmission();
    return;
  }

  const std::uint64_t sequence = requestSequenceLane_->fetch_add(1, std::memory_order_relaxed) + 1;
  auto* work = new (std::nothrow) DaemonRetirementWork{
    nullptr,
    retirementTracker_,
    requestSequenceLane_,
    clientInstanceId_,
    sequence,
    retiringServerInstanceId,
    retiringSession,
    command,
    false,
    retirementCompletionTarget_
  };
  if (queueDaemonRetirement(work)) return;
  // Never turn resource exhaustion into a multi-hundred-millisecond key-path
  // stall. Quarantine this client lane; a later lifecycle callback only
  // schedules an asynchronous same-client purge.
  retirementTracker_->failRetirementAdmission();
}

void LekhTextService::endDaemonSession() {
  retireDaemonSession(lekh::tsf::SessionCommand::End);
}

bool LekhTextService::finishAppliedComposition(ITfContext* context) {
  const lekh::tsf::CompositionTerminationDisposition previousDisposition = terminationDisposition_;
  terminationDisposition_ = lekh::tsf::CompositionTerminationDisposition::PreserveAppliedText;
  const bool finished = lekh::tsf::finishActiveComposition(
    context,
    clientId_,
    &activeComposition_
  );
  terminationDisposition_ = previousDisposition;
  return finished || !activeComposition_;
}

void LekhTextService::clearDaemonBinding() {
  retireDaemonSession(lekh::tsf::SessionCommand::End);
  serverInstanceId_.clear();
  compositionText_.clear();
  engineWarmed_ = false;
}

void LekhTextService::abandonSensitiveSession() {
  // Privacy transitions purge only Lekh-owned local/daemon state. Canonical
  // raw already in the host document belongs to the host and must never be
  // erased, replayed, or followed by a caret mutation.
  compositionText_.clear();
  retireDaemonSession(lekh::tsf::SessionCommand::End);
  if (activeComposition_ && !finishAppliedComposition(activeContext_)) {
    lekh::tsf::releaseActiveComposition(&activeComposition_);
  }
  clearDaemonBinding();
  contextSuppressed_ = true;
}

void LekhTextService::quarantineAppliedDaemonSession() {
  contextSuppressed_ = true;
  retireDaemonSession(lekh::tsf::SessionCommand::End);
  if (activeComposition_ && !finishAppliedComposition(activeContext_)) {
    // The host already contains the exact materialized result. Relinquishing
    // the COM range is safer than moving the caret or overwriting later keys.
    lekh::tsf::releaseActiveComposition(&activeComposition_);
  }
  compositionText_.clear();
}

bool LekhTextService::handleRejectedKey(const lekh::tsf::KeyEvent& key) {
  (void)key;
  if (!activeComposition_) {
    clearDaemonBinding();
    contextSuppressed_ = true;
    return false;
  }

  // The TSF range already contains the entire pre-existing canonical raw
  // composition. Finish it without modifying text and return the current key
  // to the host. If EndComposition is denied, relinquish ownership anyway so
  // no later recovery can overwrite the host's one pass of this key.
  retireDaemonSession(lekh::tsf::SessionCommand::End);
  if (!finishAppliedComposition(activeContext_)) {
    lekh::tsf::releaseActiveComposition(&activeComposition_);
  }
  compositionText_.clear();
  contextSuppressed_ = true;
  return false;
}

void LekhTextService::closeActiveContext(bool finishComposition) {
  if (finishComposition && activeContext_ && activeComposition_) {
    // The range already contains canonical raw. EndComposition is best effort
    // during lifecycle callbacks; denial never justifies pinning an invalid
    // context or a later text/caret mutation.
    if (!finishAppliedComposition(activeContext_)) {
      lekh::tsf::releaseActiveComposition(&activeComposition_);
    }
  }
  lekh::tsf::releaseActiveComposition(&activeComposition_);
  compositionText_.clear();
  endDaemonSession();
  releaseActiveContextReferences();
}

void LekhTextService::closeActiveContextForLifecycle(bool finishComposition) {
  closeActiveContext(finishComposition);
  scheduleDaemonReconciliation();
}

void LekhTextService::releaseActiveContextReferences() {
  if (activeContext_) {
    activeContext_->Release();
    activeContext_ = nullptr;
  }
  if (activeDocumentManager_) {
    activeDocumentManager_->Release();
    activeDocumentManager_ = nullptr;
  }
}

void LekhTextService::scheduleDaemonReconciliation() {
  if (!retirementTracker_->beginQuarantinedPurge()) return;
  auto* work = new (std::nothrow) DaemonRetirementWork{
    nullptr,
    retirementTracker_,
    requestSequenceLane_,
    clientInstanceId_,
    0,
    L"",
    {},
    lekh::tsf::SessionCommand::End,
    true,
    retirementCompletionTarget_
  };
  if (queueDaemonRetirement(work)) return;
  retirementTracker_->finishPurge(false);
}

bool LekhTextService::createCompletionWindow() {
  if (completionWindow_) return true;
  completionToken_ = static_cast<ULONG_PTR>(InterlockedIncrement64(&g_nextCompletionToken));
  if (completionToken_ == 0) {
    completionToken_ = static_cast<ULONG_PTR>(InterlockedIncrement64(&g_nextCompletionToken));
  }
  completionWindowClassName_ = kRetirementCompletionWindowClassPrefix +
    std::to_wstring(static_cast<std::uint64_t>(completionToken_));
  WNDCLASSW windowClass = {};
  windowClass.lpfnWndProc = CompletionWindowProc;
  windowClass.hInstance = g_module;
  windowClass.lpszClassName = completionWindowClassName_.c_str();
  if (!RegisterClassW(&windowClass)) {
    completionToken_ = 0;
    completionWindowClassName_.clear();
    return false;
  }
  completionWindow_ = CreateWindowExW(
    0,
    completionWindowClassName_.c_str(),
    L"",
    0,
    0,
    0,
    0,
    0,
    HWND_MESSAGE,
    nullptr,
    g_module,
    this
  );
  if (!completionWindow_) {
    UnregisterClassW(completionWindowClassName_.c_str(), g_module);
    completionToken_ = 0;
    completionWindowClassName_.clear();
  } else {
    std::lock_guard<std::mutex> lock(retirementCompletionTarget_->mutex);
    retirementCompletionTarget_->window = completionWindow_;
    retirementCompletionTarget_->token = completionToken_;
  }
  return completionWindow_ != nullptr;
}

void LekhTextService::destroyCompletionWindow() {
  {
    std::lock_guard<std::mutex> lock(retirementCompletionTarget_->mutex);
    if (retirementCompletionTarget_->window == completionWindow_ &&
        retirementCompletionTarget_->token == completionToken_) {
      retirementCompletionTarget_->window = nullptr;
      retirementCompletionTarget_->token = 0;
    }
  }
  if (completionWindow_) {
    HWND window = completionWindow_;
    completionWindow_ = nullptr;
    DestroyWindow(window);
  }
  if (!completionWindowClassName_.empty()) {
    UnregisterClassW(completionWindowClassName_.c_str(), g_module);
    completionWindowClassName_.clear();
  }
  completionToken_ = 0;
}

LRESULT CALLBACK LekhTextService::CompletionWindowProc(
  HWND window,
  UINT message,
  WPARAM wParam,
  LPARAM lParam
) {
  auto* service = reinterpret_cast<LekhTextService*>(GetWindowLongPtrW(window, GWLP_USERDATA));
  if (message == WM_NCCREATE) {
    auto* creation = reinterpret_cast<CREATESTRUCTW*>(lParam);
    service = creation ? static_cast<LekhTextService*>(creation->lpCreateParams) : nullptr;
    SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(service));
  }
  if (message == kRetirementCompletedMessage && service) {
    if (lekh::tsf::retirementCompletionTokenMatches(
          static_cast<std::uint64_t>(wParam),
          static_cast<std::uint64_t>(service->completionToken_)
        ) &&
        !service->retirementTracker_->blocksNewSessions() &&
        service->acceptsKeystrokes_) {
      service->prepareCurrentFocus();
    }
    return 0;
  }
  if (message == WM_NCDESTROY) SetWindowLongPtrW(window, GWLP_USERDATA, 0);
  return DefWindowProcW(window, message, wParam, lParam);
}

lekh::tsf::RequestMetadata LekhTextService::nextRequestMetadata(const wchar_t* operation, DWORD timeoutMs) {
  const std::uint64_t sentAt = unixEpochMilliseconds();
  const std::uint64_t sequence = requestSequenceLane_->fetch_add(1, std::memory_order_relaxed) + 1;
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
  keystrokeManager->Release();
  if (FAILED(hr)) return hr;
  keyEventSinkAdvised_ = true;

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
      keystrokeManager->UnadviseKeyEventSink(clientId_);
      keystrokeManager->Release();
    }
    keyEventSinkAdvised_ = false;
  }
}
