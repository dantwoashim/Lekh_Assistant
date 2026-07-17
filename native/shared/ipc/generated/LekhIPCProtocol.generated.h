// Generated from lekh-keyboard-protocol.json. Do not edit.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace lekh::ipc {
inline constexpr std::uint32_t kSchemaVersion = 1;
inline constexpr std::size_t kMaximumFrameBytes = 65536;
inline constexpr std::uint32_t kHotPathDeadlineMilliseconds = 50;
inline constexpr std::size_t kMaximumPendingRequestsPerConnection = 32;
inline constexpr std::array<std::string_view, 17> kMessageTypes = {
  "health.check",
  "engine.warm",
  "session.begin",
  "session.processKeyStroke",
  "session.updateComposition",
  "session.commitCandidate",
  "session.commitRaw",
  "session.cancel",
  "session.end",
  "session.setMode",
  "session.setLayout",
  "suggestions.get",
  "proofHints.get",
  "dictionary.lookup",
  "memory.learn",
  "diagnostics.getMetrics",
  "engine.shutdown"
};
inline constexpr std::array<std::string_view, 17> kErrorCodes = {
  "IPC_SCHEMA_INVALID",
  "IPC_VERSION_UNSUPPORTED",
  "IPC_NEGOTIATION_REQUIRED",
  "IPC_DEADLINE_EXCEEDED",
  "IPC_REPLAY_DETECTED",
  "IPC_SEQUENCE_INVALID",
  "IPC_SESSION_STALE",
  "IPC_SESSION_UNKNOWN",
  "IPC_QUEUE_FULL",
  "IPC_PAYLOAD_TOO_LARGE",
  "IPC_EMPTY_LINE",
  "IPC_JSON_PARSE_FAILED",
  "IPC_CLIENT_IDENTITY_REJECTED",
  "IPC_TIMEOUT",
  "DAEMON_CLI_FAILED",
  "DAEMON_DISPATCH_FAILED",
  "NAMED_PIPE_REQUEST_FAILED"
};
} // namespace lekh::ipc
