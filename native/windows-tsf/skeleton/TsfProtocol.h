#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

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

enum class RequestDeadlineClass {
  HotPath,
  Control
};

struct RequestTiming {
  RequestDeadlineClass deadlineClass = RequestDeadlineClass::HotPath;
  std::uint64_t deadlineAt = 0;
  bool hasValidDeadline = false;
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

struct SessionHandle {
  std::wstring sessionId;
  std::uint64_t sessionEpoch = 0;
};

struct BeginSessionOptions {
  std::wstring mode = L"romanized-traditional";
  bool proofreadAsYouTypeEnabled = true;
  bool personalizationEnabled = false;
  bool nextWordPredictionEnabled = true;
};

inline constexpr std::size_t kMaximumCandidateCount = 8;

struct Candidate {
  std::wstring id;
  std::wstring text;
  std::wstring label;
  std::wstring shortcut;
};

struct EngineDecision {
  EngineAction action = EngineAction::PassThrough;
  std::wstring compositionText;
  std::wstring displayText;
  std::wstring inlineCompletionText;
  std::wstring inlineCompletionDisplayText;
  std::wstring committedText;
  std::size_t caret = 0;
  std::vector<Candidate> candidates;
  bool shouldShowCandidateUi = false;
  std::uint64_t commitEpoch = 0;
};

RequestTiming inspectRequestTiming(const std::wstring& request);

std::wstring makeProtocolNegotiationRequest(const RequestMetadata& metadata);

std::wstring makeEngineWarmRequest(const RequestMetadata& metadata, std::uint32_t timeoutMs);

std::wstring makeBeginSessionRequest(
  const RequestMetadata& metadata,
  const BeginSessionOptions& options = {}
);

std::wstring makeProcessKeyRequest(
  const RequestMetadata& metadata,
  const SessionHandle& session,
  const KeyEvent& key
);

std::wstring makeCommitCandidateRequest(
  const RequestMetadata& metadata,
  const SessionHandle& session,
  const std::wstring& candidateId
);

std::wstring makeSessionRequest(
  const RequestMetadata& metadata,
  const SessionHandle& session,
  SessionCommand command
);

std::wstring makeMemoryLearnRequest(
  const RequestMetadata& metadata,
  const SessionHandle& session,
  std::uint64_t commitEpoch
);

std::optional<NegotiatedProtocol> parseProtocolNegotiationResponse(
  const std::wstring& response,
  const RequestMetadata& request
);

bool parseEngineWarmResponse(
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
  const SessionHandle& expectedSession
);

std::optional<EngineDecision> parseCommitCandidateResponse(
  const std::wstring& response,
  const RequestMetadata& request,
  const std::wstring& expectedServerInstanceId,
  const SessionHandle& expectedSession
);

bool parseSessionResponse(
  const std::wstring& response,
  const RequestMetadata& request,
  const std::wstring& expectedServerInstanceId,
  const SessionHandle& expectedSession,
  SessionCommand command
);

bool parseMemoryLearnResponse(
  const std::wstring& response,
  const RequestMetadata& request,
  const std::wstring& expectedServerInstanceId,
  const SessionHandle& expectedSession
);

} // namespace lekh::tsf
