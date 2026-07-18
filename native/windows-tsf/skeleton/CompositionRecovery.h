#pragma once

namespace lekh::tsf {

enum class PhysicalKeyDisposition {
  Passed,
  Materialized
};

struct PhysicalKeyConservationLedger {
  unsigned int passed = 0;
  unsigned int materialized = 0;
};

constexpr PhysicalKeyConservationLedger recordPhysicalKey(
  PhysicalKeyDisposition disposition
) {
  return {
    disposition == PhysicalKeyDisposition::Passed ? 1u : 0u,
    disposition == PhysicalKeyDisposition::Materialized ? 1u : 0u
  };
}

constexpr bool physicalKeyConservedExactlyOnce(
  const PhysicalKeyConservationLedger& ledger
) {
  return ledger.passed + ledger.materialized == 1;
}

enum class CompositionTerminationDisposition {
  DetachDaemonState,
  PreserveAppliedText
};

constexpr bool shouldDetachDaemonAfterTermination(CompositionTerminationDisposition disposition) {
  return disposition == CompositionTerminationDisposition::DetachDaemonState;
}

} // namespace lekh::tsf
