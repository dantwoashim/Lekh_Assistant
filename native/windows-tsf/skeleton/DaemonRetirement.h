#pragma once

#include <cstddef>
#include <cstdint>
#include <mutex>

namespace lekh::tsf {

constexpr std::uint32_t kRetirementAttemptTimeoutMilliseconds = 100;
constexpr std::uint32_t kRetirementLogicalDeadlineMilliseconds = 5000;
constexpr std::size_t kMaximumRetirementAttempts = 3;
constexpr long kMaximumPendingRetirements = 64;

enum class DaemonRetirementState {
  Ready,
  RetirementPending,
  PurgePending,
  Quarantined
};

constexpr bool retirementCompletionTokenMatches(
  std::uint64_t postedToken,
  std::uint64_t activeToken
) {
  return activeToken != 0 && postedToken == activeToken;
}

class DaemonRetirementTracker final {
public:
  bool admitRetirement() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_ != DaemonRetirementState::Ready) return false;
    state_ = DaemonRetirementState::RetirementPending;
    return true;
  }

  void finishRetirement(bool acknowledged) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_ != DaemonRetirementState::RetirementPending) return;
    state_ = acknowledged
      ? DaemonRetirementState::Ready
      : DaemonRetirementState::PurgePending;
  }

  void failRetirementAdmission() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_ == DaemonRetirementState::RetirementPending) {
      state_ = DaemonRetirementState::Quarantined;
    }
  }

  void finishPurge(bool acknowledged) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_ != DaemonRetirementState::PurgePending) return;
    state_ = acknowledged
      ? DaemonRetirementState::Ready
      : DaemonRetirementState::Quarantined;
  }

  bool beginQuarantinedPurge() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_ != DaemonRetirementState::Quarantined) return false;
    state_ = DaemonRetirementState::PurgePending;
    return true;
  }

  DaemonRetirementState state() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return state_;
  }

  bool blocksNewSessions() const {
    return state() != DaemonRetirementState::Ready;
  }

private:
  mutable std::mutex mutex_;
  DaemonRetirementState state_ = DaemonRetirementState::Ready;
};

template <typename Attempt, typename Pause>
bool deliverDaemonRetirement(Attempt&& attempt, Pause&& pause) {
  for (std::size_t index = 0; index < kMaximumRetirementAttempts; ++index) {
    if (attempt(kRetirementAttemptTimeoutMilliseconds)) return true;
    if (index + 1 < kMaximumRetirementAttempts) pause(index);
  }
  return false;
}

} // namespace lekh::tsf
