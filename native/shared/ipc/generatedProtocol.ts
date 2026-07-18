// Generated from lekh-keyboard-protocol.json. Do not edit.
export const IPC_SCHEMA_VERSION = 2 as const;
export const IPC_COMPATIBLE_SCHEMA_VERSIONS = [2] as const;
export const IPC_CLIENTS = ["windows-tsf","macos-imk","companion","daemon-test"] as const;
export const IPC_PROTOCOL_LIMITS = {
  "maximumFrameBytes": 65536,
  "maximumIdentifierLength": 256,
  "maximumTextLength": 16384,
  "maximumCompositionLength": 128,
  "maximumQueryLength": 1024,
  "maximumContextDomains": 32,
  "hotPathDeadlineMs": 50,
  "controlDeadlineMs": 5000,
  "maximumActiveConnections": 16,
  "maximumPendingRequestsPerConnection": 32,
  "maximumReplayEntriesPerClient": 256,
  "maximumClientInstances": 64,
  "maximumActiveSessions": 64,
  "clientIdleTtlMs": 1800000,
  "maximumCandidateResults": 8,
  "maximumProofHints": 8,
  "maximumDictionaryResults": 8,
  "maximumResponseListItems": 32
} as const;
export const IPC_MESSAGE_DESCRIPTORS = {
  "protocol.negotiate": {
    "sessionBound": false,
    "responseSessionEpoch": false,
    "deadlineClass": "control"
  },
  "health.check": {
    "sessionBound": false,
    "responseSessionEpoch": false,
    "deadlineClass": "control"
  },
  "engine.warm": {
    "sessionBound": false,
    "responseSessionEpoch": false,
    "deadlineClass": "control"
  },
  "session.begin": {
    "sessionBound": false,
    "responseSessionEpoch": true,
    "deadlineClass": "hotPath"
  },
  "session.processKeyStroke": {
    "sessionBound": true,
    "responseSessionEpoch": true,
    "deadlineClass": "hotPath"
  },
  "session.updateComposition": {
    "sessionBound": true,
    "responseSessionEpoch": true,
    "deadlineClass": "hotPath"
  },
  "session.commitCandidate": {
    "sessionBound": true,
    "responseSessionEpoch": true,
    "deadlineClass": "hotPath"
  },
  "session.commitRaw": {
    "sessionBound": true,
    "responseSessionEpoch": true,
    "deadlineClass": "hotPath"
  },
  "session.cancel": {
    "sessionBound": true,
    "responseSessionEpoch": true,
    "deadlineClass": "hotPath"
  },
  "session.end": {
    "sessionBound": true,
    "responseSessionEpoch": true,
    "deadlineClass": "hotPath"
  },
  "session.setMode": {
    "sessionBound": true,
    "responseSessionEpoch": true,
    "deadlineClass": "control"
  },
  "session.setLayout": {
    "sessionBound": true,
    "responseSessionEpoch": true,
    "deadlineClass": "control"
  },
  "suggestions.get": {
    "sessionBound": false,
    "responseSessionEpoch": false,
    "deadlineClass": "control"
  },
  "proofHints.get": {
    "sessionBound": false,
    "responseSessionEpoch": false,
    "deadlineClass": "control"
  },
  "dictionary.lookup": {
    "sessionBound": false,
    "responseSessionEpoch": false,
    "deadlineClass": "control"
  },
  "memory.learn": {
    "sessionBound": true,
    "responseSessionEpoch": true,
    "deadlineClass": "control"
  },
  "diagnostics.getMetrics": {
    "sessionBound": false,
    "responseSessionEpoch": false,
    "deadlineClass": "control"
  },
  "engine.shutdown": {
    "sessionBound": false,
    "responseSessionEpoch": false,
    "deadlineClass": "control"
  }
} as const;
export const IPC_MESSAGE_TYPES = Object.freeze(Object.keys(IPC_MESSAGE_DESCRIPTORS)) as readonly (keyof typeof IPC_MESSAGE_DESCRIPTORS)[];
export type GeneratedIpcMessageType = keyof typeof IPC_MESSAGE_DESCRIPTORS;
export const IPC_ERROR_DEFINITIONS = {
  "IPC_SCHEMA_INVALID": {
    "recoverable": true,
    "action": "passThrough"
  },
  "IPC_VERSION_UNSUPPORTED": {
    "recoverable": true,
    "action": "restartDaemon"
  },
  "IPC_NEGOTIATION_REQUIRED": {
    "recoverable": true,
    "action": "restartSession"
  },
  "IPC_DEADLINE_EXCEEDED": {
    "recoverable": true,
    "action": "passThrough"
  },
  "IPC_REPLAY_DETECTED": {
    "recoverable": true,
    "action": "restartSession"
  },
  "IPC_SEQUENCE_INVALID": {
    "recoverable": true,
    "action": "restartSession"
  },
  "IPC_SESSION_STALE": {
    "recoverable": true,
    "action": "restartSession"
  },
  "IPC_SESSION_UNKNOWN": {
    "recoverable": true,
    "action": "restartSession"
  },
  "IPC_QUEUE_FULL": {
    "recoverable": true,
    "action": "passThrough"
  },
  "IPC_PAYLOAD_TOO_LARGE": {
    "recoverable": true,
    "action": "passThrough"
  },
  "IPC_EMPTY_LINE": {
    "recoverable": true,
    "action": "retry"
  },
  "IPC_JSON_PARSE_FAILED": {
    "recoverable": true,
    "action": "retry"
  },
  "IPC_CLIENT_IDENTITY_REJECTED": {
    "recoverable": false,
    "action": "none"
  },
  "IPC_TIMEOUT": {
    "recoverable": true,
    "action": "passThrough"
  },
  "DAEMON_CLI_FAILED": {
    "recoverable": true,
    "action": "restartDaemon"
  },
  "DAEMON_DISPATCH_FAILED": {
    "recoverable": true,
    "action": "passThrough"
  },
  "NAMED_PIPE_REQUEST_FAILED": {
    "recoverable": true,
    "action": "restartDaemon"
  }
} as const;
export type IpcErrorCode = keyof typeof IPC_ERROR_DEFINITIONS;
export type IpcRecoveryAction = (typeof IPC_ERROR_DEFINITIONS)[IpcErrorCode]["action"];
