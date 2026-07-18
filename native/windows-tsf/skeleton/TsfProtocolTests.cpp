#include "TsfProtocol.h"

#include "../../shared/ipc/generated/LekhIPCProtocol.generated.h"

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

std::wstring replaceOnce(std::wstring value, const std::wstring& needle, const std::wstring& replacement) {
  const std::size_t position = value.find(needle);
  require(position != std::wstring::npos, "test fixture replacement marker missing");
  value.replace(position, needle.size(), replacement);
  return value;
}

std::optional<lekh::tsf::EngineDecision> parseProcessKeyResponse(
  const std::wstring& response,
  const lekh::tsf::RequestMetadata& requestMetadata,
  const std::wstring& expectedServerInstanceId,
  const lekh::tsf::SessionHandle& expectedSession,
  const lekh::tsf::KeyEvent& expectedKey,
  bool hadSingleLetterComposition
) {
  return lekh::tsf::parseProcessKeyResponse(
    response,
    requestMetadata,
    expectedServerInstanceId,
    expectedSession,
    expectedKey,
    hadSingleLetterComposition ? L"k" : L""
  );
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

  const std::wstring negotiatedLimits =
    L"{\"maximumFrameBytes\":" + std::to_wstring(lekh::ipc::kMaximumFrameBytes) +
    L",\"maximumCompositionLength\":" + std::to_wstring(lekh::ipc::kMaximumCompositionLength) +
    L",\"hotPathDeadlineMs\":" + std::to_wstring(lekh::ipc::kHotPathDeadlineMilliseconds) +
    L",\"maximumPendingRequestsPerConnection\":" +
    std::to_wstring(lekh::ipc::kMaximumPendingRequestsPerConnection) +
    L",\"maximumClientInstances\":" + std::to_wstring(lekh::ipc::kMaximumClientInstances) +
    L",\"clientIdleTtlMs\":" + std::to_wstring(lekh::ipc::kClientIdleTtlMilliseconds) + L"}";
  const std::wstring negotiationResponse =
    L"{\"id\":\"negotiate_1\",\"type\":\"protocol.negotiate\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":1,"
    L"\"payload\":{\"selectedVersion\":2,\"serverInstanceId\":\"server-1\",\"limits\":" + negotiatedLimits + L"}}";
  const auto negotiated = parseProtocolNegotiationResponse(negotiationResponse, negotiateMetadata);
  require(negotiated && negotiated->serverInstanceId == L"server-1", "valid negotiation response rejected");
  require(!parseProtocolNegotiationResponse(
    L"{\"id\":\"negotiate_1\",\"type\":\"protocol.negotiate\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":1,"
    L"\"payload\":{\"selectedVersion\":2,\"serverInstanceId\":\"server-2\",\"limits\":" + negotiatedLimits + L"}}",
    negotiateMetadata
  ), "split server identity accepted");
  require(!parseProtocolNegotiationResponse(
    negotiationResponse.substr(0, negotiationResponse.size() - 1) + L",\"unexpected\":true}",
    negotiateMetadata
  ), "unknown negotiation envelope field accepted");
  require(!parseProtocolNegotiationResponse(
    replaceOnce(
      negotiationResponse,
      L"\"maximumFrameBytes\":" + std::to_wstring(lekh::ipc::kMaximumFrameBytes),
      L"\"maximumFrameBytes\":" + std::to_wstring(lekh::ipc::kMaximumFrameBytes - 1)
    ),
    negotiateMetadata
  ), "mismatched negotiated transport limit accepted");
  require(!parseProtocolNegotiationResponse(
    replaceOnce(
      negotiationResponse,
      L"\"maximumCompositionLength\":" + std::to_wstring(lekh::ipc::kMaximumCompositionLength),
      L"\"maximumCompositionLength\":" + std::to_wstring(lekh::ipc::kMaximumCompositionLength + 1)
    ),
    negotiateMetadata
  ), "mismatched negotiated composition limit accepted");
  require(!parseProtocolNegotiationResponse(
    negotiationResponse,
    request(L"negotiate_1", 0)
  ), "response for impossible request metadata accepted");

  const RequestMetadata warmMetadata = request(L"warm_1", 2);
  const std::wstring warmRequest = makeEngineWarmRequest(warmMetadata);
  require(warmRequest.find(L"\"type\":\"engine.warm\"") != std::wstring::npos, "warm request type missing");
  require(
    warmRequest.find(
      L"\"timeoutMs\":" + std::to_wstring(lekh::ipc::kHotPathDeadlineMilliseconds)
    ) != std::wstring::npos,
    "warm request did not use the generated bounded timeout"
  );
  const std::wstring warmResponse =
    L"{\"id\":\"warm_1\",\"type\":\"engine.warm\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":2,"
    L"\"payload\":{\"ready\":true,\"partial\":false,"
    L"\"loadedModules\":[\"keyboard-session\",\"romanized-wrapper\","
    L"\"proofread-wrapper\",\"dictionary-wrapper\"],"
    L"\"unavailableModules\":[],\"warmTimeMs\":1.25,\"warnings\":[]}}";
  const auto warmed = parseEngineWarmResponse(warmResponse, warmMetadata, L"server-1");
  require(warmed && warmed->ready && !warmed->partial, "valid engine warm response rejected");
  require(!parseEngineWarmResponse(
    replaceOnce(warmResponse, L"\"partial\":false", L"\"partial\":true"),
    warmMetadata,
    L"server-1"
  ), "contradictory engine warm readiness accepted");
  require(!parseEngineWarmResponse(
    replaceOnce(
      warmResponse,
      L"\"romanized-wrapper\"",
      L"\"keyboard-session\""
    ),
    warmMetadata,
    L"server-1"
  ), "duplicate warmed module identity accepted");
  require(!parseEngineWarmResponse(warmResponse, warmMetadata, L"server-2"), "warm response from wrong server accepted");

  const RequestMetadata beginMetadata = request(L"begin_\"1", 2);
  const std::wstring begin = makeBeginSessionRequest(beginMetadata);
  require(begin.find(L"begin_\\\"1") != std::wstring::npos, "request id was not escaped");
  require(begin.find(L"\"leftTextWindow\":\"\"") != std::wstring::npos, "begin request must not send surrounding text");
  require(begin.find(L"\"secureInput\":false") != std::wstring::npos, "safe context was not explicit");

  const RequestMetadata beginResponseMetadata = request(L"begin_1", 2);
  const std::wstring beginResponse =
    L"{\"id\":\"begin_1\",\"type\":\"session.begin\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":2,\"sessionEpoch\":7,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"sessionEpoch\":7}}";
  const auto session = parseBeginSessionResponse(beginResponse, beginResponseMetadata, L"server-1");
  require(session && session->sessionId == L"session-1" && session->sessionEpoch == 7, "valid begin response rejected");
  require(!parseBeginSessionResponse(beginResponse, request(L"wrong", 2), L"server-1"), "mismatched request id accepted");
  require(!parseBeginSessionResponse(beginResponse, beginResponseMetadata, L"server-2"), "mismatched server identity accepted");
  require(!parseBeginSessionResponse(beginResponse, beginResponseMetadata, L""), "unbound server identity accepted");
  require(!parseBeginSessionResponse(
    L"{\"id\":\"begin_1\",\"id\":\"wrong\",\"type\":\"session.begin\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":2,\"sessionEpoch\":7,"
    L"\"payload\":{\"sessionId\":\"s\",\"sessionEpoch\":7}}",
    beginResponseMetadata,
    L"server-1"
  ), "duplicate JSON key accepted");
  require(!parseBeginSessionResponse(
    L"{\"id\":\"begin_1\",\"type\":\"session.begin\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":2,\"sessionEpoch\":8,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"sessionEpoch\":7}}",
    beginResponseMetadata,
    L"server-1"
  ), "split session epoch accepted");
  require(!parseBeginSessionResponse(
    replaceOnce(
      beginResponse,
      L"\"sessionEpoch\":7}}",
      L"\"sessionEpoch\":7,\"unexpected\":true}}"
    ),
    beginResponseMetadata,
    L"server-1"
  ), "unknown begin-session payload field accepted");

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
  KeyEvent controlKey = key;
  controlKey.key = std::wstring(1, static_cast<wchar_t>(1));
  require(
    makeProcessKeyRequest(keyMetadata, expectedSession, controlKey).find(L"\"key\":\"\\u0001\"") !=
      std::wstring::npos,
    "control character was not emitted as valid four-digit JSON Unicode"
  );
  KeyEvent malformedKey = key;
  malformedKey.key = std::wstring(1, static_cast<wchar_t>(0xd800));
  require(makeProcessKeyRequest(keyMetadata, expectedSession, malformedKey).empty(), "malformed UTF-16 key was serialized");
  KeyEvent oversizedKey = key;
  oversizedKey.key.assign(257, L'k');
  require(makeProcessKeyRequest(keyMetadata, expectedSession, oversizedKey).empty(), "oversized logical key was serialized");

  const std::wstring composeResponse =
    L"{\"id\":\"key_1\",\"type\":\"session.processKeyStroke\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":3,\"sessionEpoch\":7,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"mode\":\"romanized-traditional\","
    L"\"surface\":\"romanized-to-unicode\",\"action\":\"compose\",\"compositionText\":\"k\","
    L"\"displayText\":\"\\u0915\",\"caret\":1,\"candidates\":[],\"proofHints\":[],"
    L"\"shouldShowCandidateUI\":false,\"confidence\":1,\"warnings\":[],\"schemaVersion\":1}}";
  const auto compose = parseProcessKeyResponse(
    composeResponse,
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  );
  require(compose && compose->action == EngineAction::Compose, "valid compose response rejected");
  require(compose->displayText == L"\u0915", "escaped Unicode was not decoded");
  std::wstring secondLetterResponse = replaceOnce(
    composeResponse,
    L"\"compositionText\":\"k\"",
    L"\"compositionText\":\"kk\""
  );
  secondLetterResponse = replaceOnce(secondLetterResponse, L"\"caret\":1", L"\"caret\":2");
  require(parseProcessKeyResponse(
    secondLetterResponse, keyMetadata, L"server-1", expectedSession, key, true
  ).has_value(), "exact second-letter composition transition was rejected");
  require(!lekh::tsf::parseProcessKeyResponse(
    replaceOnce(secondLetterResponse, L"\"compositionText\":\"kk\"", L"\"compositionText\":\"xk\""),
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    L"k"
  ), "compose response that replaced the accepted Romanized state was accepted");
  const std::wstring maximumComposition(lekh::ipc::kMaximumCompositionLength, L'k');
  std::wstring maximumCompositionResponse = replaceOnce(
    composeResponse,
    L"\"compositionText\":\"k\"",
    L"\"compositionText\":\"" + maximumComposition + L"\""
  );
  maximumCompositionResponse = replaceOnce(
    maximumCompositionResponse,
    L"\"caret\":1",
    L"\"caret\":" + std::to_wstring(lekh::ipc::kMaximumCompositionLength)
  );
  require(lekh::tsf::parseProcessKeyResponse(
    maximumCompositionResponse,
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    maximumComposition.substr(0, maximumComposition.size() - 1)
  ).has_value(), "response at the generated composition limit was rejected");
  require(!lekh::tsf::parseProcessKeyResponse(
    replaceOnce(
      maximumCompositionResponse,
      L"\"compositionText\":\"" + maximumComposition + L"\"",
      L"\"compositionText\":\"" + maximumComposition + L"k\""
    ),
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    maximumComposition
  ), "response above the generated composition limit was accepted");

  const std::wstring richComposeResponse =
    L"{\"id\":\"key_1\",\"type\":\"session.processKeyStroke\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":3,\"sessionEpoch\":7,\"latencyMs\":1.5,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"mode\":\"romanized-traditional\","
    L"\"surface\":\"romanized-to-unicode\",\"action\":\"compose\",\"compositionText\":\"k\","
    L"\"displayText\":\"\\u0915\",\"caret\":1,"
    L"\"candidates\":[{\"id\":\"candidate-1\",\"text\":\"\\u0915\",\"label\":\"ka\","
    L"\"type\":\"word\",\"confidence\":0.95,\"reason\":[\"deterministic\"],\"shortcut\":\"1\","
    L"\"replaceRange\":[0,1]}],"
    L"\"primary\":{\"id\":\"candidate-1\",\"text\":\"\\u0915\",\"label\":\"ka\","
    L"\"type\":\"word\",\"confidence\":0.95,\"reason\":[\"deterministic\"],\"shortcut\":\"1\","
    L"\"replaceRange\":[0,1]},"
    L"\"inlineCompletion\":{\"text\":\"h\",\"displayText\":\"\\u0916\",\"contextText\":\"k\","
    L"\"candidate\":{\"id\":\"candidate-2\",\"text\":\"kh\",\"type\":\"completion\","
    L"\"confidence\":0.8,\"reason\":[\"prefix\"],\"replaceRange\":[0,1]},"
    L"\"confidence\":0.8,\"source\":\"active-candidate\",\"acceptKeys\":[\"Tab\",\"Enter\"]},"
    L"\"proofHints\":[{\"range\":[0,1],\"original\":\"k\",\"suggestion\":\"\\u0915\","
    L"\"type\":\"spelling\",\"confidence\":0.7,\"action\":\"hint-only\",\"explanation\":\"test\"}],"
    L"\"shouldShowCandidateUI\":true,\"confidence\":0.95,"
    L"\"warnings\":[\"bounded\"],\"latencyMs\":0.5,\"schemaVersion\":1}}";
  require(parseProcessKeyResponse(
    richComposeResponse,
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ).has_value(), "valid rich candidate response rejected");
  const std::wstring maximumText(lekh::ipc::kMaximumTextLength, L'\u0915');
  const std::wstring additionalCandidateText(6000, L'\u0916');
  std::wstring oversizedUtf8FrameResponse = replaceOnce(
    composeResponse,
    L"\"displayText\":\"\\u0915\"",
    L"\"displayText\":\"" + maximumText + L"\""
  );
  oversizedUtf8FrameResponse = replaceOnce(
    oversizedUtf8FrameResponse,
    L"\"candidates\":[]",
    L"\"candidates\":[{\"id\":\"candidate-frame\",\"text\":\"" + additionalCandidateText +
      L"\",\"type\":\"word\",\"confidence\":1,\"reason\":[]}],"
      L"\"primary\":{\"id\":\"candidate-frame\",\"text\":\"" + additionalCandidateText +
      L"\",\"type\":\"word\",\"confidence\":1,\"reason\":[]}"
  );
  std::wstring boundedUtf8FrameResponse = replaceOnce(
    oversizedUtf8FrameResponse,
    maximumText,
    std::wstring(100, L'\u0915')
  );
  boundedUtf8FrameResponse = replaceOnce(
    boundedUtf8FrameResponse,
    additionalCandidateText,
    std::wstring(100, L'\u0916')
  );
  boundedUtf8FrameResponse = replaceOnce(
    boundedUtf8FrameResponse,
    additionalCandidateText,
    std::wstring(100, L'\u0916')
  );
  require(parseProcessKeyResponse(
    boundedUtf8FrameResponse,
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ).has_value(), "structurally valid bounded multibyte response was rejected");
  require(!parseProcessKeyResponse(
    oversizedUtf8FrameResponse,
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "UTF-8 response larger than the generated frame-byte limit was accepted");
  require(parseProcessKeyResponse(
    replaceOnce(richComposeResponse, L"\"confidence\":0.95", L"\"confidence\":9.5e-1"),
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ).has_value(), "locale-independent JSON exponent was rejected");
  require(!parseProcessKeyResponse(
    replaceOnce(
      richComposeResponse,
      L"\"proofHints\":[{\"range\":[0,1]",
      L"\"proofHints\":[{\"range\":[0,2]"
    ),
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "proof-hint range outside the composition was accepted");
  require(!parseProcessKeyResponse(
    replaceOnce(richComposeResponse, L"\"original\":\"k\"", L"\"original\":\"x\""),
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "proof-hint original text that disagrees with its range was accepted");
  require(!parseProcessKeyResponse(
    replaceOnce(
      richComposeResponse,
      L"\"primary\":{\"id\":\"candidate-1\",\"text\":\"\\u0915\"",
      L"\"primary\":{\"id\":\"candidate-1\",\"text\":\"different\""
    ),
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "primary candidate that disagrees with its listed identity was accepted");
  require(!parseProcessKeyResponse(
    replaceOnce(
      composeResponse,
      L"\"candidates\":[]",
      L"\"candidates\":[{\"id\":\"candidate-1\",\"text\":\"x\",\"type\":\"word\","
      L"\"confidence\":1,\"reason\":[]}]"
    ),
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "nonempty candidate list without a primary candidate was accepted");
  require(!parseProcessKeyResponse(
    replaceOnce(
      richComposeResponse,
      L"\"candidates\":[",
      L"\"candidates\":[{\"id\":\"candidate-0\",\"text\":\"x\",\"type\":\"word\","
      L"\"confidence\":1,\"reason\":[]},"
    ),
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "primary candidate that did not exactly match the first candidate was accepted");
  require(!parseProcessKeyResponse(
    replaceOnce(
      richComposeResponse,
      L"\"replaceRange\":[0,1]}],\"primary\"",
      L"\"replaceRange\":[0,1]},{\"id\":\"candidate-1\",\"text\":\"x\","
      L"\"type\":\"word\",\"confidence\":1,\"reason\":[]}],\"primary\""
    ),
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "duplicate candidate identity was accepted");
  require(!parseProcessKeyResponse(
    composeResponse.substr(0, composeResponse.size() - 2) + L",\"unexpected\":true}}",
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "unknown candidate-update field accepted");
  std::wstring nestedCandidateResponse = composeResponse;
  const std::wstring emptyCandidates = L"\"candidates\":[]";
  const std::size_t candidatePosition = nestedCandidateResponse.find(emptyCandidates);
  require(candidatePosition != std::wstring::npos, "candidate fixture marker missing");
  nestedCandidateResponse.replace(
    candidatePosition,
    emptyCandidates.size(),
    L"\"candidates\":[{\"id\":\"candidate-1\",\"text\":\"x\",\"type\":\"word\","
    L"\"confidence\":1,\"reason\":[],\"unexpected\":true}]"
  );
  require(!parseProcessKeyResponse(
    nestedCandidateResponse,
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "unknown nested candidate field accepted");
  require(!parseProcessKeyResponse(
    replaceOnce(
      composeResponse,
      L"\"candidates\":[]",
      L"\"candidates\":[{\"id\":\"candidate-1\",\"text\":\"x\",\"type\":\"word\","
      L"\"confidence\":1,\"reason\":[],\"replaceRange\":[0,2]}]"
    ),
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "candidate range beyond the active composition accepted");
  require(!parseProcessKeyResponse(
    replaceOnce(composeResponse, L"\"caret\":1", L"\"caret\":2"),
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "caret beyond the active composition accepted");
  require(!parseProcessKeyResponse(
    composeResponse.substr(0, composeResponse.size() - 1) + L",\"latencyMs\":-1}",
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "negative response latency accepted");

  const RequestMetadata commitMetadata = request(L"key_2", 4, 89, 139);
  const std::wstring commitResponse =
    L"{\"id\":\"key_2\",\"type\":\"session.processKeyStroke\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":4,\"sessionEpoch\":7,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"mode\":\"romanized-traditional\","
    L"\"surface\":\"romanized-to-unicode\",\"action\":\"commit\",\"compositionText\":\"\","
    L"\"displayText\":\"\",\"committedText\":\"k \",\"consumedRange\":[0,1],\"caret\":0,\"candidates\":[],"
    L"\"proofHints\":[],\"shouldShowCandidateUI\":false,\"confidence\":1,\"warnings\":[],\"schemaVersion\":1}}";
  KeyEvent spaceKey;
  spaceKey.key = L" ";
  spaceKey.code = L"Space";
  const auto commit = parseProcessKeyResponse(
    commitResponse,
    commitMetadata,
    L"server-1",
    expectedSession,
    spaceKey,
    true
  );
  require(commit && commit->action == EngineAction::Commit, "valid commit response rejected");
  require(commit->committedText == L"k ", "exact raw Space commit was not preserved");
  require(!parseProcessKeyResponse(
    replaceOnce(commitResponse, L",\"consumedRange\":[0,1]", L""),
    commitMetadata,
    L"server-1",
    expectedSession,
    spaceKey,
    true
  ), "commit response without its canonical consumed range was accepted");
  require(!parseProcessKeyResponse(
    replaceOnce(commitResponse, L"\"committedText\":\"k \"", L"\"committedText\":\"k\""),
    commitMetadata,
    L"server-1",
    expectedSession,
    spaceKey,
    true
  ), "Space commit without its trailing delimiter was accepted");
  KeyEvent enterKey;
  enterKey.key = L"Enter";
  enterKey.code = L"Enter";
  require(!parseProcessKeyResponse(
    commitResponse, commitMetadata, L"server-1", expectedSession, enterKey, true
  ), "Enter commit ending in a space was accepted");
  require(parseProcessKeyResponse(
    replaceOnce(commitResponse, L"\"committedText\":\"k \"", L"\"committedText\":\"k\\n\""),
    commitMetadata,
    L"server-1",
    expectedSession,
    enterKey,
    true
  ).has_value(), "Enter commit ending in a newline was rejected");
  require(!parseProcessKeyResponse(
    replaceOnce(commitResponse, L"\"committedText\":\"k \"", L"\"committedText\":\"x\\n\""),
    commitMetadata,
    L"server-1",
    expectedSession,
    enterKey,
    true
  ), "Enter commit with an arbitrary delimiter-terminated prefix was accepted");
  require(!parseProcessKeyResponse(
    replaceOnce(commitResponse, L"\"committedText\":\"k \"", L"\"committedText\":\"x \""),
    commitMetadata,
    L"server-1",
    expectedSession,
    spaceKey,
    true
  ), "Space commit with an arbitrary delimiter-terminated prefix was accepted");
  require(!parseProcessKeyResponse(
    replaceOnce(
      commitResponse,
      L"\"committedText\":\"k \"",
      L"\"committedText\":\"\\u0915\\u093e \""
    ),
    commitMetadata,
    L"server-1",
    expectedSession,
    spaceKey,
    true
  ), "Windows raw-only policy accepted a transformed Space commit");
  require(!parseProcessKeyResponse(
    replaceOnce(commitResponse, L"\"compositionText\":\"\"", L"\"compositionText\":\"k\""),
    commitMetadata,
    L"server-1",
    expectedSession,
    spaceKey,
    true
  ), "commit response with a live composition was accepted");
  require(!parseProcessKeyResponse(
    replaceOnce(composeResponse, L"\"caret\":1", L"\"committedText\":\"x\",\"caret\":1"),
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "compose response carrying committed text was accepted");
  require(!parseProcessKeyResponse(
    replaceOnce(composeResponse, L"\"caret\":1", L"\"committedText\":\"\",\"caret\":1"),
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "compose response carrying an explicitly empty committed text was accepted");
  require(!parseProcessKeyResponse(
    replaceOnce(composeResponse, L"\"caret\":1", L"\"caret\":1,\"consumedRange\":[0,1]"),
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "compose response carrying a consumed range was accepted");
  require(!parseProcessKeyResponse(
    replaceOnce(
      commitResponse,
      L"\"candidates\":[]",
      L"\"candidates\":[{\"id\":\"stale\",\"text\":\"x\",\"type\":\"word\","
      L"\"confidence\":1,\"reason\":[]}]"
    ),
    commitMetadata,
    L"server-1",
    expectedSession,
    spaceKey,
    true
  ), "commit response carrying stale candidate UI state was accepted");
  require(!parseProcessKeyResponse(
    replaceOnce(commitResponse, L"\"shouldShowCandidateUI\":false", L"\"shouldShowCandidateUI\":true"),
    commitMetadata,
    L"server-1",
    expectedSession,
    spaceKey,
    true
  ), "commit response requesting stale candidate UI visibility was accepted");

  const std::wstring terminalNgramCompletion =
    L"\"inlineCompletion\":{\"text\":\"x\",\"displayText\":\"x\",\"contextText\":\"\","
    L"\"candidate\":{\"id\":\"next-word\",\"text\":\"x\",\"type\":\"completion\","
    L"\"confidence\":1,\"reason\":[]},\"confidence\":1,\"source\":\"ngram-lm\","
    L"\"acceptKeys\":[\"Tab\",\"Enter\"]},";
  const std::wstring commitWithNgramCompletion = replaceOnce(
    commitResponse,
    L"\"proofHints\":[]",
    terminalNgramCompletion + L"\"proofHints\":[]"
  );
  require(parseProcessKeyResponse(
    commitWithNgramCompletion,
    commitMetadata,
    L"server-1",
    expectedSession,
    spaceKey,
    true
  ).has_value(), "commit response with a valid next-word completion was rejected");
  require(!parseProcessKeyResponse(
    replaceOnce(commitWithNgramCompletion, L"\"source\":\"ngram-lm\"", L"\"source\":\"active-candidate\""),
    commitMetadata,
    L"server-1",
    expectedSession,
    spaceKey,
    true
  ), "commit response carrying a stale active-candidate completion was accepted");

  require(!parseProcessKeyResponse(
    composeResponse, keyMetadata, L"server-1", {L"session-1", 8}, key, false
  ), "stale epoch accepted");
  require(!parseProcessKeyResponse(
    composeResponse, keyMetadata, L"server-1", {L"other-session", 7}, key, false
  ), "cross-session response accepted");
  require(!parseProcessKeyResponse(
    commitResponse, commitMetadata, L"server-1", expectedSession, key, false
  ), "first-letter response was allowed to commit arbitrary text");
  require(!parseProcessKeyResponse(
    composeResponse, keyMetadata, L"server-1", expectedSession, spaceKey, true
  ), "space response was allowed to continue composing");

  std::wstring emptyComposeResponse = replaceOnce(
    composeResponse,
    L"\"compositionText\":\"k\"",
    L"\"compositionText\":\"\""
  );
  emptyComposeResponse = replaceOnce(emptyComposeResponse, L"\"displayText\":\"\\u0915\"", L"\"displayText\":\"\"");
  emptyComposeResponse = replaceOnce(emptyComposeResponse, L"\"caret\":1", L"\"caret\":0");
  KeyEvent backspaceKey;
  backspaceKey.key = L"Backspace";
  backspaceKey.code = L"Backspace";
  require(parseProcessKeyResponse(
    emptyComposeResponse, keyMetadata, L"server-1", expectedSession, backspaceKey, true
  ).has_value(), "active-composition Backspace response rejected");
  require(!parseProcessKeyResponse(
    emptyComposeResponse, keyMetadata, L"server-1", expectedSession, backspaceKey, false
  ), "Backspace response accepted without an active composition");

  const std::wstring cancelResponse = replaceOnce(
    emptyComposeResponse,
    L"\"action\":\"compose\"",
    L"\"action\":\"cancel\""
  );
  KeyEvent escapeKey;
  escapeKey.key = L"Escape";
  escapeKey.code = L"Escape";
  require(parseProcessKeyResponse(
    cancelResponse, keyMetadata, L"server-1", expectedSession, escapeKey, true
  ).has_value(), "active-composition Escape response rejected");
  require(!parseProcessKeyResponse(
    replaceOnce(cancelResponse, L"\"caret\":0", L"\"committedText\":\"\",\"caret\":0"),
    keyMetadata,
    L"server-1",
    expectedSession,
    escapeKey,
    true
  ), "cancel response carrying explicitly empty committed text was accepted");
  require(!parseProcessKeyResponse(
    replaceOnce(cancelResponse, L"\"caret\":0", L"\"caret\":0,\"consumedRange\":[0,0]"),
    keyMetadata,
    L"server-1",
    expectedSession,
    escapeKey,
    true
  ), "cancel response carrying a consumed range was accepted");
  require(!parseProcessKeyResponse(
    cancelResponse, keyMetadata, L"server-1", expectedSession, key, true
  ), "letter response was allowed to cancel the active composition");

  std::wstring splitSurrogateCaretResponse = replaceOnce(
    composeResponse,
    L"\"compositionText\":\"k\"",
    L"\"compositionText\":\"\\ud83d\\ude00\""
  );
  splitSurrogateCaretResponse = replaceOnce(
    splitSurrogateCaretResponse,
    L"\"action\":\"compose\"",
    L"\"action\":\"passThrough\""
  );
  require(!parseProcessKeyResponse(
    splitSurrogateCaretResponse, keyMetadata, L"server-1", expectedSession, key, false
  ), "caret that splits a UTF-16 surrogate pair was accepted");
  std::wstring splitSurrogateRangeResponse = replaceOnce(
    splitSurrogateCaretResponse,
    L"\"caret\":1",
    L"\"caret\":2"
  );
  splitSurrogateRangeResponse = replaceOnce(
    splitSurrogateRangeResponse,
    L"\"candidates\":[]",
    L"\"candidates\":[{\"id\":\"candidate-1\",\"text\":\"x\",\"type\":\"word\","
    L"\"confidence\":1,\"reason\":[],\"replaceRange\":[0,1]}]"
  );
  require(!parseProcessKeyResponse(
    splitSurrogateRangeResponse, keyMetadata, L"server-1", expectedSession, key, false
  ), "candidate range that splits a UTF-16 surrogate pair was accepted");
  std::wstring astralProofResponse = replaceOnce(
    splitSurrogateCaretResponse,
    L"\"caret\":1",
    L"\"caret\":2"
  );
  astralProofResponse = replaceOnce(
    astralProofResponse,
    L"\"proofHints\":[]",
    L"\"proofHints\":[{\"range\":[0,2],\"original\":\"\\ud83d\\ude00\","
    L"\"suggestion\":\"x\",\"type\":\"spelling\",\"confidence\":1,"
    L"\"action\":\"hint-only\",\"explanation\":\"test\"}]"
  );
  require(parseProcessKeyResponse(
    astralProofResponse, keyMetadata, L"server-1", expectedSession, key, false
  ).has_value(), "proof hint covering a complete astral scalar was rejected");
  require(!parseProcessKeyResponse(
    replaceOnce(astralProofResponse, L"\"range\":[0,2]", L"\"range\":[0,1]"),
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "proof-hint range that splits a UTF-16 surrogate pair was accepted");
  require(!parseProcessKeyResponse(
    L"{\"id\":\"key_1\",\"type\":\"session.processKeyStroke\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":3,\"sessionEpoch\":7,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"mode\":\"romanized-traditional\","
    L"\"surface\":\"romanized-to-unicode\",\"action\":\"unknown\",\"compositionText\":\"\","
    L"\"displayText\":\"\",\"caret\":0,\"candidates\":[],\"proofHints\":[],"
    L"\"shouldShowCandidateUI\":false,\"confidence\":1,\"warnings\":[],\"schemaVersion\":1}}",
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "unknown host action accepted");
  require(!parseProcessKeyResponse(
    L"{\"id\":\"key_1\",\"type\":\"session.processKeyStroke\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":3,\"sessionEpoch\":7,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"mode\":\"romanized-traditional\","
    L"\"surface\":\"romanized-to-unicode\",\"action\":\"compose\",\"compositionText\":\"\","
    L"\"displayText\":\"\\ud800\",\"caret\":0,\"candidates\":[],\"proofHints\":[],"
    L"\"shouldShowCandidateUI\":false,\"confidence\":1,\"warnings\":[],\"schemaVersion\":1}}",
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "unpaired surrogate accepted");
  std::wstring rawUnpairedSurrogate = composeResponse;
  rawUnpairedSurrogate = replaceOnce(
    rawUnpairedSurrogate,
    L"\"displayText\":\"\\u0915\"",
    L"\"displayText\":\"" + std::wstring(1, static_cast<wchar_t>(0xd800)) + L"\""
  );
  require(!parseProcessKeyResponse(
    rawUnpairedSurrogate,
    keyMetadata,
    L"server-1",
    expectedSession,
    key,
    false
  ), "raw unpaired surrogate accepted");
  require(!parseBeginSessionResponse(
    L"{\"id\":\"begin_1\",\"type\":\"session.begin\",\"version\":2\u0967,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":2,\"sessionEpoch\":7,"
    L"\"payload\":{\"sessionId\":\"s\",\"sessionEpoch\":7}}",
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
  require(!parseSessionResponse(
    L"{\"id\":\"end_1\",\"type\":\"session.end\",\"version\":2,\"ok\":true,"
    L"\"serverInstanceId\":\"server-1\",\"requestSequence\":5,\"sessionEpoch\":7,"
    L"\"payload\":{\"ended\":true,\"unexpected\":true}}",
    endMetadata,
    L"server-1",
    expectedSession,
    SessionCommand::End
  ), "unknown session acknowledgement field accepted");

  RequestMetadata invalidDeadline = request(L"invalid", 6, 100, 99);
  require(makeBeginSessionRequest(invalidDeadline).empty(), "invalid deadline metadata was serialized");

  std::cout << "TSF protocol v2 tests passed\n";
  return 0;
}
