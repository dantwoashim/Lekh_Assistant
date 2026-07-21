#pragma once

#include "TsfProtocol.h"

#include <msctf.h>

namespace lekh::tsf {

enum class ContextPrivacy {
  Safe,
  Sensitive,
  Unknown
};

struct EditSessionDiagnostics {
  HRESULT requestResult = E_FAIL;
  HRESULT sessionResult = E_FAIL;
  bool hostTextMutated = false;
};

ContextPrivacy inspectContextPrivacy(ITfContext* context, TfClientId clientId);

bool applyEngineDecision(
  ITfContext* context,
  TfClientId clientId,
  ITfComposition** activeComposition,
  const EngineDecision& decision,
  EditSessionDiagnostics* diagnostics = nullptr
);

bool finishActiveComposition(
  ITfContext* context,
  TfClientId clientId,
  ITfComposition** activeComposition
);

void releaseActiveComposition(ITfComposition** activeComposition);

} // namespace lekh::tsf
