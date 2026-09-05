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

  const RequestMetadata warmMetadata = request(L"warm_1", 2, 43, 5043);
  const std::wstring warmRequest = makeEngineWarmRequest(warmMetadata, 5000);
  require(warmRequest.find(L"\"type\":\"engine.warm\"") != std::wstring::npos, "warm type missing");
  require(warmRequest.find(L"\"timeoutMs\":5000") != std::wstring::npos, "warm timeout missing");
  const std::wstring warmResponse =
    L"{\"id\":\"warm_1\",\"type\":\"engine.warm\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":2,"
    L"\"payload\":{\"ready\":true,\"partial\":false,\"loadedModules\":[],"
    L"\"unavailableModules\":[],\"warmTimeMs\":10,\"warnings\":[]}}";
  require(parseEngineWarmResponse(warmResponse, warmMetadata, L"server-1"), "valid warm response rejected");
  require(!parseEngineWarmResponse(warmResponse, warmMetadata, L"server-2"), "mismatched warm server accepted");
  require(!parseEngineWarmResponse(
    L"{\"id\":\"warm_1\",\"type\":\"engine.warm\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":2,"
    L"\"payload\":{\"ready\":false,\"partial\":true,\"loadedModules\":[],"
    L"\"unavailableModules\":[\"dictionary\"],\"warmTimeMs\":10,\"warnings\":[]}}",
    warmMetadata,
    L"server-1"
  ), "partial engine warm-up was accepted as broker readiness");
  require(makeEngineWarmRequest(warmMetadata, 0).empty(), "zero warm timeout was serialized");
  const RequestTiming warmTiming = inspectRequestTiming(warmRequest);
  require(warmTiming.deadlineClass == RequestDeadlineClass::Control &&
          warmTiming.hasValidDeadline && warmTiming.deadlineAt == warmMetadata.deadlineAt,
    "engine.warm did not retain its control deadline and absolute envelope deadline");

  const RequestMetadata beginMetadata = request(L"begin_\"1", 2);
  const std::wstring begin = makeBeginSessionRequest(beginMetadata);
  require(begin.find(L"begin_\\\"1") != std::wstring::npos, "request id was not escaped");
  require(begin.find(L"\"leftTextWindow\":\"\"") != std::wstring::npos, "begin request must not send surrounding text");
  require(begin.find(L"\"secureInput\":false") != std::wstring::npos, "safe context was not explicit");
  const std::wstring configuredBegin = makeBeginSessionRequest(beginMetadata, {
    L"romanized-romanized", true, true, false
  });
  require(configuredBegin.find(L"\"mode\":\"romanized-romanized\"") != std::wstring::npos,
    "configured Windows mode was not serialized");
  require(configuredBegin.find(L"\"enablePersonalization\":true") != std::wstring::npos,
    "personalization preference was not serialized");
  require(configuredBegin.find(L"\"enableNextWordPrediction\":false") != std::wstring::npos,
    "next-word preference was not serialized");

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
  const RequestTiming processTiming = inspectRequestTiming(process);
  require(processTiming.deadlineClass == RequestDeadlineClass::HotPath &&
          processTiming.hasValidDeadline && processTiming.deadlineAt == keyMetadata.deadlineAt,
    "process-key request did not retain its hot-path absolute deadline");
  require(process.find(L"\"sessionEpoch\":7") != std::wstring::npos, "session epoch missing");
  require(process.find(L"\"key\":\"k\"") != std::wstring::npos, "logical key missing");
  require(process.find(L"\"shift\":true") != std::wstring::npos, "shift state missing");
  require(process.find(L"\"isRepeat\":true") != std::wstring::npos, "repeat state missing");
  require(process.find(L"\"nativeCode\":75") != std::wstring::npos, "native code missing");

  const std::wstring composeResponse =
    L"{\"id\":\"key_1\",\"type\":\"session.processKeyStroke\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":3,\"sessionEpoch\":7,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"action\":\"compose\",\"compositionText\":\"ka\","
    L"\"displayText\":\"\\u0915\\u093e\",\"caret\":2,\"candidates\":[{\"id\":\"ka-1\","
    L"\"text\":\"\\u0915\\u093e\",\"label\":\"ka\",\"type\":\"word\",\"confidence\":0.9,"
    L"\"reason\":[],\"shortcut\":\"1\"}],\"inlineCompletion\":{\"text\":\"\\u0915\\u093e\","
    L"\"displayText\":\"  \\u0915\\u093e\",\"contextText\":\"\",\"candidate\":{\"id\":\"ka-1-inline\","
    L"\"text\":\"\\u0915\\u093e\",\"type\":\"word\",\"confidence\":0.9,\"reason\":[]},"
    L"\"confidence\":0.9,\"source\":\"active-candidate\",\"acceptKeys\":[\"Tab\",\"ArrowRight\"]},"
    L"\"shouldShowCandidateUI\":true}}";
  const auto compose = parseProcessKeyResponse(composeResponse, keyMetadata, L"server-1", expectedSession);
  require(compose && compose->action == EngineAction::Compose, "valid compose response rejected");
  require(compose->displayText == L"\u0915\u093e", "escaped Unicode was not decoded");
  require(compose->inlineCompletionText == L"\u0915\u093e" &&
      compose->inlineCompletionDisplayText == L"  \u0915\u093e",
    "inline completion was not parsed for host-native rendering");
  require(compose->shouldShowCandidateUi && compose->candidates.size() == 1, "candidate list was not parsed");
  require(compose->candidates[0].id == L"ka-1" && compose->candidates[0].text == L"\u0915\u093e" &&
    compose->candidates[0].label == L"ka" && compose->candidates[0].shortcut == L"1",
    "candidate fields were not preserved");

  const RequestMetadata commitMetadata = request(L"key_2", 4, 89, 139);
  const std::wstring commitResponse =
    L"{\"id\":\"key_2\",\"type\":\"session.processKeyStroke\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":4,\"sessionEpoch\":7,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"action\":\"commit\",\"compositionText\":\"\","
    L"\"displayText\":\"\",\"committedText\":\"\\u0915\\u093e \",\"caret\":0,\"candidates\":[],"
    L"\"shouldShowCandidateUI\":false}}";
  const auto commit = parseProcessKeyResponse(commitResponse, commitMetadata, L"server-1", expectedSession);
  require(commit && commit->action == EngineAction::Commit, "valid commit response rejected");
  require(commit->committedText == L"\u0915\u093e ", "committed text was not decoded");

  require(!parseProcessKeyResponse(composeResponse, keyMetadata, L"server-1", {L"session-1", 8}), "stale epoch accepted");
  require(!parseProcessKeyResponse(composeResponse, keyMetadata, L"server-1", {L"other-session", 7}), "cross-session response accepted");
  require(!parseProcessKeyResponse(
    L"{\"id\":\"key_1\",\"type\":\"session.processKeyStroke\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":3,\"sessionEpoch\":7,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"action\":\"unknown\",\"compositionText\":\"\","
    L"\"displayText\":\"\",\"caret\":0,\"candidates\":[],\"shouldShowCandidateUI\":false}}",
    keyMetadata,
    L"server-1",
    expectedSession
  ), "unknown host action accepted");
  require(!parseProcessKeyResponse(
    L"{\"id\":\"key_1\",\"type\":\"session.processKeyStroke\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":3,\"sessionEpoch\":7,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"action\":\"compose\",\"compositionText\":\"\","
    L"\"displayText\":\"\\ud800\",\"caret\":0,\"candidates\":[],\"shouldShowCandidateUI\":false}}",
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

  const RequestMetadata selectMetadata = request(L"select_1", 5, 90, 140);
  const std::wstring selectRequest = makeCommitCandidateRequest(selectMetadata, expectedSession, L"ka-1");
  require(selectRequest.find(L"\"type\":\"session.commitCandidate\"") != std::wstring::npos,
    "candidate commit type missing");
  require(selectRequest.find(L"\"candidateId\":\"ka-1\"") != std::wstring::npos,
    "candidate identifier missing");
  const std::wstring selectResponse =
    L"{\"id\":\"select_1\",\"type\":\"session.commitCandidate\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":5,\"sessionEpoch\":7,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"action\":\"commit\","
    L"\"committedText\":\"\\u0915\\u093e\",\"commitEpoch\":1,\"consumedRange\":[0,2],"
    L"\"followupCandidates\":[],\"memoryRecorded\":false,\"schemaVersion\":1}}";
  const auto selected = parseCommitCandidateResponse(selectResponse, selectMetadata, L"server-1", expectedSession);
  require(selected && selected->action == EngineAction::Commit && selected->committedText == L"\u0915\u093e" &&
      selected->commitEpoch == 1,
    "valid candidate commit response rejected");
  require(!parseCommitCandidateResponse(selectResponse, selectMetadata, L"server-1", {L"session-1", 8}),
    "stale candidate commit epoch accepted");
  require(makeCommitCandidateRequest(selectMetadata, expectedSession, L"").empty(),
    "empty candidate identifier was serialized");

  const RequestMetadata learnMetadata = request(L"learn_1", 6, 100, 150);
  const std::wstring learnRequest = makeMemoryLearnRequest(learnMetadata, expectedSession, 1);
  require(learnRequest.find(L"\"type\":\"memory.learn\"") != std::wstring::npos,
    "memory confirmation type missing");
  require(learnRequest.find(L"\"commitEpoch\":1") != std::wstring::npos,
    "memory confirmation commit epoch missing");
  require(parseMemoryLearnResponse(
    L"{\"id\":\"learn_1\",\"type\":\"memory.learn\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":6,\"sessionEpoch\":7,"
    L"\"payload\":{\"learned\":true}}",
    learnMetadata,
    L"server-1",
    expectedSession
  ), "valid memory confirmation response rejected");
  require(makeMemoryLearnRequest(learnMetadata, expectedSession, 0).empty(),
    "zero commit epoch was serialized");

  const RequestMetadata endMetadata = request(L"end_1", 6, 99, 149);
  const std::wstring endRequest = makeSessionRequest(endMetadata, expectedSession, SessionCommand::End);
  require(endRequest.find(L"\"type\":\"session.end\"") != std::wstring::npos, "end request type missing");
  require(parseSessionResponse(
    L"{\"id\":\"end_1\",\"type\":\"session.end\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":6,\"sessionEpoch\":7,\"payload\":{\"ended\":true}}",
    endMetadata,
    L"server-1",
    expectedSession,
    SessionCommand::End
  ), "valid end response rejected");

  RequestMetadata invalidDeadline = request(L"invalid", 7, 100, 99);
  require(makeBeginSessionRequest(invalidDeadline).empty(), "invalid deadline metadata was serialized");
  const RequestTiming malformedTiming = inspectRequestTiming(L"{not-json");
  require(malformedTiming.deadlineClass == RequestDeadlineClass::HotPath &&
          !malformedTiming.hasValidDeadline,
    "malformed public request escaped the bounded hot-path default");
  const RequestTiming unknownTiming = inspectRequestTiming(
    L"{\"type\":\"future.message\",\"deadlineAt\":123}"
  );
  require(unknownTiming.deadlineClass == RequestDeadlineClass::HotPath &&
          unknownTiming.hasValidDeadline && unknownTiming.deadlineAt == 123,
    "unknown request type escaped the bounded hot-path class");

  std::cout << "TSF protocol v2 tests passed\n";
  return 0;
}
