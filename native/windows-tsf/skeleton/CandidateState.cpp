#include "CandidateState.h"

#include <algorithm>
#include <string>

namespace lekh::tsf {
namespace {

std::optional<std::size_t> digitIndex(CandidateCommand command) {
  if (command < CandidateCommand::Digit1 || command > CandidateCommand::Digit8) return std::nullopt;
  return static_cast<std::size_t>(command) - static_cast<std::size_t>(CandidateCommand::Digit1);
}

} // namespace

void CandidateState::update(std::vector<Candidate> candidates, bool shouldShow) {
  const Candidate* current = selected();
  const std::wstring selectedId = current ? current->id : L"";
  if (candidates.size() > kMaximumCandidateCount) candidates.resize(kMaximumCandidateCount);
  candidates_ = std::move(candidates);
  visible_ = shouldShow && !candidates_.empty();
  selectedIndex_ = 0;
  if (!visible_ || selectedId.empty()) return;
  const auto prior = std::find_if(candidates_.begin(), candidates_.end(), [&](const Candidate& candidate) {
    return candidate.id == selectedId;
  });
  if (prior != candidates_.end()) {
    selectedIndex_ = static_cast<std::size_t>(std::distance(candidates_.begin(), prior));
  }
}

void CandidateState::reset() {
  candidates_.clear();
  selectedIndex_ = 0;
  visible_ = false;
}

CandidateInteraction CandidateState::handle(CandidateCommand command) {
  if (!visible_ || candidates_.empty()) return {};
  if (command == CandidateCommand::Previous) {
    selectedIndex_ = selectedIndex_ == 0 ? candidates_.size() - 1 : selectedIndex_ - 1;
    return {CandidateInteractionType::SelectionChanged, candidates_[selectedIndex_]};
  }
  if (command == CandidateCommand::Next) {
    selectedIndex_ = (selectedIndex_ + 1) % candidates_.size();
    return {CandidateInteractionType::SelectionChanged, candidates_[selectedIndex_]};
  }
  if (command == CandidateCommand::ConfirmWithSpace || command == CandidateCommand::ConfirmWithEnter) {
    return {CandidateInteractionType::CommitRequested, candidates_[selectedIndex_]};
  }

  const std::optional<std::size_t> requested = digitIndex(command);
  if (!requested) return {};
  const std::wstring shortcut = std::to_wstring(*requested + 1);
  const auto exact = std::find_if(candidates_.begin(), candidates_.end(), [&](const Candidate& candidate) {
    return candidate.shortcut == shortcut;
  });
  if (exact != candidates_.end()) {
    selectedIndex_ = static_cast<std::size_t>(std::distance(candidates_.begin(), exact));
  } else if (*requested < candidates_.size()) {
    selectedIndex_ = *requested;
  } else {
    return {};
  }
  return {CandidateInteractionType::CommitRequested, candidates_[selectedIndex_]};
}

bool CandidateState::visible() const {
  return visible_;
}

std::size_t CandidateState::selectedIndex() const {
  return selectedIndex_;
}

const std::vector<Candidate>& CandidateState::candidates() const {
  return candidates_;
}

const Candidate* CandidateState::selected() const {
  return visible_ && selectedIndex_ < candidates_.size() ? &candidates_[selectedIndex_] : nullptr;
}

} // namespace lekh::tsf
