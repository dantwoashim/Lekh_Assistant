#include "DaemonRetirement.h"

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <thread>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

} // namespace

int main() {
  require(
    lekh::tsf::retirementCompletionTokenMatches(42, 42),
    "current completion token was rejected"
  );
  require(
    !lekh::tsf::retirementCompletionTokenMatches(41, 42),
    "stale HWND completion token was accepted"
  );
  require(
    !lekh::tsf::retirementCompletionTokenMatches(0, 0),
    "destroyed completion window accepted an empty token"
  );

  lekh::tsf::DaemonRetirementTracker tracker;
  require(!tracker.blocksNewSessions(), "new retirement tracker was unexpectedly blocked");
  require(tracker.admitRetirement(), "retirement tracker rejected its first retirement");
  require(tracker.blocksNewSessions(), "pending retirement allowed a reordered session");
  require(!tracker.admitRetirement(), "retirement tracker admitted concurrent sequence lanes");
  tracker.finishRetirement(true);
  require(!tracker.blocksNewSessions(), "exact retirement acknowledgement did not release the barrier");

  require(tracker.admitRetirement(), "second retirement was not admitted");
  tracker.finishRetirement(false);
  require(
    tracker.state() == lekh::tsf::DaemonRetirementState::PurgePending,
    "retirement exhaustion did not enter client-purge state"
  );
  tracker.finishPurge(false);
  require(
    tracker.state() == lekh::tsf::DaemonRetirementState::Quarantined,
    "failed client purge was forgotten"
  );
  require(tracker.beginQuarantinedPurge(), "quarantined client could not schedule reconciliation");
  tracker.finishPurge(true);
  require(!tracker.blocksNewSessions(), "acknowledged client purge did not release the session barrier");

  require(tracker.admitRetirement(), "admission-failure fixture was not admitted");
  tracker.failRetirementAdmission();
  require(
    tracker.state() == lekh::tsf::DaemonRetirementState::Quarantined,
    "worker admission failure did not fail closed"
  );

  std::size_t attempts = 0;
  const auto startedAt = std::chrono::steady_clock::now();
  const bool delayedDelivery = lekh::tsf::deliverDaemonRetirement(
    [&](std::uint32_t timeoutMs) {
      ++attempts;
      require(timeoutMs >= 100, "retirement delivery regressed to an impractical deadline");
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
      return true;
    },
    [](std::size_t) {}
  );
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::steady_clock::now() - startedAt
  );
  require(delayedDelivery, "a response slower than one millisecond was treated as undeliverable");
  require(attempts == 1, "successful retirement delivery was retried");
  require(elapsed.count() >= 4, "delayed retirement fixture did not exercise the intended path");

  attempts = 0;
  std::size_t pauses = 0;
  const bool exhausted = lekh::tsf::deliverDaemonRetirement(
    [&](std::uint32_t) {
      ++attempts;
      return false;
    },
    [&](std::size_t) { ++pauses; }
  );
  require(!exhausted, "exhausted retirement delivery reported success");
  require(attempts == lekh::tsf::kMaximumRetirementAttempts, "retirement retry count is not bounded");
  require(pauses + 1 == attempts, "retirement backoff count is incorrect");

  std::cout << "TSF daemon retirement tests passed\n";
  return 0;
}
