#pragma once

#include "IpcClient.h"

#include <msctf.h>
#include <windows.h>
#include <string>

class LekhTextService final : public ITfTextInputProcessorEx, public ITfKeyEventSink {
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

private:
  ~LekhTextService();

  bool shouldHandleKey(WPARAM wParam, LPARAM lParam) const;
  bool experimentalKeyEatingEnabled() const;
  bool daemonAvailable() const;
  bool sendKeyToDaemon(WPARAM wParam, LPARAM lParam) const;
  void resetSessionId();
  HRESULT adviseKeySink();
  void unadviseKeySink();

  long refCount_ = 1;
  ITfThreadMgr* threadMgr_ = nullptr;
  TfClientId clientId_ = TF_CLIENTID_NULL;
  DWORD keyEventSinkCookie_ = TF_INVALID_COOKIE;
  LekhIpcClient ipc_;
  std::wstring sessionId_;
};

STDAPI DllGetClassObject(REFCLSID clsid, REFIID iid, void** object);
