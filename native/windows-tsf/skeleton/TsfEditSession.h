#pragma once

#include "TsfProtocol.h"

#include <msctf.h>

namespace lekh::tsf {

enum class ContextPrivacy {
  Safe,
  Sensitive,
  Unknown
};

enum class EngineDecisionApplication {
  NotApplied,
  Applied,
  AppliedWithOwnershipCleanupRequired
};

ContextPrivacy inspectContextPrivacy(ITfContext* context, TfClientId clientId);

EngineDecisionApplication applyEngineDecision(
  ITfContext* context,
  TfClientId clientId,
  ITfComposition** activeComposition,
  ITfCompositionSink* compositionSink,
  const EngineDecision& decision
);

bool finishActiveComposition(
  ITfContext* context,
  TfClientId clientId,
  ITfComposition** activeComposition
);

void releaseActiveComposition(ITfComposition** activeComposition);

} // namespace lekh::tsf
