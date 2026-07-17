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

} // namespace

int main() {
  using namespace lekh::tsf;

  const std::wstring begin = makeBeginSessionRequest(L"begin_\"1", 42);
  require(begin.find(L"\"type\":\"session.begin\"") != std::wstring::npos, "begin request type missing");
  require(begin.find(L"begin_\\\"1") != std::wstring::npos, "request id was not escaped");
  require(begin.find(L"\"leftTextWindow\":\"\"") != std::wstring::npos, "begin request must not send surrounding text");
  require(begin.find(L"\"secureInput\":false") != std::wstring::npos, "safe context was not explicit");

  const std::wstring beginResponse =
    L"{\"id\":\"begin_1\",\"type\":\"session.begin\",\"version\":1,\"ok\":true,"
    L"\"payload\":{\"sessionId\":\"session-1\"}}";
  require(parseBeginSessionResponse(beginResponse, L"begin_1") == L"session-1", "valid begin response rejected");
  require(!parseBeginSessionResponse(beginResponse, L"wrong"), "mismatched request id accepted");
  require(!parseBeginSessionResponse(
    L"{\"id\":\"begin_1\",\"id\":\"wrong\",\"type\":\"session.begin\",\"version\":1,\"ok\":true,\"payload\":{\"sessionId\":\"s\"}}",
    L"begin_1"
  ), "duplicate JSON key accepted");
  require(!parseBeginSessionResponse(
    L"{\"id\":\"begin_1\",\"type\":\"session.begin\",\"version\":1,\"ok\":false,\"payload\":{\"sessionId\":\"s\"}}",
    L"begin_1"
  ), "failed response accepted");

  KeyEvent key;
  key.key = L"k";
  key.code = L"KeyK";
  key.shift = true;
  key.repeat = true;
  key.timestamp = 88;
  key.nativeCode = 75;
  const std::wstring process = makeProcessKeyRequest(L"key_1", L"session-1", key, 88);
  require(process.find(L"\"key\":\"k\"") != std::wstring::npos, "logical key missing");
  require(process.find(L"\"shift\":true") != std::wstring::npos, "shift state missing");
  require(process.find(L"\"isRepeat\":true") != std::wstring::npos, "repeat state missing");
  require(process.find(L"\"nativeCode\":75") != std::wstring::npos, "native code missing");

  const std::wstring composeResponse =
    L"{\"id\":\"key_1\",\"type\":\"session.processKeyStroke\",\"version\":1,\"ok\":true,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"action\":\"compose\",\"compositionText\":\"ka\","
    L"\"displayText\":\"\\u0915\\u093e\",\"caret\":2}}";
  const auto compose = parseProcessKeyResponse(composeResponse, L"key_1", L"session-1");
  require(compose && compose->action == EngineAction::Compose, "valid compose response rejected");
  require(compose->displayText == L"\u0915\u093e", "escaped Unicode was not decoded");

  const std::wstring commitResponse =
    L"{\"id\":\"key_2\",\"type\":\"session.processKeyStroke\",\"version\":1,\"ok\":true,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"action\":\"commit\",\"compositionText\":\"\","
    L"\"displayText\":\"\",\"committedText\":\"\\u0915\\u093e \",\"caret\":0}}";
  const auto commit = parseProcessKeyResponse(commitResponse, L"key_2", L"session-1");
  require(commit && commit->action == EngineAction::Commit, "valid commit response rejected");
  require(commit->committedText == L"\u0915\u093e ", "committed text was not decoded");

  require(!parseProcessKeyResponse(composeResponse, L"key_1", L"other-session"), "cross-session response accepted");
  require(!parseProcessKeyResponse(
    L"{\"id\":\"key_1\",\"type\":\"session.processKeyStroke\",\"version\":1,\"ok\":true,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"action\":\"unknown\",\"compositionText\":\"\",\"displayText\":\"\",\"caret\":0}}",
    L"key_1",
    L"session-1"
  ), "unknown host action accepted");
  require(!parseProcessKeyResponse(
    L"{\"id\":\"key_1\",\"type\":\"session.processKeyStroke\",\"version\":1,\"ok\":true,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"action\":\"commit\",\"compositionText\":\"\",\"displayText\":\"\",\"caret\":0}}",
    L"key_1",
    L"session-1"
  ), "commit without committed text accepted");
  require(!parseProcessKeyResponse(
    L"{\"id\":\"key_1\",\"type\":\"session.processKeyStroke\",\"version\":1,\"ok\":true,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"action\":\"compose\",\"compositionText\":\"\",\"displayText\":\"\\ud800\",\"caret\":0}}",
    L"key_1",
    L"session-1"
  ), "unpaired surrogate accepted");
  require(!parseProcessKeyResponse(
    L"{\"id\":\"key_1\",\"type\":\"session.processKeyStroke\",\"version\":1,\"ok\":true,"
    L"\"payload\":{\"sessionId\":\"session-1\",\"action\":\"compose\",\"compositionText\":\"a\",\"displayText\":\"a\",\"caret\":2}}",
    L"key_1",
    L"session-1"
  ), "out-of-range caret accepted");
  require(!parseBeginSessionResponse(
    L"{\"id\":\"begin_1\",\"type\":\"session.begin\",\"version\":1\u0967,\"ok\":true,\"payload\":{\"sessionId\":\"s\"}}",
    L"begin_1"
  ), "non-ASCII JSON digit accepted");

  const std::wstring endRequest = makeSessionRequest(L"end_1", L"session-1", SessionCommand::End, 99);
  require(endRequest.find(L"\"type\":\"session.end\"") != std::wstring::npos, "end request type missing");
  require(parseSessionResponse(
    L"{\"id\":\"end_1\",\"type\":\"session.end\",\"version\":1,\"ok\":true,\"payload\":{\"ended\":true}}",
    L"end_1",
    SessionCommand::End
  ), "valid end response rejected");

  std::cout << "TSF protocol tests passed\n";
  return 0;
}
