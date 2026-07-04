import Foundation
import InputMethodKit

public struct LekhCandidateState: Equatable {
  public let candidates: [String]
  public let displayItems: [LekhCandidateDisplayItem]
  public let selectedIndex: Int

  public static let empty = LekhCandidateState(candidates: [], displayItems: [], selectedIndex: 0)
}

public final class LekhCandidateController {
  private var state = LekhCandidateState.empty

  public init() {}

  public func updateCandidates(
    _ candidates: [String],
    rawBuffer: String = "",
    modeLabel: String = "",
    selectedIndex: Int? = nil
  ) {
    let displayItems = candidates.map { candidate in
      Self.displayItem(for: candidate, rawBuffer: rawBuffer, modeLabel: modeLabel)
    }
    let retainedIndex: Int
    if let selectedIndex {
      retainedIndex = selectedIndex
    } else if let selected = selectedCandidate(),
              let index = candidates.firstIndex(of: selected) {
      retainedIndex = index
    } else {
      retainedIndex = state.selectedIndex
    }
    state = LekhCandidateState(
      candidates: candidates,
      displayItems: displayItems,
      selectedIndex: Self.clamped(retainedIndex, candidateCount: candidates.count)
    )
  }

  public func currentState() -> LekhCandidateState {
    state
  }

  public func selectedCandidate() -> String? {
    guard state.candidates.indices.contains(state.selectedIndex) else { return nil }
    return state.candidates[state.selectedIndex]
  }

  @discardableResult
  public func select(index: Int) -> String? {
    guard state.candidates.indices.contains(index) else { return nil }
    state = LekhCandidateState(
      candidates: state.candidates,
      displayItems: state.displayItems,
      selectedIndex: index
    )
    return state.candidates[index]
  }

  @discardableResult
  public func moveSelection(delta: Int) -> String? {
    guard !state.candidates.isEmpty else { return nil }
    return select(index: Self.clamped(state.selectedIndex + delta, candidateCount: state.candidates.count))
  }

  public func candidateForShortcut(_ number: Int) -> String? {
    let index = number - 1
    guard state.candidates.indices.contains(index) else { return nil }
    return state.candidates[index]
  }

  private static func displayItem(for candidate: String, rawBuffer: String, modeLabel: String) -> LekhCandidateDisplayItem {
    let rawHasDevanagari = rawBuffer.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil
    let candidateHasDevanagari = candidate.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil
    let candidateIsRoman = candidate.range(of: #"\p{Latin}"#, options: .regularExpression) != nil && !candidateHasDevanagari

    if rawHasDevanagari, candidate != rawBuffer {
      return LekhCandidateDisplayItem(
        text: candidate,
        label: rawBuffer.isEmpty ? nil : rawBuffer,
        badge: LekhL10n.text("candidate.badge.fix"),
        explanation: "\(rawBuffer) → \(candidate). \(LekhL10n.text("candidate.explain.fix"))"
      )
    }

    let lowercasedMode = modeLabel.lowercased()
    if (lowercasedMode.contains("traditional") && lowercasedMode.contains("romanized")) || candidateIsRoman {
      return LekhCandidateDisplayItem(
        text: candidate,
        label: rawBuffer.isEmpty ? nil : rawBuffer,
        badge: LekhL10n.text("candidate.badge.roman"),
        explanation: LekhL10n.text("candidate.explain.roman")
      )
    }

    return LekhCandidateDisplayItem(
      text: candidate,
      label: rawBuffer.isEmpty ? nil : rawBuffer,
      badge: candidateHasDevanagari ? LekhL10n.text("candidate.badge.unicode") : LekhL10n.text("candidate.badge.helper"),
      explanation: candidateHasDevanagari
        ? LekhL10n.text("candidate.explain.unicode")
        : LekhL10n.text("candidate.explain.roman")
    )
  }

  private static func clamped(_ selectedIndex: Int, candidateCount: Int) -> Int {
    min(max(selectedIndex, 0), max(candidateCount - 1, 0))
  }
}
