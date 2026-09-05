#pragma once

#include "TsfProtocol.h"

#include <inputscope.h>
#include <msctf.h>

#include <cstdint>
#include <string>

namespace lekh::tsf {

enum class ContextPrivacy {
  Safe,
  Sensitive,
  Unknown
};

enum class EditSubmissionStatus {
  Rejected,
  Completed,
  Queued
};

enum class EditFailureStage {
  None,
  QueryInsertionRange,
  StartComposition,
  GetCompositionRange,
  SetText,
  SetSelection,
  InsertText,
  EndComposition
};

class CompositionState;

struct EditSessionOutcome {
  ITfContext* context = nullptr; // Borrowed and valid only during the completion callback.
  CompositionState* state = nullptr; // Borrowed and valid only during the completion callback.
  std::uint64_t contextGeneration = 0;
  EngineDecision decision;
  std::wstring failOpenText;
  HRESULT operationResult = E_PENDING;
  EditFailureStage failureStage = EditFailureStage::None;
  bool editSessionRan = false;
  bool desiredApplied = false;
  bool fallbackApplied = false;
  bool hostTextMutated = false;
  bool consumed = false;
  bool compositionActive = false;
  bool failOpen = false;
  bool privacyBlocked = false;
  std::uint32_t pendingOperations = 0;
  bool hasTextExtent = false;
  RECT textExtent = {};
  HWND candidateOwnerWindow = nullptr;
};

using EditSessionCompletion = void (__stdcall *)(void*, const EditSessionOutcome&);

struct EditSessionCallback {
  IUnknown* lifetimeOwner = nullptr;
  void* context = nullptr;
  EditSessionCompletion function = nullptr;
};

struct EditSubmissionResult {
  EditSubmissionStatus status = EditSubmissionStatus::Rejected;
  HRESULT requestResult = E_FAIL;
  HRESULT sessionResult = E_FAIL;
  EditSessionOutcome outcome;
};

struct PrivacyInspectionOutcome {
  ITfContext* context = nullptr; // Borrowed and valid only during the completion callback.
  std::uint64_t contextGeneration = 0;
  ContextPrivacy privacy = ContextPrivacy::Unknown;
  HRESULT operationResult = E_PENDING;
  bool editSessionRan = false;
};

using PrivacyInspectionCompletion = void (__stdcall *)(void*, const PrivacyInspectionOutcome&);

struct PrivacyInspectionCallback {
  IUnknown* lifetimeOwner = nullptr;
  void* context = nullptr;
  PrivacyInspectionCompletion function = nullptr;
};

struct PrivacyInspectionSubmission {
  EditSubmissionStatus status = EditSubmissionStatus::Rejected;
  HRESULT requestResult = E_FAIL;
  HRESULT sessionResult = E_FAIL;
  PrivacyInspectionOutcome outcome;
};

ContextPrivacy classifyInputScopes(const InputScope* scopes, UINT scopeCount);
ContextPrivacy inspectContextPrivacy(ITfContext* context, TfClientId clientId);
PrivacyInspectionSubmission submitContextPrivacyInspection(
  ITfContext* context,
  TfClientId clientId,
  std::uint64_t contextGeneration,
  const PrivacyInspectionCallback& callback = {}
);

CompositionState* createCompositionState();
void addRefCompositionState(CompositionState* state);
void releaseCompositionState(CompositionState** state);
bool compositionStateIsActive(const CompositionState* state);
bool compositionStateIsFailOpen(const CompositionState* state);
bool compositionStateHasPendingOperations(const CompositionState* state);
void markCompositionStateClosing(CompositionState* state);
void cancelCompositionStatePendingEdits(CompositionState* state);
void abandonCompositionState(CompositionState* state);

EditSubmissionResult submitEngineDecision(
  ITfContext* context,
  TfClientId clientId,
  CompositionState* state,
  const EngineDecision& decision,
  const std::wstring& failOpenText,
  std::uint64_t contextGeneration,
  const EditSessionCallback& callback = {},
  TfGuidAtom compositionDisplayAttribute = TF_INVALID_GUIDATOM,
  TfGuidAtom ghostDisplayAttribute = TF_INVALID_GUIDATOM
);

EditSubmissionResult submitFailOpenText(
  ITfContext* context,
  TfClientId clientId,
  CompositionState* state,
  const std::wstring& failOpenText,
  std::uint64_t contextGeneration,
  const EditSessionCallback& callback = {}
);

EditSubmissionResult submitFinishComposition(
  ITfContext* context,
  TfClientId clientId,
  CompositionState* state,
  std::uint64_t contextGeneration,
  const std::wstring& finalText,
  const EditSessionCallback& callback = {}
);

} // namespace lekh::tsf
