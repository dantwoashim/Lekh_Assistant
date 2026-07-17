#pragma once

#include "IpcClient.h"
#include "TsfEditSession.h"
#include "TsfProtocol.h"

#include <msctf.h>
#include <windows.h>

#include <string>

class LekhTextService final :
  public ITfTextInputProcessorEx,
  public ITfKeyEventSink,
  public ITfThreadMgrEventSink {
public:
  LekhTextService();

  // IUnknown
  STDMETHODIMP QueryInterface(REFIID riid, void** object) override;
  STDMETHODIMP_(ULONG) AddRef() override;
  STDMETHODIMP_(ULONG) Release() override;

  // ITfTextInputProcessor
  STDMETHODIMP Activate(ITfThreadMgr* threadMgr, TfClientId clientId) override;
  STDMETHODIMP Deactivate() override;

  // ITfTextInputProcessorEx
  STDMETHODIMP ActivateEx(ITfThreadMgr* threadMgr, TfClientId clientId, DWORD flags) override;

  // ITfKeyEventSink
  STDMETHODIMP OnSetFocus(BOOL foreground) override;
  STDMETHODIMP OnTestKeyDown(ITfContext* context, WPARAM wParam, LPARAM lParam, BOOL* eaten) override;
  STDMETHODIMP OnKeyDown(ITfContext* context, WPARAM wParam, LPARAM lParam, BOOL* eaten) override;
  STDMETHODIMP OnTestKeyUp(ITfContext* context, WPARAM wParam, LPARAM lParam, BOOL* eaten) override;
  STDMETHODIMP OnKeyUp(ITfContext* context, WPARAM wParam, LPARAM lParam, BOOL* eaten) override;
  STDMETHODIMP OnPreservedKey(ITfContext* context, REFGUID guid, BOOL* eaten) override;

  // ITfThreadMgrEventSink
  STDMETHODIMP OnInitDocumentMgr(ITfDocumentMgr* documentManager) override;
  STDMETHODIMP OnUninitDocumentMgr(ITfDocumentMgr* documentManager) override;
  STDMETHODIMP OnSetFocus(ITfDocumentMgr* focus, ITfDocumentMgr* previousFocus) override;
  STDMETHODIMP OnPushContext(ITfContext* context) override;
  STDMETHODIMP OnPopContext(ITfContext* context) override;

private:
  ~LekhTextService();

  bool shouldHandleKey(WPARAM wParam, LPARAM lParam) const;
  bool experimentalKeyEatingEnabled() const;
  bool prepareSafeContext(ITfContext* context);
  bool beginDaemonSession();
  bool processKey(ITfContext* context, WPARAM wParam, LPARAM lParam);
  void endDaemonSession();
  void abandonDaemonSession();
  void closeActiveContext(bool finishComposition);
  std::wstring nextRequestId(const wchar_t* operation) const;
  HRESULT adviseSinks();
  void unadviseSinks();

  long refCount_ = 1;
  ITfThreadMgr* threadMgr_ = nullptr;
  TfClientId clientId_ = TF_CLIENTID_NULL;
  DWORD activationFlags_ = 0;
  DWORD threadMgrEventSinkCookie_ = TF_INVALID_COOKIE;
  bool keyEventSinkAdvised_ = false;
  bool contextSuppressed_ = false;
  LekhIpcClient ipc_;
  ITfContext* activeContext_ = nullptr;
  ITfComposition* activeComposition_ = nullptr;
  std::wstring sessionId_;
};

STDAPI DllGetClassObject(REFCLSID clsid, REFIID iid, void** object);
