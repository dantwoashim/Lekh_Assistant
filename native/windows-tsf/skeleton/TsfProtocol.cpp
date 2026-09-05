#include "TsfProtocol.h"

#include "../../shared/ipc/generated/LekhIPCProtocol.generated.h"

#include <climits>
#include <cmath>
#include <cwctype>
#include <limits>
#include <map>
#include <set>
#include <utility>
#include <vector>

namespace lekh::tsf {
namespace {

constexpr std::size_t kMaximumJsonDepth = 32;
constexpr std::size_t kMaximumStringLength = 64 * 1024;

enum class JsonType {
  Null,
  Boolean,
  Number,
  String,
  Object,
  Array
};

struct JsonValue {
  JsonType type = JsonType::Null;
  bool boolean = false;
  double number = 0;
  std::wstring string;
  std::map<std::wstring, JsonValue> object;
  std::vector<JsonValue> array;
};

class JsonParser {
public:
  explicit JsonParser(const std::wstring& input) : input_(input) {}

  std::optional<JsonValue> parse() {
    JsonValue value;
    skipWhitespace();
    if (!parseValue(value, 0)) return std::nullopt;
    skipWhitespace();
    if (position_ != input_.size()) return std::nullopt;
    return value;
  }

private:
  bool parseValue(JsonValue& output, std::size_t depth) {
    if (depth > kMaximumJsonDepth || position_ >= input_.size()) return false;
    switch (input_[position_]) {
      case L'n': return parseLiteral(L"null", JsonType::Null, output);
      case L't': return parseBoolean(L"true", true, output);
      case L'f': return parseBoolean(L"false", false, output);
      case L'"':
        output.type = JsonType::String;
        return parseString(output.string);
      case L'{': return parseObject(output, depth + 1);
      case L'[': return parseArray(output, depth + 1);
      default: return parseNumber(output);
    }
  }

  bool parseLiteral(const wchar_t* literal, JsonType type, JsonValue& output) {
    const std::wstring value(literal);
    if (input_.compare(position_, value.size(), value) != 0) return false;
    position_ += value.size();
    output.type = type;
    return true;
  }

  bool parseBoolean(const wchar_t* literal, bool value, JsonValue& output) {
    if (!parseLiteral(literal, JsonType::Boolean, output)) return false;
    output.boolean = value;
    return true;
  }

  bool parseObject(JsonValue& output, std::size_t depth) {
    output.type = JsonType::Object;
    ++position_;
    skipWhitespace();
    if (consume(L'}')) return true;

    while (position_ < input_.size()) {
      std::wstring key;
      if (!parseString(key)) return false;
      skipWhitespace();
      if (!consume(L':')) return false;
      skipWhitespace();
      JsonValue value;
      if (!parseValue(value, depth)) return false;
      if (!output.object.emplace(std::move(key), std::move(value)).second) return false;
      skipWhitespace();
      if (consume(L'}')) return true;
      if (!consume(L',')) return false;
      skipWhitespace();
    }
    return false;
  }

  bool parseArray(JsonValue& output, std::size_t depth) {
    output.type = JsonType::Array;
    ++position_;
    skipWhitespace();
    if (consume(L']')) return true;

    while (position_ < input_.size()) {
      JsonValue value;
      if (!parseValue(value, depth)) return false;
      output.array.push_back(std::move(value));
      skipWhitespace();
      if (consume(L']')) return true;
      if (!consume(L',')) return false;
      skipWhitespace();
    }
    return false;
  }

  bool parseString(std::wstring& output) {
    if (!consume(L'"')) return false;
    while (position_ < input_.size()) {
      const wchar_t character = input_[position_++];
      if (character == L'"') return output.size() <= kMaximumStringLength;
      if (character < 0x20) return false;
      if (character != L'\\') {
        output.push_back(character);
      } else {
        if (position_ >= input_.size()) return false;
        const wchar_t escaped = input_[position_++];
        switch (escaped) {
          case L'"': output.push_back(L'"'); break;
          case L'\\': output.push_back(L'\\'); break;
          case L'/': output.push_back(L'/'); break;
          case L'b': output.push_back(L'\b'); break;
          case L'f': output.push_back(L'\f'); break;
          case L'n': output.push_back(L'\n'); break;
          case L'r': output.push_back(L'\r'); break;
          case L't': output.push_back(L'\t'); break;
          case L'u': {
            std::uint32_t codeUnit = 0;
            if (!parseHexCodeUnit(codeUnit)) return false;
            if (!appendEscapedCodeUnit(codeUnit, output)) return false;
            break;
          }
          default: return false;
        }
      }
      if (output.size() > kMaximumStringLength) return false;
    }
    return false;
  }

