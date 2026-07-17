#pragma once

#include "TsfProtocol.h"

#include <msctf.h>

namespace lekh::tsf {

enum class ContextPrivacy {
  Safe,
  Sensitive,
  Unknown
};

ContextPrivacy inspectContextPrivacy(ITfContext* context, TfClientId clientId);

bool applyEngineDecision(
  ITfContext* context,
  TfClientId clientId,
  ITfComposition** activeComposition,
  const EngineDecision& decision
);

bool finishActiveComposition(
  ITfContext* context,
  TfClientId clientId,
  ITfComposition** activeComposition
);

void releaseActiveComposition(ITfComposition** activeComposition);

} // namespace lekh::tsf
