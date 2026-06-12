import AppKit
import Foundation

public final class LekhLatencyRingBuffer {
  // Privacy contract: text and keystroke values are not recorded.
  private struct Sample {
    let route: String
    let durationMicros: UInt64
    let candidateCount: Int
    let handled: Bool
  }

  public static var diagnosticsEnabled: Bool {
    let environment = ProcessInfo.processInfo.environment
    return environment["LEKH_IMK_DIAGNOSTICS"] == "1" || environment["LEKH_IMK_DEBUG_LOG"] == "1"
  }

  private let capacity: Int
  private let lock = NSLock()
  private var samples: [Sample] = []
  private var nextIndex = 0

  public init(capacity: Int = 256) {
    self.capacity = max(16, capacity)
  }

  public func record(route: String, durationNanoseconds: UInt64, candidateCount: Int, handled: Bool) {
    guard Self.diagnosticsEnabled else { return }
    let safeRoute = route
      .split(separator: ".")
      .map { $0.filter { character in character.isLetter || character.isNumber || character == "_" || character == "-" } }
      .joined(separator: ".")
    let sample = Sample(
      route: safeRoute,
      durationMicros: durationNanoseconds / 1_000,
      candidateCount: candidateCount,
      handled: handled
    )
    lock.lock()
    defer { lock.unlock() }
    if samples.count < capacity {
      samples.append(sample)
      return
    }
    samples[nextIndex] = sample
    nextIndex = (nextIndex + 1) % capacity
  }

  public func summary() -> String {
    lock.lock()
    let snapshot = samples
    lock.unlock()
    guard !snapshot.isEmpty else {
      return "latencySamples=0"
    }

    let sorted = snapshot.map(\.durationMicros).sorted()
    let p50 = percentile(sorted, 0.50)
    let p95 = percentile(sorted, 0.95)
    let p99 = percentile(sorted, 0.99)
    let maxValue = sorted.last ?? 0
    let handledCount = snapshot.filter(\.handled).count
    let maxCandidates = snapshot.map(\.candidateCount).max() ?? 0
    let routes = Dictionary(grouping: snapshot, by: \.route)
      .map { "\($0.key):\($0.value.count)" }
      .sorted()
      .joined(separator: ", ")
    return [
      "latencySamples=\(snapshot.count)",
      "handled=\(handledCount)",
      "p50=\(p50)us",
      "p95=\(p95)us",
      "p99=\(p99)us",
      "max=\(maxValue)us",
      "maxCandidates=\(maxCandidates)",
      "routes=\(routes)"
    ].joined(separator: "\n")
  }

  private func percentile(_ sorted: [UInt64], _ p: Double) -> UInt64 {
    guard !sorted.isEmpty else { return 0 }
    let index = min(sorted.count - 1, max(0, Int(Double(sorted.count - 1) * p)))
    return sorted[index]
  }
}
