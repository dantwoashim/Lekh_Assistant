import Foundation
import InputMethodKit

public struct LekhCandidateState: Equatable {
  public let candidates: [String]
  public let selectedIndex: Int

  public static let empty = LekhCandidateState(candidates: [], selectedIndex: 0)
}

public final class LekhCandidateController {
  private var state = LekhCandidateState.empty

  public init() {}

  public func updateCandidates(_ candidates: [String]) {
    state = LekhCandidateState(candidates: candidates, selectedIndex: 0)
  }

  public func currentState() -> LekhCandidateState {
    state
  }

  public func selectedCandidate() -> String? {
    guard state.candidates.indices.contains(state.selectedIndex) else { return nil }
    return state.candidates[state.selectedIndex]
  }
}
