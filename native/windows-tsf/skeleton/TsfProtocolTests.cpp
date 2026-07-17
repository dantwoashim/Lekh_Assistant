#include "TsfProtocol.h"

#include <cstdlib>
#include <iostream>
#include <string>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

lekh::tsf::RequestMetadata request(
  const wchar_t* id,
  std::uint64_t sequence,
  std::uint64_t sentAt = 42,
  std::uint64_t deadlineAt = 92
) {
  return {id, L"windows-client-1", sequence, sentAt, deadlineAt};
}

} // namespace

int main() {
  using namespace lekh::tsf;

  const RequestMetadata negotiateMetadata = request(L"negotiate_1", 1);
  const std::wstring negotiation = makeProtocolNegotiationRequest(negotiateMetadata);
  require(negotiation.find(L"\"type\":\"protocol.negotiate\"") != std::wstring::npos, "negotiation type missing");
  require(negotiation.find(L"\"version\":2") != std::wstring::npos, "generated protocol version missing");
  require(negotiation.find(L"\"clientInstanceId\":\"windows-client-1\"") != std::wstring::npos, "client identity missing");
  require(negotiation.find(L"\"requestSequence\":1") != std::wstring::npos, "request sequence missing");
  require(negotiation.find(L"\"deadlineAt\":92") != std::wstring::npos, "deadline missing");

  const std::wstring negotiationResponse =
    L"{\"id\":\"negotiate_1\",\"type\":\"protocol.negotiate\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":1,"
    L"\"payload\":{\"selectedVersion\":2,\"serverInstanceId\":\"server-1\",\"limits\":{}}}";
  const auto negotiated = parseProtocolNegotiationResponse(negotiationResponse, negotiateMetadata);
  require(negotiated && negotiated->serverInstanceId == L"server-1", "valid negotiation response rejected");
  require(!parseProtocolNegotiationResponse(
    L"{\"id\":\"negotiate_1\",\"type\":\"protocol.negotiate\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":1,"
    L"\"payload\":{\"selectedVersion\":2,\"serverInstanceId\":\"server-2\",\"limits\":{}}}",
    negotiateMetadata
  ), "split server identity accepted");

  const RequestMetadata beginMetadata = request(L"begin_\"1", 2);
  const std::wstring begin = makeBeginSessionRequest(beginMetadata);
  require(begin.find(L"begin_\\\"1") != std::wstring::npos, "request id was not escaped");
  require(begin.find(L"\"leftTextWindow\":\"\"") != std::wstring::npos, "begin request must not send surrounding text");
  require(begin.find(L"\"secureInput\":false") != std::wstring::npos, "safe context was not explicit");

  const RequestMetadata beginResponseMetadata = request(L"begin_1", 2);
  const std::wstring beginResponse =
    L"{\"id\":\"begin_1\",\"type\":\"session.begin\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":2,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"sessionEpoch\":7}}";
  const auto session = parseBeginSessionResponse(beginResponse, beginResponseMetadata, L"server-1");
  require(session && session->sessionId == L"session-1" && session->sessionEpoch == 7, "valid begin response rejected");
  require(!parseBeginSessionResponse(beginResponse, request(L"wrong", 2), L"server-1"), "mismatched request id accepted");
  require(!parseBeginSessionResponse(beginResponse, beginResponseMetadata, L"server-2"), "mismatched server identity accepted");
  require(!parseBeginSessionResponse(
    L"{\"id\":\"begin_1\",\"id\":\"wrong\",\"type\":\"session.begin\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":2,\"payload\":{\"sessionId\":\"s\",\"sessionEpoch\":7}}",
    beginResponseMetadata,
    L"server-1"
  ), "duplicate JSON key accepted");

  KeyEvent key;
  key.key = L"k";
  key.code = L"KeyK";
  key.shift = true;
  key.repeat = true;
  key.timestamp = 88;
  key.nativeCode = 75;
  const RequestMetadata keyMetadata = request(L"key_1", 3, 88, 138);
  const SessionHandle expectedSession{L"session-1", 7};
  const std::wstring process = makeProcessKeyRequest(keyMetadata, expectedSession, key);
  require(process.find(L"\"sessionEpoch\":7") != std::wstring::npos, "session epoch missing");
  require(process.find(L"\"key\":\"k\"") != std::wstring::npos, "logical key missing");
  require(process.find(L"\"shift\":true") != std::wstring::npos, "shift state missing");
  require(process.find(L"\"isRepeat\":true") != std::wstring::npos, "repeat state missing");
  require(process.find(L"\"nativeCode\":75") != std::wstring::npos, "native code missing");

  const std::wstring composeResponse =
    L"{\"id\":\"key_1\",\"type\":\"session.processKeyStroke\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":3,\"sessionEpoch\":7,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"action\":\"compose\",\"compositionText\":\"ka\","
    L"\"displayText\":\"\\u0915\\u093e\",\"caret\":2}}";
  const auto compose = parseProcessKeyResponse(composeResponse, keyMetadata, L"server-1", expectedSession);
  require(compose && compose->action == EngineAction::Compose, "valid compose response rejected");
  require(compose->displayText == L"\u0915\u093e", "escaped Unicode was not decoded");

  const RequestMetadata commitMetadata = request(L"key_2", 4, 89, 139);
  const std::wstring commitResponse =
    L"{\"id\":\"key_2\",\"type\":\"session.processKeyStroke\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":4,\"sessionEpoch\":7,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"action\":\"commit\",\"compositionText\":\"\","
    L"\"displayText\":\"\",\"committedText\":\"\\u0915\\u093e \",\"caret\":0}}";
  const auto commit = parseProcessKeyResponse(commitResponse, commitMetadata, L"server-1", expectedSession);
  require(commit && commit->action == EngineAction::Commit, "valid commit response rejected");
  require(commit->committedText == L"\u0915\u093e ", "committed text was not decoded");

  require(!parseProcessKeyResponse(composeResponse, keyMetadata, L"server-1", {L"session-1", 8}), "stale epoch accepted");
  require(!parseProcessKeyResponse(composeResponse, keyMetadata, L"server-1", {L"other-session", 7}), "cross-session response accepted");
  require(!parseProcessKeyResponse(
    L"{\"id\":\"key_1\",\"type\":\"session.processKeyStroke\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":3,\"sessionEpoch\":7,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"action\":\"unknown\",\"compositionText\":\"\",\"displayText\":\"\",\"caret\":0}}",
    keyMetadata,
    L"server-1",
    expectedSession
  ), "unknown host action accepted");
  require(!parseProcessKeyResponse(
    L"{\"id\":\"key_1\",\"type\":\"session.processKeyStroke\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":3,\"sessionEpoch\":7,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"action\":\"compose\",\"compositionText\":\"\",\"displayText\":\"\\ud800\",\"caret\":0}}",
    keyMetadata,
    L"server-1",
    expectedSession
  ), "unpaired surrogate accepted");
  require(!parseBeginSessionResponse(
    L"{\"id\":\"begin_1\",\"type\":\"session.begin\",\"version\":2\u0967,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":2,\"payload\":{\"sessionId\":\"s\",\"sessionEpoch\":7}}",
    beginResponseMetadata,
    L"server-1"
  ), "non-ASCII JSON digit accepted");

  const RequestMetadata endMetadata = request(L"end_1", 5, 99, 149);
  const std::wstring endRequest = makeSessionRequest(endMetadata, expectedSession, SessionCommand::End);
  require(endRequest.find(L"\"type\":\"session.end\"") != std::wstring::npos, "end request type missing");
  require(parseSessionResponse(
    L"{\"id\":\"end_1\",\"type\":\"session.end\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":5,\"sessionEpoch\":7,\"payload\":{\"ended\":true}}",
    endMetadata,
    L"server-1",
    expectedSession,
    SessionCommand::End
  ), "valid end response rejected");

  RequestMetadata invalidDeadline = request(L"invalid", 6, 100, 99);
  require(makeBeginSessionRequest(invalidDeadline).empty(), "invalid deadline metadata was serialized");

  std::cout << "TSF protocol v2 tests passed\n";
  return 0;
}