  bool appendEscapedCodeUnit(std::uint32_t first, std::wstring& output) {
    if (first >= 0xd800 && first <= 0xdbff) {
      if (position_ + 6 > input_.size() || input_[position_] != L'\\' || input_[position_ + 1] != L'u') return false;
      position_ += 2;
      std::uint32_t second = 0;
      if (!parseHexCodeUnit(second) || second < 0xdc00 || second > 0xdfff) return false;
#if WCHAR_MAX <= 0xffff
      output.push_back(static_cast<wchar_t>(first));
      output.push_back(static_cast<wchar_t>(second));
#else
      const std::uint32_t scalar = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
      output.push_back(static_cast<wchar_t>(scalar));
#endif
      return true;
    }
    if (first >= 0xdc00 && first <= 0xdfff) return false;
    output.push_back(static_cast<wchar_t>(first));
    return true;
  }

  bool parseHexCodeUnit(std::uint32_t& output) {
    if (position_ + 4 > input_.size()) return false;
    output = 0;
    for (int index = 0; index < 4; ++index) {
      const wchar_t character = input_[position_++];
      output <<= 4;
      if (character >= L'0' && character <= L'9') output += character - L'0';
      else if (character >= L'a' && character <= L'f') output += character - L'a' + 10;
      else if (character >= L'A' && character <= L'F') output += character - L'A' + 10;
      else return false;
    }
    return true;
  }

  bool parseNumber(JsonValue& output) {
    const std::size_t start = position_;
    if (consume(L'-') && position_ >= input_.size()) return false;
    if (consume(L'0')) {
      if (position_ < input_.size() && isAsciiDigit(input_[position_])) return false;
    } else {
      if (position_ >= input_.size() || input_[position_] < L'1' || input_[position_] > L'9') return false;
      while (position_ < input_.size() && isAsciiDigit(input_[position_])) ++position_;
    }
    if (consume(L'.')) {
      if (position_ >= input_.size() || !isAsciiDigit(input_[position_])) return false;
      while (position_ < input_.size() && isAsciiDigit(input_[position_])) ++position_;
    }
    if (position_ < input_.size() && (input_[position_] == L'e' || input_[position_] == L'E')) {
      ++position_;
      if (position_ < input_.size() && (input_[position_] == L'+' || input_[position_] == L'-')) ++position_;
      if (position_ >= input_.size() || !isAsciiDigit(input_[position_])) return false;
      while (position_ < input_.size() && isAsciiDigit(input_[position_])) ++position_;
    }

    try {
      output.number = std::stod(input_.substr(start, position_ - start));
    } catch (...) {
      return false;
    }
    if (!std::isfinite(output.number)) return false;
    output.type = JsonType::Number;
    return true;
  }

  bool consume(wchar_t character) {
    if (position_ >= input_.size() || input_[position_] != character) return false;
    ++position_;
    return true;
  }

  static bool isAsciiDigit(wchar_t character) {
    return character >= L'0' && character <= L'9';
  }

  void skipWhitespace() {
    while (position_ < input_.size() && (
      input_[position_] == L' ' || input_[position_] == L'\t' ||
      input_[position_] == L'\n' || input_[position_] == L'\r'
    )) {
      ++position_;
    }
  }

