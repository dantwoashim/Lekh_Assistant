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
    selectedIndex: Int = 0
  ) {
    let displayItems = candidates.map { candidate in
      Self.displayItem(for: candidate, rawBuffer: rawBuffer, modeLabel: modeLabel)
    }
    state = LekhCandidateState(
      candidates: candidates,
      displayItems: displayItems,
      selectedIndex: min(max(selectedIndex, 0), max(candidates.count - 1, 0))
    )
  }

  public func currentState() -> LekhCandidateState {
    state
  }

  public func selectedCandidate() -> String? {
    guard state.candidates.indices.contains(state.selectedIndex) else { return nil }
    return state.candidates[state.selectedIndex]
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

    if modeLabel.lowercased().contains("traditional-romanized") || candidateIsRoman {
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
}
