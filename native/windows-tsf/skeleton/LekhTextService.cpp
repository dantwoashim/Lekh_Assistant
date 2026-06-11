#include "LekhTextService.h"

#include "Guids.h"

#include <cstdio>
#include <cwchar>
#include <iterator>
#include <string>

extern long g_objectCount;

namespace {

std::wstring makeSessionId() {
  static LONG counter = 0;
  wchar_t buffer[128] = {};
  swprintf_s(
    buffer,
    L"windows-tsf-%lu-%llu-%ld",
    static_cast<unsigned long>(GetCurrentProcessId()),
    static_cast<unsigned long long>(GetTickCount64()),
    static_cast<long>(InterlockedIncrement(&counter))
  );
  return buffer;
}

std::wstring makeKeyRequest(const std::wstring& sessionId, WPARAM wParam, LPARAM lParam) {
  wchar_t buffer[512] = {};
  const unsigned long virtualKey = static_cast<unsigned long>(wParam);
  const unsigned long scanCode = static_cast<unsigned long>((lParam >> 16) & 0xff);
  swprintf_s(
    buffer,
    L"{\"id\":\"windows_tsf_%lu\",\"type\":\"session.processKeyStroke\",\"version\":1,\"sentAt\":1,\"payload\":{\"sessionId\":\"%ls\",\"key\":{\"key\":\"%lc\",\"code\":\"VK_%lu\",\"modifiers\":{\"shift\":false,\"ctrl\":false,\"alt\":false,\"meta\":false},\"timestamp\":1,\"platform\":\"windows-tsf\"}}}",
    virtualKey,
    sessionId.c_str(),
    virtualKey >= 0x20 && virtualKey <= 0x7e ? static_cast<wchar_t>(virtualKey) : L' ',
    scanCode
  );
  return buffer;
}

} // namespace

LekhTextService::LekhTextService() : sessionId_(makeSessionId()) {
  InterlockedIncrement(&g_objectCount);
}

LekhTextService::~LekhTextService() {
  unadviseKeySink();
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

STDMETHODIMP LekhTextService::ActivateEx(ITfThreadMgr* threadMgr, TfClientId clientId, DWORD) {
  if (!threadMgr) return E_INVALIDARG;
  if (threadMgr_) threadMgr_->Release();
  threadMgr_ = threadMgr;
  threadMgr_->AddRef();
  clientId_ = clientId;
  resetSessionId();
  return adviseKeySink();
}

STDMETHODIMP LekhTextService::Deactivate() {
  unadviseKeySink();
  clientId_ = TF_CLIENTID_NULL;
  if (threadMgr_) {
    threadMgr_->Release();
    threadMgr_ = nullptr;
  }
  sessionId_.clear();
  return S_OK;
}

STDMETHODIMP LekhTextService::OnSetFocus(BOOL foreground) {
  if (foreground) resetSessionId();
  return S_OK;
}

STDMETHODIMP LekhTextService::OnTestKeyDown(ITfContext*, WPARAM wParam, LPARAM lParam, BOOL* eaten) {
  if (!eaten) return E_POINTER;
  *eaten = experimentalKeyEatingEnabled() && shouldHandleKey(wParam, lParam) && daemonAvailable() ? TRUE : FALSE;
  return S_OK;
}

STDMETHODIMP LekhTextService::OnKeyDown(ITfContext*, WPARAM wParam, LPARAM lParam, BOOL* eaten) {
  if (!eaten) return E_POINTER;
  if (!experimentalKeyEatingEnabled() || !shouldHandleKey(wParam, lParam) || !daemonAvailable()) {
    *eaten = FALSE;
    return S_OK;
  }
  *eaten = sendKeyToDaemon(wParam, lParam) ? TRUE : FALSE;
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

bool LekhTextService::shouldHandleKey(WPARAM wParam, LPARAM) const {
  if (GetKeyState(VK_CONTROL) < 0 || GetKeyState(VK_MENU) < 0 || GetKeyState(VK_LWIN) < 0 || GetKeyState(VK_RWIN) < 0) {
    return false;
  }
  return (wParam >= L'A' && wParam <= L'Z') || wParam == VK_SPACE || wParam == VK_BACK || wParam == VK_RETURN || wParam == VK_ESCAPE;
}

bool LekhTextService::experimentalKeyEatingEnabled() const {
  wchar_t value[16] = {};
  const DWORD length = GetEnvironmentVariableW(L"LEKH_TSF_ENABLE_EXPERIMENTAL_KEY_EATING", value, static_cast<DWORD>(std::size(value)));
  if (length == 0 || length >= std::size(value)) return false;
  return wcscmp(value, L"1") == 0 || _wcsicmp(value, L"true") == 0 || _wcsicmp(value, L"yes") == 0;
}

bool LekhTextService::daemonAvailable() const {
  return ipc_.canConnect(kLekhHotPathTimeoutMs);
}

bool LekhTextService::sendKeyToDaemon(WPARAM wParam, LPARAM lParam) const {
  const std::optional<std::wstring> response = ipc_.request(makeKeyRequest(sessionId_, wParam, lParam), kLekhHotPathTimeoutMs);
  return response.has_value() && response->find(L"\"ok\":true") != std::wstring::npos;
}

void LekhTextService::resetSessionId() {
  sessionId_ = makeSessionId();
}

HRESULT LekhTextService::adviseKeySink() {
  if (!threadMgr_) return E_FAIL;
  ITfSource* source = nullptr;
  HRESULT hr = threadMgr_->QueryInterface(IID_ITfSource, reinterpret_cast<void**>(&source));
  if (FAILED(hr) || !source) return hr;
  hr = source->AdviseSink(IID_ITfKeyEventSink, static_cast<ITfKeyEventSink*>(this), &keyEventSinkCookie_);
  source->Release();
  return hr;
}

void LekhTextService::unadviseKeySink() {
  if (!threadMgr_ || keyEventSinkCookie_ == TF_INVALID_COOKIE) return;
  ITfSource* source = nullptr;
  if (SUCCEEDED(threadMgr_->QueryInterface(IID_ITfSource, reinterpret_cast<void**>(&source))) && source) {
    source->UnadviseSink(keyEventSinkCookie_);
    source->Release();
  }
  keyEventSinkCookie_ = TF_INVALID_COOKIE;
}
