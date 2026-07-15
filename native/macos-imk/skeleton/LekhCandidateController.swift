import Foundation
import InputMethodKit

public struct LekhCandidateState: Equatable {
  public let candidates: [String]
  public let displayItems: [LekhCandidateDisplayItem]
  /// `nil` is the intentional passive state: candidates are available, but the
  /// user has not navigated to or explicitly chosen one. A passive first row
  /// must never look selected because delimiter behavior is engine-authorized
  /// independently of visual list position.
  public let selectedIndex: Int?

  public static let empty = LekhCandidateState(candidates: [], displayItems: [], selectedIndex: nil)
}

public final class LekhCandidateController {
  private var state = LekhCandidateState.empty

  public init() {}

  public func updateCandidates(
    _ candidates: [String],
    rawBuffer: String = "",
    modeLabel _: String = "",
    selectedIndex: Int? = nil
  ) {
    let displayItems = candidates.map { candidate in
      Self.displayItem(for: candidate, rawBuffer: rawBuffer)
    }
    let retainedIndex: Int?
    if let selectedIndex {
      retainedIndex = Self.validated(selectedIndex, candidateCount: candidates.count)
    } else if let selected = selectedCandidate(),
              let index = candidates.firstIndex(of: selected) {
      retainedIndex = index
    } else {
      // A new candidate list must never invent a selection. Retain only a
      // stable, user-selected candidate by text; otherwise remain passive.
      retainedIndex = nil
    }
    state = LekhCandidateState(
      candidates: candidates,
      displayItems: displayItems,
      selectedIndex: retainedIndex
    )
  }

  public func currentState() -> LekhCandidateState {
    state
  }

  public func selectedCandidate() -> String? {
    guard let selectedIndex = state.selectedIndex,
          state.candidates.indices.contains(selectedIndex) else { return nil }
    return state.candidates[selectedIndex]
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

  public func clearSelection() {
    guard state.selectedIndex != nil else { return }
    state = LekhCandidateState(
      candidates: state.candidates,
      displayItems: state.displayItems,
      selectedIndex: nil
    )
  }

  @discardableResult
  public func moveSelection(delta: Int) -> String? {
    guard !state.candidates.isEmpty else { return nil }
    let target: Int
    if let selectedIndex = state.selectedIndex {
      // Candidate navigation is cyclic, matching system input-source menus and
      // avoiding a silent dead end at either edge of the list.
      target = Self.wrapped(selectedIndex + delta, candidateCount: state.candidates.count)
    } else {
      target = delta < 0 ? state.candidates.count - 1 : 0
    }
    return select(index: target)
  }

  @discardableResult
  public func movePage(delta: Int, pageSize: Int) -> String? {
    guard !state.candidates.isEmpty, pageSize > 0 else { return nil }
    let pageCount = Int(ceil(Double(state.candidates.count) / Double(pageSize)))
    let currentPage = (state.selectedIndex ?? 0) / pageSize
    let targetPage = min(max(currentPage + delta, 0), max(pageCount - 1, 0))
    let positionWithinPage = (state.selectedIndex ?? 0) % pageSize
    return select(index: min(targetPage * pageSize + positionWithinPage, state.candidates.count - 1))
  }

  public func selectBoundary(first: Bool) -> String? {
    guard !state.candidates.isEmpty else { return nil }
    return select(index: first ? 0 : state.candidates.count - 1)
  }

  public func indexForShortcut(_ number: Int, pageSize: Int) -> Int? {
    guard number > 0, pageSize > 0, number <= pageSize else { return nil }
    let page = (state.selectedIndex ?? 0) / pageSize
    let index = page * pageSize + number - 1
    guard state.candidates.indices.contains(index) else { return nil }
    return index
  }

  public func candidateForShortcut(_ number: Int, pageSize: Int = 8) -> String? {
    guard let index = indexForShortcut(number, pageSize: pageSize) else { return nil }
    return state.candidates[index]
  }

  private static func displayItem(for candidate: String, rawBuffer: String) -> LekhCandidateDisplayItem {
    let rawHasDevanagari = rawBuffer.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil
    let candidateHasDevanagari = candidate.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil
    let candidateIsRoman = candidate.range(of: #"\p{Latin}"#, options: .regularExpression) != nil && !candidateHasDevanagari

    if rawHasDevanagari, candidate != rawBuffer {
      return LekhCandidateDisplayItem(
        text: candidate,
        label: nil,
        badge: LekhL10n.text("candidate.badge.fix"),
        explanation: "\(rawBuffer) → \(candidate). \(LekhL10n.text("candidate.explain.fix"))"
      )
    }

    if candidateIsRoman {
      return LekhCandidateDisplayItem(
        text: candidate,
        label: nil,
        badge: LekhL10n.text("candidate.badge.roman"),
        explanation: LekhL10n.text("candidate.explain.roman")
      )
    }

    return LekhCandidateDisplayItem(
      text: candidate,
      label: nil,
      badge: candidateHasDevanagari ? LekhL10n.text("candidate.badge.unicode") : LekhL10n.text("candidate.badge.helper"),
      explanation: candidateHasDevanagari
        ? LekhL10n.text("candidate.explain.unicode")
        : LekhL10n.text("candidate.explain.roman")
    )
  }

  private static func validated(_ selectedIndex: Int, candidateCount: Int) -> Int? {
    guard candidateCount > 0,
          (0..<candidateCount).contains(selectedIndex) else { return nil }
    return selectedIndex
  }

  private static func wrapped(_ selectedIndex: Int, candidateCount: Int) -> Int {
    guard candidateCount > 0 else { return 0 }
    return (selectedIndex % candidateCount + candidateCount) % candidateCount
  }
}
