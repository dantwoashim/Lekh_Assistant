// Generated from lekh-keyboard-protocol.json. Do not edit.
import Foundation

public enum LekhIPCProtocolContract {
  public static let schemaVersion = 2
  public static let compatibleVersions = [2]
  public static let maximumFrameBytes = 65536
  public static let hotPathDeadlineMilliseconds = 50
  public static let maximumActiveConnections = 16
  public static let maximumPendingRequestsPerConnection = 32
  public static let maximumClientInstances = 64
  public static let clientIdleTtlMilliseconds = 1800000
}

public enum LekhIPCMessageType: String, CaseIterable, Sendable {
  case protocolNegotiate = "protocol.negotiate"
  case healthCheck = "health.check"
  case engineWarm = "engine.warm"
  case sessionBegin = "session.begin"
  case sessionProcessKeyStroke = "session.processKeyStroke"
  case sessionUpdateComposition = "session.updateComposition"
  case sessionCommitCandidate = "session.commitCandidate"
  case sessionCommitRaw = "session.commitRaw"
  case sessionCancel = "session.cancel"
  case sessionEnd = "session.end"
  case sessionSetMode = "session.setMode"
  case sessionSetLayout = "session.setLayout"
  case suggestionsGet = "suggestions.get"
  case proofHintsGet = "proofHints.get"
  case dictionaryLookup = "dictionary.lookup"
  case memoryLearn = "memory.learn"
  case diagnosticsGetMetrics = "diagnostics.getMetrics"
  case engineShutdown = "engine.shutdown"
}

public enum LekhIPCErrorCode: String, CaseIterable, Sendable {
  case ipcSchemaInvalid = "IPC_SCHEMA_INVALID"
  case ipcVersionUnsupported = "IPC_VERSION_UNSUPPORTED"
  case ipcNegotiationRequired = "IPC_NEGOTIATION_REQUIRED"
  case ipcDeadlineExceeded = "IPC_DEADLINE_EXCEEDED"
  case ipcReplayDetected = "IPC_REPLAY_DETECTED"
  case ipcSequenceInvalid = "IPC_SEQUENCE_INVALID"
  case ipcSessionStale = "IPC_SESSION_STALE"
  case ipcSessionUnknown = "IPC_SESSION_UNKNOWN"
  case ipcQueueFull = "IPC_QUEUE_FULL"
  case ipcPayloadTooLarge = "IPC_PAYLOAD_TOO_LARGE"
  case ipcEmptyLine = "IPC_EMPTY_LINE"
  case ipcJsonParseFailed = "IPC_JSON_PARSE_FAILED"
  case ipcClientIdentityRejected = "IPC_CLIENT_IDENTITY_REJECTED"
  case ipcTimeout = "IPC_TIMEOUT"
  case daemonCliFailed = "DAEMON_CLI_FAILED"
  case daemonDispatchFailed = "DAEMON_DISPATCH_FAILED"
  case namedPipeRequestFailed = "NAMED_PIPE_REQUEST_FAILED"
}
