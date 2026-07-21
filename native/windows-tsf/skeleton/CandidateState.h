#pragma once

#include "TsfProtocol.h"

#include <cstddef>
#include <optional>
#include <vector>

namespace lekh::tsf {

enum class CandidateCommand {
  Previous,
  Next,
  ConfirmWithSpace,
  ConfirmWithEnter,
  Digit1,
  Digit2,
  Digit3,
  Digit4,
  Digit5,
  Digit6,
  Digit7,
  Digit8
};

enum class CandidateInteractionType {
  Ignored,
  SelectionChanged,
  CommitRequested
};

struct CandidateInteraction {
  CandidateInteractionType type = CandidateInteractionType::Ignored;
  std::optional<Candidate> candidate;
};

class CandidateState {
public:
  void update(std::vector<Candidate> candidates, bool shouldShow);
  void reset();
  CandidateInteraction handle(CandidateCommand command);

  bool visible() const;
  std::size_t selectedIndex() const;
  const std::vector<Candidate>& candidates() const;
  const Candidate* selected() const;

private:
  std::vector<Candidate> candidates_;
  std::size_t selectedIndex_ = 0;
  bool visible_ = false;
};

} // namespace lekh::tsf
