#include "LekhTextService.h"

#include "Guids.h"

#include <algorithm>
#include <cwchar>
#include <iterator>
#include <string>

extern long g_objectCount;

namespace {

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
  if (wParam >= L'A' && wParam <= L'Z') {
    return L"Key" + std::wstring(1, static_cast<wchar_t>(wParam));
  }
  switch (wParam) {
    case VK_SPACE: return L"Space";
    case VK_BACK: return L"Backspace";
    case VK_RETURN: return L"Enter";
    case VK_ESCAPE: return L"Escape";
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

} // namespace

LekhTextService::LekhTextService() {
  InterlockedIncrement(&g_objectCount);
}

LekhTextService::~LekhTextService() {
  closeActiveContext(true);
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
  return adviseSinks();
}

STDMETHODIMP LekhTextService::Deactivate() {
  closeActiveContext(true);
  unadviseSinks();
  clientId_ = TF_CLIENTID_NULL;
  activationFlags_ = 0;
  if (threadMgr_) {
    threadMgr_->Release();
    threadMgr_ = nullptr;
  }
  return S_OK;
}

STDMETHODIMP LekhTextService::OnSetFocus(BOOL foreground) {
  if (!foreground) closeActiveContext(true);
  contextSuppressed_ = false;
  return S_OK;
}

STDMETHODIMP LekhTextService::OnTestKeyDown(ITfContext* context, WPARAM wParam, LPARAM lParam, BOOL* eaten) {
  if (!eaten) return E_POINTER;
  *eaten = FALSE;
  if (!experimentalKeyEatingEnabled() || !shouldHandleKey(wParam, lParam)) return S_OK;
  *eaten = prepareSafeContext(context) ? TRUE : FALSE;
  return S_OK;
}

STDMETHODIMP LekhTextService::OnKeyDown(ITfContext* context, WPARAM wParam, LPARAM lParam, BOOL* eaten) {
  if (!eaten) return E_POINTER;
  *eaten = FALSE;
  if (!experimentalKeyEatingEnabled() || !shouldHandleKey(wParam, lParam) || !prepareSafeContext(context)) return S_OK;
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

STDMETHODIMP LekhTextService::OnInitDocumentMgr(ITfDocumentMgr*) {
  return S_OK;
}

STDMETHODIMP LekhTextService::OnUninitDocumentMgr(ITfDocumentMgr*) {
  closeActiveContext(true);
  contextSuppressed_ = false;
  return S_OK;
}

STDMETHODIMP LekhTextService::OnSetFocus(ITfDocumentMgr*, ITfDocumentMgr*) {
  closeActiveContext(true);
  contextSuppressed_ = false;
  return S_OK;
}

STDMETHODIMP LekhTextService::OnPushContext(ITfContext*) {
  closeActiveContext(true);
  contextSuppressed_ = false;
  return S_OK;
}

STDMETHODIMP LekhTextService::OnPopContext(ITfContext*) {
  closeActiveContext(true);
  contextSuppressed_ = false;
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

bool LekhTextService::prepareSafeContext(ITfContext* context) {
  if (!context || clientId_ == TF_CLIENTID_NULL || contextSuppressed_ ||
      (activationFlags_ & TF_TMAE_SECUREMODE) != 0) {
    return false;
  }

  const lekh::tsf::ContextPrivacy privacy = lekh::tsf::inspectContextPrivacy(context, clientId_);
  if (privacy != lekh::tsf::ContextPrivacy::Safe) {
    closeActiveContext(true);
    return false;
  }

  if (activeContext_ != context) {
    closeActiveContext(true);
    activeContext_ = context;
    activeContext_->AddRef();
    contextSuppressed_ = false;
  }
  return !sessionId_.empty() || beginDaemonSession();
}

bool LekhTextService::beginDaemonSession() {
  if (!sessionId_.empty()) return true;
  const std::wstring requestId = nextRequestId(L"begin");
  const std::optional<std::wstring> response = ipc_.request(
    lekh::tsf::makeBeginSessionRequest(requestId, GetTickCount64()),
    kLekhHotPathTimeoutMs
  );
  if (!response) return false;
  const std::optional<std::wstring> sessionId = lekh::tsf::parseBeginSessionResponse(*response, requestId);
  if (!sessionId) return false;
  sessionId_ = *sessionId;
  return true;
}

bool LekhTextService::processKey(ITfContext* context, WPARAM wParam, LPARAM lParam) {
  if (sessionId_.empty() || context != activeContext_) return false;
  const std::wstring requestId = nextRequestId(L"key");
  const std::optional<std::wstring> response = ipc_.request(
    lekh::tsf::makeProcessKeyRequest(
      requestId,
      sessionId_,
      makeKeyEvent(wParam, lParam),
      GetTickCount64()
    ),
    kLekhHotPathTimeoutMs
  );
  if (!response) {
    abandonDaemonSession();
    return false;
  }

  const std::optional<lekh::tsf::EngineDecision> decision = lekh::tsf::parseProcessKeyResponse(
    *response,
    requestId,
    sessionId_
  );
  if (!decision || decision->action == lekh::tsf::EngineAction::PassThrough) {
    abandonDaemonSession();
    return false;
  }

  const bool applied = lekh::tsf::applyEngineDecision(
    context,
    clientId_,
    &activeComposition_,
    *decision
  );
  if (!applied) {
    abandonDaemonSession();
    return false;
  }

  const bool compositionRequired = decision->action == lekh::tsf::EngineAction::Compose && !decision->displayText.empty();
  const bool compositionMustEnd = decision->action == lekh::tsf::EngineAction::Commit ||
    decision->action == lekh::tsf::EngineAction::Cancel || decision->displayText.empty();
  if ((compositionRequired && !activeComposition_) ||
      (compositionMustEnd && activeComposition_ &&
       !lekh::tsf::finishActiveComposition(context, clientId_, &activeComposition_))) {
    contextSuppressed_ = true;
    endDaemonSession();
    lekh::tsf::releaseActiveComposition(&activeComposition_);
  }
  return true;
}

void LekhTextService::endDaemonSession() {
  if (sessionId_.empty()) return;
  const std::wstring endingSession = sessionId_;
  sessionId_.clear();
  const std::wstring requestId = nextRequestId(L"end");
  const std::optional<std::wstring> response = ipc_.request(
    lekh::tsf::makeSessionRequest(
      requestId,
      endingSession,
      lekh::tsf::SessionCommand::End,
      GetTickCount64()
    ),
    kLekhHotPathTimeoutMs
  );
  if (response) {
    lekh::tsf::parseSessionResponse(*response, requestId, lekh::tsf::SessionCommand::End);
  }
}

void LekhTextService::abandonDaemonSession() {
  if (activeContext_ && activeComposition_) {
    if (!lekh::tsf::finishActiveComposition(activeContext_, clientId_, &activeComposition_)) {
      contextSuppressed_ = true;
      lekh::tsf::releaseActiveComposition(&activeComposition_);
    }
  }
  if (sessionId_.empty()) return;
  const std::wstring abandonedSession = sessionId_;
  const std::wstring requestId = nextRequestId(L"cancel");
  ipc_.request(
    lekh::tsf::makeSessionRequest(
      requestId,
      abandonedSession,
      lekh::tsf::SessionCommand::Cancel,
      GetTickCount64()
    ),
    kLekhHotPathTimeoutMs
  );
  endDaemonSession();
}

void LekhTextService::closeActiveContext(bool finishComposition) {
  if (finishComposition && activeContext_ && activeComposition_) {
    lekh::tsf::finishActiveComposition(activeContext_, clientId_, &activeComposition_);
  }
  lekh::tsf::releaseActiveComposition(&activeComposition_);
  endDaemonSession();
  if (activeContext_) {
    activeContext_->Release();
    activeContext_ = nullptr;
  }
}

std::wstring LekhTextService::nextRequestId(const wchar_t* operation) const {
  static LONGLONG counter = 0;
  return L"windows_tsf_" + std::to_wstring(GetCurrentProcessId()) + L"_" + operation + L"_" +
    std::to_wstring(InterlockedIncrement64(&counter));
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