  const std::wstring& input_;
  std::size_t position_ = 0;
};

std::wstring escapeJson(const std::wstring& value) {
  static constexpr wchar_t hex[] = L"0123456789abcdef";
  std::wstring output;
  output.reserve(value.size() + 8);
  for (const wchar_t character : value) {
    switch (character) {
      case L'"': output += L"\\\""; break;
      case L'\\': output += L"\\\\"; break;
      case L'\b': output += L"\\b"; break;
      case L'\f': output += L"\\f"; break;
      case L'\n': output += L"\\n"; break;
      case L'\r': output += L"\\r"; break;
      case L'\t': output += L"\\t"; break;
      default:
        if (character < 0x20) {
          output += L"\\u00";
          output.push_back(hex[(character >> 4) & 0xf]);
          output.push_back(hex[character & 0xf]);
        } else {
          output.push_back(character);
        }
    }
  }
  return output;
}

std::wstring boolJson(bool value) {
  return value ? L"true" : L"false";
}

const JsonValue* member(const JsonValue& value, const wchar_t* key, JsonType type) {
  if (value.type != JsonType::Object) return nullptr;
  const auto found = value.object.find(key);
  if (found == value.object.end() || found->second.type != type) return nullptr;
  return &found->second;
}

const JsonValue* anyMember(const JsonValue& value, const wchar_t* key) {
  if (value.type != JsonType::Object) return nullptr;
  const auto found = value.object.find(key);
  return found == value.object.end() ? nullptr : &found->second;
}

constexpr double kMaximumSafeJsonInteger = 9007199254740991.0;

bool matchesSafeInteger(const JsonValue* value, std::uint64_t expected) {
  return value && value->type == JsonType::Number && value->number >= 0 &&
    value->number <= kMaximumSafeJsonInteger && std::floor(value->number) == value->number &&
    value->number == static_cast<double>(expected);
}

bool validRequestMetadata(const RequestMetadata& metadata) {
  return !metadata.requestId.empty() && metadata.requestId.size() <= 256 &&
    !metadata.clientInstanceId.empty() && metadata.clientInstanceId.size() <= 256 &&
    metadata.requestSequence > 0 && metadata.requestSequence <= static_cast<std::uint64_t>(kMaximumSafeJsonInteger) &&
    metadata.sentAt <= static_cast<std::uint64_t>(kMaximumSafeJsonInteger) &&
    metadata.deadlineAt >= metadata.sentAt &&
    metadata.deadlineAt <= static_cast<std::uint64_t>(kMaximumSafeJsonInteger);
}

std::wstring requestPrefix(const RequestMetadata& metadata, const wchar_t* type) {
  if (!validRequestMetadata(metadata)) return L"";
  return L"{\"id\":\"" + escapeJson(metadata.requestId) +
    L"\",\"type\":\"" + type +
    L"\",\"version\":" + std::to_wstring(lekh::ipc::kSchemaVersion) +
    L",\"sentAt\":" + std::to_wstring(metadata.sentAt) +
    L",\"deadlineAt\":" + std::to_wstring(metadata.deadlineAt) +
    L",\"clientInstanceId\":\"" + escapeJson(metadata.clientInstanceId) +
    L"\",\"requestSequence\":" + std::to_wstring(metadata.requestSequence) +
    L",\"payload\":";
}

bool hasExactEnvelope(
  const JsonValue& root,
  const RequestMetadata& request,
  const wchar_t* expectedType,
  const std::wstring& expectedServerInstanceId
) {
  const JsonValue* id = member(root, L"id", JsonType::String);
  const JsonValue* type = member(root, L"type", JsonType::String);
  const JsonValue* version = member(root, L"version", JsonType::Number);
  const JsonValue* ok = member(root, L"ok", JsonType::Boolean);
  const JsonValue* serverInstanceId = member(root, L"serverInstanceId", JsonType::String);
  const JsonValue* requestSequence = member(root, L"requestSequence", JsonType::Number);
  const bool serverMatches = serverInstanceId && !serverInstanceId->string.empty() && serverInstanceId->string.size() <= 256 &&
    (expectedServerInstanceId.empty() || serverInstanceId->string == expectedServerInstanceId);
  return id && id->string == request.requestId &&
    type && type->string == expectedType &&
    version && version->number == lekh::ipc::kSchemaVersion &&
    ok && ok->boolean && serverMatches && matchesSafeInteger(requestSequence, request.requestSequence);
}

bool hasSessionEpoch(const JsonValue& root, std::uint64_t expectedEpoch) {
  return expectedEpoch > 0 && matchesSafeInteger(member(root, L"sessionEpoch", JsonType::Number), expectedEpoch);
}

bool parseOptionalStringMember(
  const JsonValue& value,
  const wchar_t* key,
  std::size_t maximumLength,
  std::wstring& output
) {
  const JsonValue* candidate = anyMember(value, key);
  if (!candidate) return true;
  if (candidate->type != JsonType::String || candidate->string.size() > maximumLength) return false;
  output = candidate->string;
  return true;
}

bool parseCandidateList(
  const JsonValue& payload,
  std::vector<Candidate>& output,
  bool& shouldShowCandidateUi
) {
  const JsonValue* candidates = member(payload, L"candidates", JsonType::Array);
  const JsonValue* shouldShow = member(payload, L"shouldShowCandidateUI", JsonType::Boolean);
  if (!candidates || !shouldShow || candidates->array.size() > kMaximumCandidateCount) return false;

  std::set<std::wstring> identifiers;
  output.clear();
  output.reserve(candidates->array.size());
  for (const JsonValue& value : candidates->array) {
    const JsonValue* id = member(value, L"id", JsonType::String);
    const JsonValue* text = member(value, L"text", JsonType::String);
    if (!id || id->string.empty() || id->string.size() > 256 || !text || text->string.size() > 16384 ||
        !identifiers.insert(id->string).second) {
      return false;
    }
    Candidate candidate;
    candidate.id = id->string;
    candidate.text = text->string;
    if (!parseOptionalStringMember(value, L"label", 16384, candidate.label) ||
        !parseOptionalStringMember(value, L"shortcut", 256, candidate.shortcut)) {
      return false;
    }
    output.push_back(std::move(candidate));
  }
  shouldShowCandidateUi = shouldShow->boolean && !output.empty();
  return !shouldShow->boolean || !output.empty();
}

bool parseInlineCompletion(const JsonValue& payload, EngineDecision& decision) {
  const JsonValue* value = anyMember(payload, L"inlineCompletion");
  if (!value) return true;
  if (value->type != JsonType::Object) return false;

  const JsonValue* text = member(*value, L"text", JsonType::String);
  const JsonValue* displayText = member(*value, L"displayText", JsonType::String);
  const JsonValue* candidate = member(*value, L"candidate", JsonType::Object);
  const JsonValue* confidence = member(*value, L"confidence", JsonType::Number);
  const JsonValue* source = member(*value, L"source", JsonType::String);
  const JsonValue* acceptKeys = member(*value, L"acceptKeys", JsonType::Array);
  const JsonValue* candidateId = candidate ? member(*candidate, L"id", JsonType::String) : nullptr;
  const JsonValue* candidateText = candidate ? member(*candidate, L"text", JsonType::String) : nullptr;
  if (!text || text->string.empty() || text->string.size() > 16384 ||
      !displayText || displayText->string.empty() || displayText->string.size() > 16384 ||
      !candidateId || candidateId->string.empty() || candidateId->string.size() > 256 ||
      !candidateText || candidateText->string != text->string ||
      !confidence || confidence->number < 0 || confidence->number > 1 ||
      !source || (source->string != L"active-candidate" && source->string != L"ngram-lm") ||
      !acceptKeys || acceptKeys->array.empty() || acceptKeys->array.size() > 2) {
    return false;
  }

  std::set<std::wstring> keys;
  for (const JsonValue& key : acceptKeys->array) {
    if (key.type != JsonType::String || (key.string != L"Tab" && key.string != L"ArrowRight") ||
        !keys.insert(key.string).second) {
      return false;
    }
  }
  decision.inlineCompletionText = text->string;
  decision.inlineCompletionDisplayText = displayText->string;
  return true;
}

const wchar_t* commandType(SessionCommand command) {
  return command == SessionCommand::Cancel ? L"session.cancel" : L"session.end";
}

bool supportedMode(const std::wstring& mode) {
  return mode == L"romanized-romanized" || mode == L"romanized-traditional" ||
    mode == L"traditional-traditional" || mode == L"traditional-romanized";
}

std::wstring enabledSurfaces(const BeginSessionOptions& options, const std::wstring& mode) {
  if (mode == L"romanized-romanized") return L"[\"romanized-to-romanized\"]";
  if (mode == L"traditional-romanized") return L"[\"traditional-to-romanized-helper\"]";
  if (mode == L"traditional-traditional") {
    return options.proofreadAsYouTypeEnabled
      ? L"[\"traditional-to-unicode\",\"traditional-to-traditional-proofread\"]"
      : L"[\"traditional-to-unicode\"]";
  }
  return L"[\"romanized-to-unicode\"]";
}

std::optional<JsonValue> parseResponse(const std::wstring& response) {
  if (response.empty() || response.size() > lekh::ipc::kMaximumFrameBytes) return std::nullopt;
  return JsonParser(response).parse();
}

} // namespace

RequestTiming inspectRequestTiming(const std::wstring& request) {
  RequestTiming timing;
  const std::optional<JsonValue> root = parseResponse(request);
  if (!root || root->type != JsonType::Object) return timing;

  const JsonValue* type = member(*root, L"type", JsonType::String);
  if (type) {
    static const std::set<std::wstring> controlTypes = {
      L"protocol.negotiate",
      L"health.check",
      L"engine.warm",
      L"session.cancel",
      L"session.end",
      L"session.setMode",
      L"session.setLayout",
      L"suggestions.get",
      L"proofHints.get",
      L"dictionary.lookup",
      L"memory.learn",
      L"diagnostics.getMetrics",
      L"engine.shutdown"
    };
    if (controlTypes.find(type->string) != controlTypes.end()) {
      timing.deadlineClass = RequestDeadlineClass::Control;
    }
  }

  const JsonValue* deadline = member(*root, L"deadlineAt", JsonType::Number);
  if (deadline && deadline->number >= 0 && deadline->number <= kMaximumSafeJsonInteger &&
      std::floor(deadline->number) == deadline->number) {
    timing.deadlineAt = static_cast<std::uint64_t>(deadline->number);
    timing.hasValidDeadline = true;
  }
  return timing;
}

std::wstring makeProtocolNegotiationRequest(const RequestMetadata& metadata) {
  const std::wstring prefix = requestPrefix(metadata, L"protocol.negotiate");
  if (prefix.empty()) return L"";
  return prefix + L"{\"client\":\"windows-tsf\",\"supportedVersions\":[" +
    std::to_wstring(lekh::ipc::kSchemaVersion) + L"]}}";
}

std::wstring makeEngineWarmRequest(const RequestMetadata& metadata, std::uint32_t timeoutMs) {
  const std::wstring prefix = requestPrefix(metadata, L"engine.warm");
  if (prefix.empty() || timeoutMs == 0 || timeoutMs > 60000) return L"";
  return prefix + L"{\"timeoutMs\":" + std::to_wstring(timeoutMs) + L"}}";
}

std::wstring makeBeginSessionRequest(const RequestMetadata& metadata, const BeginSessionOptions& options) {
  const std::wstring prefix = requestPrefix(metadata, L"session.begin");
  if (prefix.empty()) return L"";
  const std::wstring mode = supportedMode(options.mode) ? options.mode : L"romanized-traditional";
  const bool traditionalInput = mode == L"traditional-traditional" || mode == L"traditional-romanized";
  return prefix + L"{\"context\":{\"fieldType\":\"normal\",\"leftTextWindow\":\"\",\"rightTextWindow\":\"\"," +
    L"\"locale\":\"ne-NP\",\"activeDomains\":[],\"preserveEnglish\":true,\"secureInput\":false," +
    L"\"mode\":\"" + escapeJson(mode) + L"\",\"layoutId\":\"" +
    (traditionalInput ? L"traditional-ltk-compatible.pending" : L"lekh-romanized") + L"\"," +
    L"\"enabledSurfaces\":" + enabledSurfaces(options, mode) + L",\"showRomanizedLabels\":true," +
    L"\"enablePersonalization\":" + boolJson(options.personalizationEnabled) + L"," +
    L"\"enableNextWordPrediction\":" + boolJson(options.nextWordPredictionEnabled) + L"}}}";
}

std::wstring makeProcessKeyRequest(
  const RequestMetadata& metadata,
  const SessionHandle& session,
  const KeyEvent& key
) {
  const std::wstring prefix = requestPrefix(metadata, L"session.processKeyStroke");
  if (prefix.empty() || session.sessionId.empty() || session.sessionEpoch == 0) return L"";
  return prefix + L"{\"sessionId\":\"" + escapeJson(session.sessionId) +
    L"\",\"sessionEpoch\":" + std::to_wstring(session.sessionEpoch) +
    L",\"key\":{\"key\":\"" + escapeJson(key.key) +
    L"\",\"code\":\"" + escapeJson(key.code) +
    L"\",\"modifiers\":{\"shift\":" + boolJson(key.shift) +
    L",\"ctrl\":" + boolJson(key.ctrl) +
    L",\"alt\":" + boolJson(key.alt) +
    L",\"meta\":" + boolJson(key.meta) +
    L"},\"isRepeat\":" + boolJson(key.repeat) +
    L",\"timestamp\":" + std::to_wstring(key.timestamp) +
    L",\"platform\":\"windows-tsf\",\"nativeCode\":" + std::to_wstring(key.nativeCode) +
    L"}}}";
}

std::wstring makeCommitCandidateRequest(
  const RequestMetadata& metadata,
  const SessionHandle& session,
  const std::wstring& candidateId
) {
  const std::wstring prefix = requestPrefix(metadata, L"session.commitCandidate");
  if (prefix.empty() || session.sessionId.empty() || session.sessionEpoch == 0 ||
      candidateId.empty() || candidateId.size() > 256) {
    return L"";
  }
  return prefix + L"{\"sessionId\":\"" + escapeJson(session.sessionId) +
    L"\",\"sessionEpoch\":" + std::to_wstring(session.sessionEpoch) +
    L",\"candidateId\":\"" + escapeJson(candidateId) + L"\"}}";
}

std::wstring makeSessionRequest(
  const RequestMetadata& metadata,
  const SessionHandle& session,
  SessionCommand command
) {
  const std::wstring prefix = requestPrefix(metadata, commandType(command));
  if (prefix.empty() || session.sessionId.empty() || session.sessionEpoch == 0) return L"";
  return prefix + L"{\"sessionId\":\"" + escapeJson(session.sessionId) +
    L"\",\"sessionEpoch\":" + std::to_wstring(session.sessionEpoch) + L"}}";
}

std::wstring makeMemoryLearnRequest(
  const RequestMetadata& metadata,
  const SessionHandle& session,
  std::uint64_t commitEpoch
) {
  const std::wstring prefix = requestPrefix(metadata, L"memory.learn");
  if (prefix.empty() || session.sessionId.empty() || session.sessionEpoch == 0 || commitEpoch == 0) return L"";
  return prefix + L"{\"sessionId\":\"" + escapeJson(session.sessionId) +
    L"\",\"sessionEpoch\":" + std::to_wstring(session.sessionEpoch) +
    L",\"commitEpoch\":" + std::to_wstring(commitEpoch) + L"}}";
}

std::optional<NegotiatedProtocol> parseProtocolNegotiationResponse(
  const std::wstring& response,
  const RequestMetadata& request
) {
  const std::optional<JsonValue> root = parseResponse(response);
  if (!root || !hasExactEnvelope(*root, request, L"protocol.negotiate", L"")) return std::nullopt;
  const JsonValue* payload = member(*root, L"payload", JsonType::Object);
  const JsonValue* selectedVersion = payload ? member(*payload, L"selectedVersion", JsonType::Number) : nullptr;
  const JsonValue* payloadServer = payload ? member(*payload, L"serverInstanceId", JsonType::String) : nullptr;
  const JsonValue* envelopeServer = member(*root, L"serverInstanceId", JsonType::String);
  if (!matchesSafeInteger(selectedVersion, lekh::ipc::kSchemaVersion) || !payloadServer || !envelopeServer ||
      payloadServer->string != envelopeServer->string) {
    return std::nullopt;
  }
  return NegotiatedProtocol{payloadServer->string, lekh::ipc::kSchemaVersion};
}

bool parseEngineWarmResponse(
  const std::wstring& response,
  const RequestMetadata& request,
  const std::wstring& expectedServerInstanceId
) {
  const std::optional<JsonValue> root = parseResponse(response);
  if (!root || !hasExactEnvelope(*root, request, L"engine.warm", expectedServerInstanceId)) return false;
  const JsonValue* payload = member(*root, L"payload", JsonType::Object);
  const JsonValue* ready = payload ? member(*payload, L"ready", JsonType::Boolean) : nullptr;
  const JsonValue* partial = payload ? member(*payload, L"partial", JsonType::Boolean) : nullptr;
  const JsonValue* unavailable = payload ? member(*payload, L"unavailableModules", JsonType::Array) : nullptr;
  return ready && ready->boolean && partial && !partial->boolean && unavailable && unavailable->array.empty();
}

std::optional<SessionHandle> parseBeginSessionResponse(
  const std::wstring& response,
  const RequestMetadata& request,
  const std::wstring& expectedServerInstanceId
) {
  const std::optional<JsonValue> root = parseResponse(response);
  if (!root || !hasExactEnvelope(*root, request, L"session.begin", expectedServerInstanceId)) return std::nullopt;
  const JsonValue* payload = member(*root, L"payload", JsonType::Object);
  const JsonValue* sessionId = payload ? member(*payload, L"sessionId", JsonType::String) : nullptr;
  const JsonValue* sessionEpoch = payload ? member(*payload, L"sessionEpoch", JsonType::Number) : nullptr;
  if (!sessionId || sessionId->string.empty() || sessionId->string.size() > 256 || !sessionEpoch ||
      sessionEpoch->number < 1 || sessionEpoch->number > kMaximumSafeJsonInteger ||
      std::floor(sessionEpoch->number) != sessionEpoch->number) {
    return std::nullopt;
  }
  return SessionHandle{sessionId->string, static_cast<std::uint64_t>(sessionEpoch->number)};
}

std::optional<EngineDecision> parseProcessKeyResponse(
  const std::wstring& response,
  const RequestMetadata& request,
  const std::wstring& expectedServerInstanceId,
  const SessionHandle& expectedSession
) {
  const std::optional<JsonValue> root = parseResponse(response);
  if (!root || !hasExactEnvelope(*root, request, L"session.processKeyStroke", expectedServerInstanceId) ||
      !hasSessionEpoch(*root, expectedSession.sessionEpoch)) return std::nullopt;
  const JsonValue* payload = member(*root, L"payload", JsonType::Object);
  const JsonValue* sessionId = payload ? member(*payload, L"sessionId", JsonType::String) : nullptr;
  const JsonValue* action = payload ? member(*payload, L"action", JsonType::String) : nullptr;
  const JsonValue* composition = payload ? member(*payload, L"compositionText", JsonType::String) : nullptr;
  const JsonValue* display = payload ? member(*payload, L"displayText", JsonType::String) : nullptr;
  const JsonValue* caret = payload ? member(*payload, L"caret", JsonType::Number) : nullptr;
  if (!sessionId || sessionId->string != expectedSession.sessionId || !action || !composition || !display || !caret ||
      composition->string.size() > 128 || display->string.size() > 16384 ||
      caret->number < 0 || caret->number > static_cast<double>(std::numeric_limits<std::size_t>::max()) ||
      std::floor(caret->number) != caret->number || caret->number > static_cast<double>(composition->string.size())) {
    return std::nullopt;
  }

  EngineDecision decision;
  decision.compositionText = composition->string;
  decision.displayText = display->string;
  decision.caret = static_cast<std::size_t>(caret->number);
  if (!payload || !parseCandidateList(*payload, decision.candidates, decision.shouldShowCandidateUi) ||
      !parseInlineCompletion(*payload, decision)) {
    return std::nullopt;
  }
  if (action->string == L"passThrough" || action->string == L"errorFallback") {
    decision.action = EngineAction::PassThrough;
  } else if (action->string == L"compose") {
    decision.action = EngineAction::Compose;
  } else if (action->string == L"commit") {
    const JsonValue* committed = member(*payload, L"committedText", JsonType::String);
    if (!committed) return std::nullopt;
    decision.action = EngineAction::Commit;
    decision.committedText = committed->string;
  } else if (action->string == L"cancel") {
    decision.action = EngineAction::Cancel;
  } else {
    return std::nullopt;
  }
  return decision;
}

std::optional<EngineDecision> parseCommitCandidateResponse(
  const std::wstring& response,
  const RequestMetadata& request,
  const std::wstring& expectedServerInstanceId,
  const SessionHandle& expectedSession
) {
  const std::optional<JsonValue> root = parseResponse(response);
  if (!root || !hasExactEnvelope(*root, request, L"session.commitCandidate", expectedServerInstanceId) ||
      !hasSessionEpoch(*root, expectedSession.sessionEpoch)) {
    return std::nullopt;
  }
  const JsonValue* payload = member(*root, L"payload", JsonType::Object);
  const JsonValue* sessionId = payload ? member(*payload, L"sessionId", JsonType::String) : nullptr;
  const JsonValue* action = payload ? member(*payload, L"action", JsonType::String) : nullptr;
  const JsonValue* committed = payload ? member(*payload, L"committedText", JsonType::String) : nullptr;
  const JsonValue* commitEpoch = payload ? member(*payload, L"commitEpoch", JsonType::Number) : nullptr;
  const JsonValue* memoryRecorded = payload ? member(*payload, L"memoryRecorded", JsonType::Boolean) : nullptr;
  const JsonValue* schemaVersion = payload ? member(*payload, L"schemaVersion", JsonType::Number) : nullptr;
  if (!sessionId || sessionId->string != expectedSession.sessionId || !action || !committed ||
      committed->string.size() > 16384 || !commitEpoch || !memoryRecorded ||
      !matchesSafeInteger(schemaVersion, 1)) {
    return std::nullopt;
  }

  EngineDecision decision;
  if (action->string == L"commit") {
    if (committed->string.empty() || commitEpoch->number < 1 ||
        commitEpoch->number > kMaximumSafeJsonInteger || std::floor(commitEpoch->number) != commitEpoch->number) {
      return std::nullopt;
    }
    decision.action = EngineAction::Commit;
    decision.committedText = committed->string;
    decision.commitEpoch = static_cast<std::uint64_t>(commitEpoch->number);
  } else if (action->string == L"compose") {
    if (!committed->string.empty() || !matchesSafeInteger(commitEpoch, 0)) return std::nullopt;
    decision.action = EngineAction::Compose;
  } else if (action->string == L"passThrough" || action->string == L"errorFallback") {
    if (!committed->string.empty() || !matchesSafeInteger(commitEpoch, 0)) return std::nullopt;
    decision.action = EngineAction::PassThrough;
  } else {
    return std::nullopt;
  }
  return decision;
}

bool parseSessionResponse(
  const std::wstring& response,
  const RequestMetadata& request,
  const std::wstring& expectedServerInstanceId,
  const SessionHandle& expectedSession,
  SessionCommand command
) {
  const std::optional<JsonValue> root = parseResponse(response);
  if (!root || !hasExactEnvelope(*root, request, commandType(command), expectedServerInstanceId) ||
      !hasSessionEpoch(*root, expectedSession.sessionEpoch)) {
    return false;
  }
  const JsonValue* payload = member(*root, L"payload", JsonType::Object);
  const JsonValue* acknowledged = payload ? member(
    *payload,
    command == SessionCommand::Cancel ? L"cancelled" : L"ended",
    JsonType::Boolean
  ) : nullptr;
  return acknowledged && acknowledged->boolean;
}

bool parseMemoryLearnResponse(
  const std::wstring& response,
  const RequestMetadata& request,
  const std::wstring& expectedServerInstanceId,
  const SessionHandle& expectedSession
) {
  const std::optional<JsonValue> root = parseResponse(response);
  if (!root || !hasExactEnvelope(*root, request, L"memory.learn", expectedServerInstanceId) ||
      !hasSessionEpoch(*root, expectedSession.sessionEpoch)) {
    return false;
  }
  const JsonValue* payload = member(*root, L"payload", JsonType::Object);
  const JsonValue* learned = payload ? member(*payload, L"learned", JsonType::Boolean) : nullptr;
  return learned != nullptr;
}

} // namespace lekh::tsf
