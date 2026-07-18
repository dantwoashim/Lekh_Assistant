#pragma once

#include <cstdint>
#include <optional>
#include <string>

namespace lekh::tsf {

enum class EngineAction {
  PassThrough,
  Compose,
  Commit,
  Cancel
};

enum class SessionCommand {
  Cancel,
  End
};

struct KeyEvent {
  std::wstring key;
  std::wstring code;
  bool shift = false;
  bool ctrl = false;
  bool alt = false;
  bool meta = false;
  bool repeat = false;
  std::uint64_t timestamp = 0;
  std::uint32_t nativeCode = 0;
};

struct RequestMetadata {
  std::wstring requestId;
  std::wstring clientInstanceId;
  std::uint64_t requestSequence = 0;
  std::uint64_t sentAt = 0;
  std::uint64_t deadlineAt = 0;
};

struct NegotiatedProtocol {
  std::wstring serverInstanceId;
  std::uint32_t selectedVersion = 0;
};

struct EngineWarmResult {
  bool ready = false;
  bool partial = false;
};

struct SessionHandle {
  std::wstring sessionId;
  std::uint64_t sessionEpoch = 0;
};

struct EngineDecision {
  EngineAction action = EngineAction::PassThrough;
  std::wstring compositionText;
  std::wstring displayText;
  std::wstring committedText;
  std::size_t caret = 0;
};

std::wstring makeProtocolNegotiationRequest(const RequestMetadata& metadata);

std::wstring makeEngineWarmRequest(const RequestMetadata& metadata);

std::wstring makeBeginSessionRequest(const RequestMetadata& metadata);

std::wstring makeProcessKeyRequest(
  const RequestMetadata& metadata,
  const SessionHandle& session,
  const KeyEvent& key
);

std::wstring makeSessionRequest(
  const RequestMetadata& metadata,
  const SessionHandle& session,
  SessionCommand command
);

std::optional<NegotiatedProtocol> parseProtocolNegotiationResponse(
  const std::wstring& response,
  const RequestMetadata& request
);

std::optional<EngineWarmResult> parseEngineWarmResponse(
  const std::wstring& response,
  const RequestMetadata& request,
  const std::wstring& expectedServerInstanceId
);

std::optional<SessionHandle> parseBeginSessionResponse(
  const std::wstring& response,
  const RequestMetadata& request,
  const std::wstring& expectedServerInstanceId
);

std::optional<EngineDecision> parseProcessKeyResponse(
  const std::wstring& response,
  const RequestMetadata& request,
  const std::wstring& expectedServerInstanceId,
  const SessionHandle& expectedSession,
  const KeyEvent& expectedKey,
  const std::wstring& expectedCompositionText
);

bool parseSessionResponse(
  const std::wstring& response,
  const RequestMetadata& request,
  const std::wstring& expectedServerInstanceId,
  const SessionHandle& expectedSession,
  SessionCommand command
);

} // namespace lekh::tsf
