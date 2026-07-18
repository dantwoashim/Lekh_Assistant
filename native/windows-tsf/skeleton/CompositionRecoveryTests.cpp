#include "CompositionRecovery.h"

#include <cstdlib>
#include <iostream>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

} // namespace

int main() {
  using lekh::tsf::CompositionTerminationDisposition;
  using lekh::tsf::PhysicalKeyConservationLedger;
  using lekh::tsf::PhysicalKeyDisposition;
  using lekh::tsf::physicalKeyConservedExactlyOnce;
  using lekh::tsf::recordPhysicalKey;
  using lekh::tsf::shouldDetachDaemonAfterTermination;

  for (const PhysicalKeyDisposition disposition : {
      PhysicalKeyDisposition::Passed,
      PhysicalKeyDisposition::Materialized
    }) {
    require(
      physicalKeyConservedExactlyOnce(recordPhysicalKey(disposition)),
      "a valid physical-key terminal state violated exact conservation"
    );
  }
  require(
    !physicalKeyConservedExactlyOnce(PhysicalKeyConservationLedger{}),
    "a dropped physical key was accepted"
  );
  require(
    !physicalKeyConservedExactlyOnce(PhysicalKeyConservationLedger{1, 1}),
    "a duplicated pass-and-materialize key was accepted"
  );

  require(
    shouldDetachDaemonAfterTermination(CompositionTerminationDisposition::DetachDaemonState),
    "host-initiated termination did not detach daemon state"
  );
  require(
    !shouldDetachDaemonAfterTermination(CompositionTerminationDisposition::PreserveAppliedText),
    "service-owned terminal text unexpectedly detached daemon state"
  );

  std::cout << "TSF composition recovery tests passed\n";
  return 0;
}
