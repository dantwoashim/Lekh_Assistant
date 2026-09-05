#pragma once

#include "CandidateState.h"
#include "CandidateWindow.h"
#include "DisplayAttributes.h"
#include "IpcClient.h"
#include "TsfEditSession.h"
#include "TsfProtocol.h"
#include "WindowsPreferences.h"

#include <msctf.h>
#include <windows.h>

#include <cstdint>
#include <string>

class LekhTextService final :
  public ITfTextInputProcessorEx,
  public ITfKeyEventSink,
  public ITfThreadMgrEventSink,
  public ITfTextEditSink,
  public ITfDisplayAttributeProvider {
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

  // ITfTextEditSink
  STDMETHODIMP OnEndEdit(
    ITfContext* context,
    TfEditCookie readOnlyCookie,
    ITfEditRecord* editRecord
  ) override;

  // ITfDisplayAttributeProvider
  STDMETHODIMP EnumDisplayAttributeInfo(IEnumTfDisplayAttributeInfo** enumerator) override;
  STDMETHODIMP GetDisplayAttributeInfo(REFGUID guid, ITfDisplayAttributeInfo** information) override;

private:
  ~LekhTextService();

  bool shouldHandleKey(WPARAM wParam, LPARAM lParam) const;
  void primeFocusedContext();
  void primeContextPrivacy(ITfContext* context);
  bool prepareSafeContext(ITfContext* context);
  bool negotiateDaemon();
  bool beginDaemonSession();
  bool processKey(ITfContext* context, WPARAM wParam, LPARAM lParam);
  bool commitCandidate(
    ITfContext* context,
    const lekh::tsf::Candidate& candidate,
    const std::wstring& failOpenText
  );
  void scheduleCommittedCandidateLearning(std::uint64_t commitEpoch);
  bool applyDecision(
    ITfContext* context,
    const lekh::tsf::EngineDecision& decision,
    const std::wstring& failOpenText
  );
  bool queueFailOpenText(ITfContext* context, const std::wstring& failOpenText);
  static void __stdcall privacyInspectionCompleted(
    void* context,
    const lekh::tsf::PrivacyInspectionOutcome& outcome
  );
  void handlePrivacyInspectionCompleted(const lekh::tsf::PrivacyInspectionOutcome& outcome);
  static void __stdcall editSessionCompleted(void* context, const lekh::tsf::EditSessionOutcome& outcome);
  void handleEditSessionCompleted(const lekh::tsf::EditSessionOutcome& outcome);
  void updateCandidateUi(
    const lekh::tsf::EngineDecision& decision,
    const RECT* textExtent,
    HWND ownerWindow
  );
  void resetCandidateUi();
  void endDaemonSession();
  void abandonDaemonSession();
  void closeActiveContext(bool finishComposition);
  void replaceCompositionState();
  HRESULT adviseContextSink(ITfContext* context);
  void unadviseContextSink();
  lekh::tsf::RequestMetadata nextRequestMetadata(const wchar_t* operation, DWORD timeoutMs);
  HRESULT adviseSinks();
  HRESULT preserveModeKeys(ITfKeystrokeMgr* keystrokeManager);
  void unpreserveModeKeys(ITfKeystrokeMgr* keystrokeManager);
  void unadviseSinks();

  long refCount_ = 1;
  ITfThreadMgr* threadMgr_ = nullptr;
  TfClientId clientId_ = TF_CLIENTID_NULL;
  DWORD activationFlags_ = 0;
  TfGuidAtom compositionDisplayAttribute_ = TF_INVALID_GUIDATOM;
  TfGuidAtom ghostDisplayAttribute_ = TF_INVALID_GUIDATOM;
  DWORD threadMgrEventSinkCookie_ = TF_INVALID_COOKIE;
  DWORD textEditSinkCookie_ = TF_INVALID_COOKIE;
  bool keyEventSinkAdvised_ = false;
  bool modeKeysPreserved_ = false;
  bool contextSuppressed_ = false;
  bool privacyInspectionPending_ = false;
  lekh::tsf::ContextPrivacy contextPrivacy_ = lekh::tsf::ContextPrivacy::Unknown;
  bool failOpenPending_ = false;
  bool activeGhostVisible_ = false;
  LekhIpcClient ipc_;
  ITfContext* activeContext_ = nullptr;
  lekh::tsf::CompositionState* compositionState_ = nullptr;
  lekh::tsf::CandidateState candidateState_;
  lekh::tsf::CandidateWindow candidateWindow_;
  std::wstring rawComposition_;
  std::wstring lastPresentedText_;
  std::wstring clientInstanceId_;
  std::wstring serverInstanceId_;
  lekh::tsf::SessionHandle session_;
  lekh::tsf::WindowsPreferences preferences_;
  bool sessionPersonalizationEnabled_ = false;
  std::uint64_t contextGeneration_ = 0;
  LONGLONG requestSequence_ = 0;
};

STDAPI DllGetClassObject(REFCLSID clsid, REFIID iid, void** object);
