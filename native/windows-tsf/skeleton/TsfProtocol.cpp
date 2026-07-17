#include "TsfProtocol.h"

#include <climits>
#include <cmath>
#include <cwctype>
#include <limits>
#include <map>
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

bool hasExactEnvelope(
  const JsonValue& root,
  const std::wstring& expectedId,
  const wchar_t* expectedType
) {
  const JsonValue* id = member(root, L"id", JsonType::String);
  const JsonValue* type = member(root, L"type", JsonType::String);
  const JsonValue* version = member(root, L"version", JsonType::Number);
  const JsonValue* ok = member(root, L"ok", JsonType::Boolean);
  return id && id->string == expectedId &&
    type && type->string == expectedType &&
    version && version->number == 1 &&
    ok && ok->boolean;
}

const wchar_t* commandType(SessionCommand command) {
  return command == SessionCommand::Cancel ? L"session.cancel" : L"session.end";
}

std::optional<JsonValue> parseResponse(const std::wstring& response) {
  if (response.empty() || response.size() > 64 * 1024) return std::nullopt;
  return JsonParser(response).parse();
}

} // namespace

std::wstring makeBeginSessionRequest(const std::wstring& requestId, std::uint64_t sentAt) {
  return L"{\"id\":\"" + escapeJson(requestId) +
    L"\",\"type\":\"session.begin\",\"version\":1,\"sentAt\":" + std::to_wstring(sentAt) +
    L",\"payload\":{\"context\":{\"fieldType\":\"normal\",\"leftTextWindow\":\"\",\"rightTextWindow\":\"\"," +
    L"\"locale\":\"ne-NP\",\"activeDomains\":[],\"preserveEnglish\":true,\"secureInput\":false," +
    L"\"mode\":\"romanized-traditional\",\"layoutId\":\"lekh-romanized\"," +
    L"\"enabledSurfaces\":[\"romanized-to-unicode\"],\"showRomanizedLabels\":true," +
    L"\"enableNextWordPrediction\":false}}}";
}

std::wstring makeProcessKeyRequest(
  const std::wstring& requestId,
  const std::wstring& sessionId,
  const KeyEvent& key,
  std::uint64_t sentAt
) {
  return L"{\"id\":\"" + escapeJson(requestId) +
    L"\",\"type\":\"session.processKeyStroke\",\"version\":1,\"sentAt\":" + std::to_wstring(sentAt) +
    L",\"payload\":{\"sessionId\":\"" + escapeJson(sessionId) +
    L"\",\"key\":{\"key\":\"" + escapeJson(key.key) +
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

std::wstring makeSessionRequest(
  const std::wstring& requestId,
  const std::wstring& sessionId,
  SessionCommand command,
  std::uint64_t sentAt
) {
  return L"{\"id\":\"" + escapeJson(requestId) +
    L"\",\"type\":\"" + commandType(command) +
    L"\",\"version\":1,\"sentAt\":" + std::to_wstring(sentAt) +
    L",\"payload\":{\"sessionId\":\"" + escapeJson(sessionId) + L"\"}}";
}

std::optional<std::wstring> parseBeginSessionResponse(
  const std::wstring& response,
  const std::wstring& expectedRequestId
) {
  const std::optional<JsonValue> root = parseResponse(response);
  if (!root || !hasExactEnvelope(*root, expectedRequestId, L"session.begin")) return std::nullopt;
  const JsonValue* payload = member(*root, L"payload", JsonType::Object);
  const JsonValue* sessionId = payload ? member(*payload, L"sessionId", JsonType::String) : nullptr;
  if (!sessionId || sessionId->string.empty() || sessionId->string.size() > 256) return std::nullopt;
  return sessionId->string;
}

std::optional<EngineDecision> parseProcessKeyResponse(
  const std::wstring& response,
  const std::wstring& expectedRequestId,
  const std::wstring& expectedSessionId
) {
  const std::optional<JsonValue> root = parseResponse(response);
  if (!root || !hasExactEnvelope(*root, expectedRequestId, L"session.processKeyStroke")) return std::nullopt;
  const JsonValue* payload = member(*root, L"payload", JsonType::Object);
  const JsonValue* sessionId = payload ? member(*payload, L"sessionId", JsonType::String) : nullptr;
  const JsonValue* action = payload ? member(*payload, L"action", JsonType::String) : nullptr;
  const JsonValue* composition = payload ? member(*payload, L"compositionText", JsonType::String) : nullptr;
  const JsonValue* display = payload ? member(*payload, L"displayText", JsonType::String) : nullptr;
  const JsonValue* caret = payload ? member(*payload, L"caret", JsonType::Number) : nullptr;
  if (!sessionId || sessionId->string != expectedSessionId || !action || !composition || !display || !caret ||
      caret->number < 0 || caret->number > static_cast<double>(std::numeric_limits<std::size_t>::max()) ||
      std::floor(caret->number) != caret->number || caret->number > static_cast<double>(composition->string.size())) {
    return std::nullopt;
  }

  EngineDecision decision;
  decision.compositionText = composition->string;
  decision.displayText = display->string;
  decision.caret = static_cast<std::size_t>(caret->number);
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

bool parseSessionResponse(
  const std::wstring& response,
  const std::wstring& expectedRequestId,
  SessionCommand command
) {
  const std::optional<JsonValue> root = parseResponse(response);
  return root && hasExactEnvelope(*root, expectedRequestId, commandType(command));
}

} // namespace lekh::tsf
