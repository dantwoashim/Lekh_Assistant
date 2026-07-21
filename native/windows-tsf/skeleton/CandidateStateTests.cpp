#include "CandidateState.h"

#include <cstdlib>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

lekh::tsf::Candidate candidate(const wchar_t* id, const wchar_t* text, const wchar_t* shortcut) {
  return {id, text, L"label", shortcut};
}

void requireCommit(
  const lekh::tsf::CandidateInteraction& interaction,
  const wchar_t* expectedId,
  const char* message
) {
  require(interaction.type == lekh::tsf::CandidateInteractionType::CommitRequested &&
    interaction.candidate && interaction.candidate->id == expectedId, message);
}

} // namespace

int main() {
  using namespace lekh::tsf;

  CandidateState state;
  require(!state.visible(), "fresh candidate state was visible");
  require(state.handle(CandidateCommand::Next).type == CandidateInteractionType::Ignored,
    "hidden candidate state consumed navigation");

  std::vector<Candidate> initial{
    candidate(L"one", L"एक", L"1"),
    candidate(L"two", L"दुई", L"2"),
    candidate(L"three", L"तीन", L"3")
  };
  state.update(initial, true);
  require(state.visible() && state.selectedIndex() == 0 && state.selected()->id == L"one",
    "candidate list did not select its first row");

  require(state.handle(CandidateCommand::Next).type == CandidateInteractionType::SelectionChanged &&
    state.selected()->id == L"two", "Down did not select the next candidate");
  require(state.handle(CandidateCommand::Previous).type == CandidateInteractionType::SelectionChanged &&
    state.selected()->id == L"one", "Up did not select the previous candidate");
  state.handle(CandidateCommand::Previous);
  require(state.selected()->id == L"three", "Up did not wrap to the last candidate");
  state.handle(CandidateCommand::Next);
  require(state.selected()->id == L"one", "Down did not wrap to the first candidate");

  requireCommit(state.handle(CandidateCommand::Digit3), L"three", "digit shortcut did not commit its row");
  requireCommit(state.handle(CandidateCommand::ConfirmWithSpace), L"three", "Space did not commit the selection");
  requireCommit(state.handle(CandidateCommand::ConfirmWithEnter), L"three", "Enter did not commit the selection");

  state.update({
    candidate(L"zero", L"शून्य", L"1"),
    candidate(L"three", L"तीन", L"2")
  }, true);
  require(state.selectedIndex() == 1 && state.selected()->id == L"three",
    "candidate refresh did not preserve the selected identifier");
  requireCommit(state.handle(CandidateCommand::Digit2), L"three", "refreshed digit shortcut did not commit");
  require(state.handle(CandidateCommand::Digit8).type == CandidateInteractionType::Ignored,
    "missing digit shortcut was consumed");

  state.update(initial, false);
  require(!state.visible() && state.handle(CandidateCommand::ConfirmWithEnter).type == CandidateInteractionType::Ignored,
    "hidden candidate list consumed confirmation");
  state.reset();
  require(state.candidates().empty() && !state.visible(), "candidate reset retained state");

  std::cout << "Candidate state navigation tests passed\n";
  return 0;
}
