import Foundation

public let lekhXpcServiceName = "com.lekh.keyboard.EngineXPC"
public let lekhHotPathTimeoutMilliseconds = 50

public enum LekhXpcStatus: Equatable {
  case available
  case unavailable
  case timedOut
}

public struct LekhXpcRequestEnvelope: Equatable {
  public let type: String
  public let sessionId: String
  public let payload: [String: String]
  public let timeoutMilliseconds: Int
}

public protocol LekhEngineClient {
  func processKey(_ key: String, sessionId: String, timeoutMilliseconds: Int) -> LekhInputDecision
}

public final class LekhXpcEngineClient: LekhEngineClient {
  public init() {}

  public func processKey(_ key: String, sessionId: String, timeoutMilliseconds: Int) -> LekhInputDecision {
    let _ = makeProcessKeyStrokeRequest(key: key, sessionId: sessionId, timeoutMilliseconds: timeoutMilliseconds)
    return LekhInputDecision.passThrough
  }

  public func makeProcessKeyStrokeRequest(
    key: String,
    sessionId: String,
    timeoutMilliseconds: Int = lekhHotPathTimeoutMilliseconds
  ) -> LekhXpcRequestEnvelope {
    LekhXpcRequestEnvelope(
      type: "session.processKeyStroke",
      sessionId: sessionId,
      payload: ["key": key],
      timeoutMilliseconds: timeoutMilliseconds
    )
  }
}

public final class LekhStaticProofEngineClient: LekhEngineClient {
  public init() {}

  public func processKey(_ key: String, sessionId: String, timeoutMilliseconds: Int) -> LekhInputDecision {
    if key == "k" || key == "K" {
      return LekhInputDecision(
        handled: true,
        markedText: "क",
        committedText: nil,
        candidates: ["क"],
        shouldCancel: false,
        shouldPassThrough: false
      )
    }

    if key == "\r" || key == "\n" {
      return LekhInputDecision(
        handled: true,
        markedText: nil,
        committedText: "क",
        candidates: [],
        shouldCancel: false,
        shouldPassThrough: false
      )
    }

    if key == "\u{1b}" {
      return LekhInputDecision(
        handled: true,
        markedText: nil,
        committedText: nil,
        candidates: [],
        shouldCancel: true,
        shouldPassThrough: false
      )
    }

    return .passThrough
  }
}
