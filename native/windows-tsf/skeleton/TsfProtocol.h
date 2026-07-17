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

struct EngineDecision {
  EngineAction action = EngineAction::PassThrough;
  std::wstring compositionText;
  std::wstring displayText;
  std::wstring committedText;
  std::size_t caret = 0;
};

std::wstring makeBeginSessionRequest(
  const std::wstring& requestId,
  std::uint64_t sentAt
);

std::wstring makeProcessKeyRequest(
  const std::wstring& requestId,
  const std::wstring& sessionId,
  const KeyEvent& key,
  std::uint64_t sentAt
);

std::wstring makeSessionRequest(
  const std::wstring& requestId,
  const std::wstring& sessionId,
  SessionCommand command,
  std::uint64_t sentAt
);

std::optional<std::wstring> parseBeginSessionResponse(
  const std::wstring& response,
  const std::wstring& expectedRequestId
);

std::optional<EngineDecision> parseProcessKeyResponse(
  const std::wstring& response,
  const std::wstring& expectedRequestId,
  const std::wstring& expectedSessionId
);

bool parseSessionResponse(
  const std::wstring& response,
  const std::wstring& expectedRequestId,
  SessionCommand command
);

} // namespace lekh::tsf
