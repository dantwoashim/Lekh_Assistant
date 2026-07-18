#pragma once

#include "CompositionRecovery.h"
#include "DaemonRetirement.h"
#include "IpcClient.h"
#include "TsfEditSession.h"
#include "TsfProtocol.h"

#include <msctf.h>
#include <windows.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <string>

struct LekhRetirementCompletionTarget final {
  std::mutex mutex;
  HWND window = nullptr;
  ULONG_PTR token = 0;
};

class LekhTextService final :
  public ITfTextInputProcessorEx,
  public ITfKeyEventSink,
  public ITfThreadMgrEventSink,
  public ITfCompositionSink {
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

  // ITfCompositionSink
  STDMETHODIMP OnCompositionTerminated(TfEditCookie editCookie, ITfComposition* composition) override;

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
  bool contextIsActive(ITfContext* context) const;
  bool documentManagerIsActive(ITfDocumentMgr* documentManager) const;
  bool documentManagerIsCurrentFocus(ITfDocumentMgr* documentManager) const;
  bool sessionStateReadyForContext(ITfContext* context) const;
  bool sessionReadyForContext(ITfContext* context);
  bool prepareSafeContext(ITfContext* context, ITfDocumentMgr* documentManager);
  void prepareFocusedDocument(ITfDocumentMgr* documentManager);
  void prepareCurrentFocus();
  bool negotiateDaemon();
  bool warmDaemon();
  bool beginDaemonSession();
  bool processKey(ITfContext* context, WPARAM wParam, LPARAM lParam);
  void retireDaemonSession(lekh::tsf::SessionCommand command);
  void endDaemonSession();
  bool finishAppliedComposition(ITfContext* context);
  void abandonSensitiveSession();
  void quarantineAppliedDaemonSession();
  bool handleRejectedKey(const lekh::tsf::KeyEvent& key);
  void clearDaemonBinding();
  void closeActiveContext(bool finishComposition);
  void closeActiveContextForLifecycle(bool finishComposition);
  void releaseActiveContextReferences();
  void scheduleDaemonReconciliation();
  bool createCompletionWindow();
  void destroyCompletionWindow();
  static LRESULT CALLBACK CompletionWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam);
  lekh::tsf::RequestMetadata nextRequestMetadata(const wchar_t* operation, DWORD timeoutMs);
  HRESULT adviseSinks();
  void unadviseSinks();

  long refCount_ = 1;
  ITfThreadMgr* threadMgr_ = nullptr;
  TfClientId clientId_ = TF_CLIENTID_NULL;
  DWORD activationFlags_ = 0;
  DWORD threadMgrEventSinkCookie_ = TF_INVALID_COOKIE;
  bool keyEventSinkAdvised_ = false;
  bool acceptsKeystrokes_ = false;
  bool contextSuppressed_ = false;
  LekhIpcClient ipc_;
  ITfContext* activeContext_ = nullptr;
  ITfDocumentMgr* activeDocumentManager_ = nullptr;
  ITfComposition* activeComposition_ = nullptr;
  std::wstring clientInstanceId_;
  std::wstring serverInstanceId_;
  std::wstring compositionText_;
  lekh::tsf::CompositionTerminationDisposition terminationDisposition_ =
    lekh::tsf::CompositionTerminationDisposition::DetachDaemonState;
  bool engineWarmed_ = false;
  std::shared_ptr<lekh::tsf::DaemonRetirementTracker> retirementTracker_ =
    std::make_shared<lekh::tsf::DaemonRetirementTracker>();
  lekh::tsf::SessionHandle session_;
  std::shared_ptr<std::atomic_uint64_t> requestSequenceLane_ =
    std::make_shared<std::atomic_uint64_t>(0);
  std::shared_ptr<LekhRetirementCompletionTarget> retirementCompletionTarget_ =
    std::make_shared<LekhRetirementCompletionTarget>();
  HWND completionWindow_ = nullptr;
  ULONG_PTR completionToken_ = 0;
  std::wstring completionWindowClassName_;
};

STDAPI DllGetClassObject(REFCLSID clsid, REFIID iid, void** object);
