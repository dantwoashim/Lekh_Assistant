#include "TsfProtocol.h"

#include "../../shared/ipc/generated/LekhIPCProtocol.generated.h"

#include <algorithm>
#include <charconv>
#include <climits>
#include <cmath>
#include <cwctype>
#include <initializer_list>
#include <limits>
#include <map>
#include <set>
#include <utility>
#include <vector>

namespace lekh::tsf {
namespace {

constexpr std::size_t kMaximumJsonDepth = 32;
constexpr std::size_t kMaximumStringLength = lekh::ipc::kMaximumFrameBytes;

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

bool isWellFormedWideString(const std::wstring& value) {
#if WCHAR_MAX <= 0xffff
  for (std::size_t index = 0; index < value.size(); ++index) {
    const std::uint32_t codeUnit = static_cast<std::uint32_t>(value[index]);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (++index >= value.size()) return false;
      const std::uint32_t trailing = static_cast<std::uint32_t>(value[index]);
      if (trailing < 0xdc00 || trailing > 0xdfff) return false;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
#else
  for (const wchar_t character : value) {
    const std::uint32_t scalar = static_cast<std::uint32_t>(character);
    if ((scalar >= 0xd800 && scalar <= 0xdfff) || scalar > 0x10ffff) return false;
  }
#endif
  return true;
}

std::optional<std::size_t> utf8EncodedLength(const std::wstring& value) {
  std::size_t length = 0;
#if WCHAR_MAX <= 0xffff
  for (std::size_t index = 0; index < value.size(); ++index) {
    std::uint32_t scalar = static_cast<std::uint32_t>(value[index]);
    if (scalar >= 0xd800 && scalar <= 0xdbff) {
      if (++index >= value.size()) return std::nullopt;
      const std::uint32_t trailing = static_cast<std::uint32_t>(value[index]);
      if (trailing < 0xdc00 || trailing > 0xdfff) return std::nullopt;
      scalar = 0x10000 + ((scalar - 0xd800) << 10) + (trailing - 0xdc00);
    } else if (scalar >= 0xdc00 && scalar <= 0xdfff) {
      return std::nullopt;
    }
    length += scalar <= 0x7f ? 1 : scalar <= 0x7ff ? 2 : scalar <= 0xffff ? 3 : 4;
  }
#else
  for (const wchar_t character : value) {
    const std::uint32_t scalar = static_cast<std::uint32_t>(character);
    if ((scalar >= 0xd800 && scalar <= 0xdfff) || scalar > 0x10ffff) return std::nullopt;
    length += scalar <= 0x7f ? 1 : scalar <= 0x7ff ? 2 : scalar <= 0xffff ? 3 : 4;
  }
#endif
  return length;
}

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
#if WCHAR_MAX <= 0xffff
        const std::uint32_t codeUnit = static_cast<std::uint32_t>(character);
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
          if (position_ >= input_.size()) return false;
          const std::uint32_t trailing = static_cast<std::uint32_t>(input_[position_]);
          if (trailing < 0xdc00 || trailing > 0xdfff) return false;
          output.push_back(character);
          output.push_back(input_[position_++]);
        } else {
          if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
          output.push_back(character);
        }
#else
        const std::uint32_t scalar = static_cast<std::uint32_t>(character);
        if ((scalar >= 0xd800 && scalar <= 0xdfff) || scalar > 0x10ffff) return false;
        output.push_back(character);
#endif
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

    const std::wstring token = input_.substr(start, position_ - start);
    std::string asciiToken;
    asciiToken.reserve(token.size());
    for (const wchar_t character : token) {
      if (character > 0x7f) return false;
      asciiToken.push_back(static_cast<char>(character));
    }
    const char* begin = asciiToken.data();
    const char* end = begin + asciiToken.size();
    const auto parsed = std::from_chars(begin, end, output.number, std::chars_format::general);
    if (parsed.ec != std::errc{} || parsed.ptr != end || !std::isfinite(output.number)) return false;
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

constexpr double kMaximumSafeJsonInteger = 9007199254740991.0;

bool matchesSafeInteger(const JsonValue* value, std::uint64_t expected) {
  return value && value->type == JsonType::Number && value->number >= 0 &&
    value->number <= kMaximumSafeJsonInteger && std::floor(value->number) == value->number &&
    value->number == static_cast<double>(expected);
}

bool isSafeInteger(const JsonValue* value, std::uint64_t minimum = 0, std::uint64_t maximum = 9007199254740991ULL) {
  return value && value->type == JsonType::Number && value->number >= static_cast<double>(minimum) &&
    value->number <= static_cast<double>(maximum) && std::floor(value->number) == value->number;
}

bool hasOnlyKeys(const JsonValue& value, std::initializer_list<const wchar_t*> allowed) {
  if (value.type != JsonType::Object) return false;
  for (const auto& entry : value.object) {
    bool found = false;
    for (const wchar_t* key : allowed) {
      if (entry.first == key) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

bool jsonEqual(const JsonValue& left, const JsonValue& right) {
  if (left.type != right.type) return false;
  switch (left.type) {
    case JsonType::Null: return true;
    case JsonType::Boolean: return left.boolean == right.boolean;
    case JsonType::Number: return left.number == right.number;
    case JsonType::String: return left.string == right.string;
    case JsonType::Array:
      if (left.array.size() != right.array.size()) return false;
      for (std::size_t index = 0; index < left.array.size(); ++index) {
        if (!jsonEqual(left.array[index], right.array[index])) return false;
      }
      return true;
    case JsonType::Object:
      if (left.object.size() != right.object.size()) return false;
      for (const auto& [key, value] : left.object) {
        const auto found = right.object.find(key);
        if (found == right.object.end() || !jsonEqual(value, found->second)) return false;
      }
      return true;
  }
  return false;
}

std::size_t utf16Length(const std::wstring& value);

bool boundedString(const JsonValue* value, std::size_t maximum, bool requireNonempty = false) {
  return value && value->type == JsonType::String && utf16Length(value->string) <= maximum &&
    isWellFormedWideString(value->string) && (!requireNonempty || !value->string.empty());
}

bool numberInRange(const JsonValue* value, double minimum, double maximum) {
  return value && value->type == JsonType::Number && value->number >= minimum && value->number <= maximum;
}

bool stringIsOneOf(const JsonValue* value, std::initializer_list<const wchar_t*> allowed) {
  if (!value || value->type != JsonType::String) return false;
  for (const wchar_t* candidate : allowed) {
    if (value->string == candidate) return true;
  }
  return false;
}

bool validStringArray(const JsonValue* value, std::size_t maximumItems, std::size_t maximumLength) {
  if (!value || value->type != JsonType::Array || value->array.size() > maximumItems) return false;
  for (const JsonValue& item : value->array) {
    if (item.type != JsonType::String || utf16Length(item.string) > maximumLength ||
        !isWellFormedWideString(item.string)) {
      return false;
    }
  }
  return true;
}

std::size_t utf16Length(const std::wstring& value) {
#if WCHAR_MAX <= 0xffff
  return value.size();
#else
  std::size_t length = 0;
  for (const wchar_t character : value) {
    length += static_cast<std::uint32_t>(character) > 0xffff ? 2 : 1;
  }
  return length;
#endif
}

bool isUtf16Boundary(const std::wstring& value, std::size_t offset) {
#if WCHAR_MAX <= 0xffff
  if (offset > value.size()) return false;
  if (offset == 0 || offset == value.size()) return true;
  const std::uint32_t previous = static_cast<std::uint32_t>(value[offset - 1]);
  const std::uint32_t current = static_cast<std::uint32_t>(value[offset]);
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
#else
  std::size_t cursor = 0;
  if (offset == 0) return true;
  for (const wchar_t character : value) {
    cursor += static_cast<std::uint32_t>(character) > 0xffff ? 2 : 1;
    if (cursor == offset) return true;
    if (cursor > offset) return false;
  }
  return false;
#endif
}

std::optional<std::size_t> wideIndexAtUtf16Offset(const std::wstring& value, std::size_t offset) {
#if WCHAR_MAX <= 0xffff
  return isUtf16Boundary(value, offset) ? std::optional<std::size_t>(offset) : std::nullopt;
#else
  std::size_t cursor = 0;
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (cursor == offset) return index;
    cursor += static_cast<std::uint32_t>(value[index]) > 0xffff ? 2 : 1;
    if (cursor > offset) return std::nullopt;
  }
  return cursor == offset ? std::optional<std::size_t>(value.size()) : std::nullopt;
#endif
}

bool validUtf16Range(
  const JsonValue* value,
  std::size_t maximumEnd = lekh::ipc::kMaximumTextLength,
  const std::wstring* coordinateText = nullptr
) {
  if (!value || value->type != JsonType::Array || value->array.size() != 2 ||
      !isSafeInteger(&value->array[0], 0, maximumEnd) ||
      !isSafeInteger(&value->array[1], 0, maximumEnd) ||
      value->array[0].number > value->array[1].number) {
    return false;
  }
  if (!coordinateText) return true;
  return isUtf16Boundary(*coordinateText, static_cast<std::size_t>(value->array[0].number)) &&
    isUtf16Boundary(*coordinateText, static_cast<std::size_t>(value->array[1].number));
}

bool validOutboundString(const std::wstring& value, std::size_t maximum, bool requireNonempty = false) {
  return utf16Length(value) <= maximum && isWellFormedWideString(value) &&
    (!requireNonempty || !value.empty());
}

bool validRequestMetadata(const RequestMetadata& metadata) {
  return validOutboundString(metadata.requestId, lekh::ipc::kMaximumIdentifierLength, true) &&
    validOutboundString(metadata.clientInstanceId, lekh::ipc::kMaximumIdentifierLength, true) &&
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
  const std::wstring& expectedServerInstanceId,
  bool requireSessionEpoch
) {
  if (!validRequestMetadata(request) ||
      (std::wstring(expectedType) != L"protocol.negotiate" && expectedServerInstanceId.empty())) {
    return false;
  }
  if (!hasOnlyKeys(
    root,
    requireSessionEpoch
      ? std::initializer_list<const wchar_t*>{
          L"id", L"type", L"version", L"ok", L"serverInstanceId", L"requestSequence",
          L"sessionEpoch", L"payload", L"latencyMs"
        }
      : std::initializer_list<const wchar_t*>{
          L"id", L"type", L"version", L"ok", L"serverInstanceId", L"requestSequence",
          L"payload", L"latencyMs"
        }
  )) {
    return false;
  }
  const JsonValue* id = member(root, L"id", JsonType::String);
  const JsonValue* type = member(root, L"type", JsonType::String);
  const JsonValue* version = member(root, L"version", JsonType::Number);
  const JsonValue* ok = member(root, L"ok", JsonType::Boolean);
  const JsonValue* serverInstanceId = member(root, L"serverInstanceId", JsonType::String);
  const JsonValue* requestSequence = member(root, L"requestSequence", JsonType::Number);
  const JsonValue* payload = member(root, L"payload", JsonType::Object);
  const auto latency = root.object.find(L"latencyMs");
  const bool latencyValid = latency == root.object.end() ||
    (latency->second.type == JsonType::Number && latency->second.number >= 0);
  const bool serverMatches = boundedString(serverInstanceId, lekh::ipc::kMaximumIdentifierLength, true) &&
    (expectedServerInstanceId.empty() || serverInstanceId->string == expectedServerInstanceId);
  return boundedString(id, lekh::ipc::kMaximumIdentifierLength, true) && id->string == request.requestId &&
    type && type->string == expectedType &&
    matchesSafeInteger(version, lekh::ipc::kSchemaVersion) &&
    ok && ok->boolean && serverMatches && matchesSafeInteger(requestSequence, request.requestSequence) && payload &&
    (!requireSessionEpoch || isSafeInteger(member(root, L"sessionEpoch", JsonType::Number), 1)) &&
    latencyValid;
}

bool hasSessionEpoch(const JsonValue& root, std::uint64_t expectedEpoch) {
  return expectedEpoch > 0 && matchesSafeInteger(member(root, L"sessionEpoch", JsonType::Number), expectedEpoch);
}

const JsonValue* optionalMember(const JsonValue& value, const wchar_t* key) {
  if (value.type != JsonType::Object) return nullptr;
  const auto found = value.object.find(key);
  return found == value.object.end() ? nullptr : &found->second;
}

bool validCandidate(const JsonValue& value, const std::wstring* coordinateText = nullptr) {
  if (!hasOnlyKeys(value, {
    L"id", L"text", L"label", L"type", L"confidence", L"reason", L"shortcut", L"replaceRange"
  })) {
    return false;
  }
  if (!boundedString(member(value, L"id", JsonType::String), lekh::ipc::kMaximumIdentifierLength, true) ||
      !boundedString(member(value, L"text", JsonType::String), lekh::ipc::kMaximumTextLength) ||
      !stringIsOneOf(member(value, L"type", JsonType::String), {
        L"word", L"phrase", L"completion", L"correction", L"dictionary", L"personal", L"protected",
        L"romanized-helper"
      }) ||
      !numberInRange(member(value, L"confidence", JsonType::Number), 0, 1) ||
      !validStringArray(member(value, L"reason", JsonType::Array), 16, lekh::ipc::kMaximumTextLength)) {
    return false;
  }
  const JsonValue* label = optionalMember(value, L"label");
  const JsonValue* shortcut = optionalMember(value, L"shortcut");
  const JsonValue* range = optionalMember(value, L"replaceRange");
  const std::size_t maximumRangeEnd = coordinateText ? utf16Length(*coordinateText) : lekh::ipc::kMaximumTextLength;
  return (!label || boundedString(label, lekh::ipc::kMaximumTextLength)) &&
    (!shortcut || boundedString(shortcut, lekh::ipc::kMaximumIdentifierLength)) &&
    (!range || validUtf16Range(range, maximumRangeEnd, coordinateText));
}

bool validCandidateArray(const JsonValue* value, const std::wstring& coordinateText) {
  if (!value || value->type != JsonType::Array || value->array.size() > lekh::ipc::kMaximumCandidateResults) return false;
  std::set<std::wstring> candidateIds;
  for (const JsonValue& candidate : value->array) {
    if (!validCandidate(candidate, &coordinateText)) return false;
    const JsonValue* identifier = member(candidate, L"id", JsonType::String);
    if (!identifier || !candidateIds.insert(identifier->string).second) return false;
  }
  return true;
}

bool candidateMatchesFirst(const JsonValue& candidate, const JsonValue* candidates) {
  return candidates && candidates->type == JsonType::Array && !candidates->array.empty() &&
    jsonEqual(candidate, candidates->array.front());
}

bool validInlineCompletion(const JsonValue& value, const std::wstring& coordinateText) {
  if (!hasOnlyKeys(value, {
    L"text", L"displayText", L"contextText", L"candidate", L"confidence", L"source", L"acceptKeys"
  })) {
    return false;
  }
  const JsonValue* candidate = member(value, L"candidate", JsonType::Object);
  const JsonValue* acceptKeys = member(value, L"acceptKeys", JsonType::Array);
  if (!boundedString(member(value, L"text", JsonType::String), lekh::ipc::kMaximumTextLength) ||
      !boundedString(member(value, L"displayText", JsonType::String), lekh::ipc::kMaximumTextLength) ||
      !boundedString(member(value, L"contextText", JsonType::String), lekh::ipc::kMaximumTextLength) ||
      !candidate || !validCandidate(*candidate, &coordinateText) ||
      !numberInRange(member(value, L"confidence", JsonType::Number), 0, 1) ||
      !stringIsOneOf(member(value, L"source", JsonType::String), {L"active-candidate", L"ngram-lm"}) ||
      !acceptKeys || acceptKeys->array.empty() || acceptKeys->array.size() > 2) {
    return false;
  }
  bool foundTab = false;
  bool foundEnter = false;
  for (const JsonValue& key : acceptKeys->array) {
    if (key.type != JsonType::String) return false;
    if (key.string == L"Tab") {
      if (foundTab) return false;
      foundTab = true;
    } else if (key.string == L"Enter") {
      if (foundEnter) return false;
      foundEnter = true;
    } else {
      return false;
    }
  }
  return true;
}

bool validTerminalInlineCompletion(const JsonValue* value) {
  if (!value) return true;
  const JsonValue* source = member(*value, L"source", JsonType::String);
  return source && source->string == L"ngram-lm";
}

bool validProofHint(const JsonValue& value, const std::wstring& coordinateText) {
  if (!hasOnlyKeys(value, {
    L"range", L"original", L"suggestion", L"type", L"confidence", L"action", L"explanation"
  })) {
    return false;
  }
  const JsonValue* range = member(value, L"range", JsonType::Array);
  const JsonValue* original = member(value, L"original", JsonType::String);
  if (!validUtf16Range(
      range,
      utf16Length(coordinateText),
      &coordinateText
    ) || !boundedString(original, lekh::ipc::kMaximumTextLength)) {
    return false;
  }
  const auto start = wideIndexAtUtf16Offset(coordinateText, static_cast<std::size_t>(range->array[0].number));
  const auto end = wideIndexAtUtf16Offset(coordinateText, static_cast<std::size_t>(range->array[1].number));
  return start && end && coordinateText.substr(*start, *end - *start) == original->string &&
    boundedString(member(value, L"suggestion", JsonType::String), lekh::ipc::kMaximumTextLength) &&
    stringIsOneOf(member(value, L"type", JsonType::String), {
      L"spelling", L"postposition", L"normalization", L"matra", L"halanta", L"compound", L"name-variant",
      L"agreement", L"honorific"
    }) &&
    numberInRange(member(value, L"confidence", JsonType::Number), 0, 1) &&
    stringIsOneOf(member(value, L"action", JsonType::String), {L"auto-suggest", L"hint-only", L"ask"}) &&
    boundedString(member(value, L"explanation", JsonType::String), lekh::ipc::kMaximumTextLength);
}

bool validProofHintArray(const JsonValue* value, const std::wstring& coordinateText) {
  if (!value || value->type != JsonType::Array || value->array.size() > lekh::ipc::kMaximumProofHints) return false;
  for (const JsonValue& hint : value->array) {
    if (!validProofHint(hint, coordinateText)) return false;
  }
  return true;
}

bool validCandidateUpdate(const JsonValue& value, const SessionHandle& expectedSession) {
  if (!hasOnlyKeys(value, {
    L"sessionId", L"mode", L"surface", L"action", L"compositionText", L"displayText", L"caret",
    L"candidates", L"primary", L"inlineCompletion", L"proofHints", L"committedText", L"consumedRange",
    L"shouldShowCandidateUI", L"confidence", L"warnings", L"latencyMs", L"schemaVersion"
  })) {
    return false;
  }
  const JsonValue* sessionId = member(value, L"sessionId", JsonType::String);
  const JsonValue* action = member(value, L"action", JsonType::String);
  const JsonValue* composition = member(value, L"compositionText", JsonType::String);
  const JsonValue* display = member(value, L"displayText", JsonType::String);
  const JsonValue* caret = member(value, L"caret", JsonType::Number);
  const JsonValue* candidates = member(value, L"candidates", JsonType::Array);
  const JsonValue* proofHints = member(value, L"proofHints", JsonType::Array);
  const JsonValue* visible = member(value, L"shouldShowCandidateUI", JsonType::Boolean);
  if (!boundedString(sessionId, lekh::ipc::kMaximumIdentifierLength, true) ||
      sessionId->string != expectedSession.sessionId ||
      !stringIsOneOf(member(value, L"mode", JsonType::String), {
        L"romanized", L"traditional", L"romanized-romanized", L"romanized-traditional",
        L"traditional-traditional", L"traditional-romanized", L"unicode-proofread", L"dictionary-lookup", L"diagnostic"
      }) ||
      !stringIsOneOf(member(value, L"surface", JsonType::String), {
        L"romanized-to-unicode", L"romanized-to-romanized", L"romanized-to-unicode-with-labels",
        L"traditional-to-unicode", L"traditional-to-romanized-helper", L"traditional-to-traditional-proofread"
      }) ||
      !stringIsOneOf(action, {
        L"passThrough", L"compose", L"commit", L"cancel", L"errorFallback"
      }) ||
      !boundedString(composition, lekh::ipc::kMaximumCompositionLength) ||
      !boundedString(display, lekh::ipc::kMaximumTextLength) ||
      !isSafeInteger(caret, 0, utf16Length(composition->string)) ||
      !isUtf16Boundary(composition->string, static_cast<std::size_t>(caret->number)) ||
      !validCandidateArray(candidates, composition->string) ||
      !validProofHintArray(proofHints, composition->string) ||
      !visible || !numberInRange(member(value, L"confidence", JsonType::Number), 0, 1) ||
      !validStringArray(
        member(value, L"warnings", JsonType::Array),
        lekh::ipc::kMaximumResponseListItems,
        lekh::ipc::kMaximumTextLength
      ) ||
      !matchesSafeInteger(member(value, L"schemaVersion", JsonType::Number), 1)) {
    return false;
  }

  const JsonValue* primary = optionalMember(value, L"primary");
  const JsonValue* inlineCompletion = optionalMember(value, L"inlineCompletion");
  const JsonValue* committedText = optionalMember(value, L"committedText");
  const JsonValue* consumedRange = optionalMember(value, L"consumedRange");
  const JsonValue* latency = optionalMember(value, L"latencyMs");
  const bool terminalCommit = action && action->string == L"commit";
  const bool terminalCancel = action && action->string == L"cancel";
  const bool committedTextValid = terminalCommit
    ? boundedString(committedText, lekh::ipc::kMaximumTextLength, true)
    : !committedText;
  const bool consumedRangeValid = terminalCommit
    ? validUtf16Range(consumedRange)
    : !consumedRange;
  const bool clearedTerminalSuggestions = candidates->array.empty() && !primary &&
    validTerminalInlineCompletion(inlineCompletion) && proofHints->array.empty() && !visible->boolean;
  const bool primaryValid = candidates->array.empty()
    ? !primary
    : primary && validCandidate(*primary, &composition->string) && candidateMatchesFirst(*primary, candidates);
  const bool terminalStateValid = (!terminalCommit || (
      composition->string.empty() && display->string.empty() && caret->number == 0 &&
      clearedTerminalSuggestions
    )) && (!terminalCancel || (
      composition->string.empty() && display->string.empty() && caret->number == 0 &&
      clearedTerminalSuggestions
    ));
  return primaryValid &&
    (!inlineCompletion || validInlineCompletion(*inlineCompletion, composition->string)) &&
    committedTextValid &&
    consumedRangeValid &&
    (!latency || numberInRange(latency, 0, std::numeric_limits<double>::max())) &&
    terminalStateValid;
}

bool validNegotiatedLimits(const JsonValue& value) {
  return hasOnlyKeys(value, {
    L"maximumFrameBytes", L"maximumCompositionLength", L"hotPathDeadlineMs",
    L"maximumPendingRequestsPerConnection",
    L"maximumClientInstances", L"clientIdleTtlMs"
  }) &&
    matchesSafeInteger(member(value, L"maximumFrameBytes", JsonType::Number), lekh::ipc::kMaximumFrameBytes) &&
    matchesSafeInteger(
      member(value, L"maximumCompositionLength", JsonType::Number),
      lekh::ipc::kMaximumCompositionLength
    ) &&
    matchesSafeInteger(member(value, L"hotPathDeadlineMs", JsonType::Number), lekh::ipc::kHotPathDeadlineMilliseconds) &&
    matchesSafeInteger(
      member(value, L"maximumPendingRequestsPerConnection", JsonType::Number),
      lekh::ipc::kMaximumPendingRequestsPerConnection
    ) &&
    matchesSafeInteger(member(value, L"maximumClientInstances", JsonType::Number), lekh::ipc::kMaximumClientInstances) &&
    matchesSafeInteger(member(value, L"clientIdleTtlMs", JsonType::Number), lekh::ipc::kClientIdleTtlMilliseconds);
}

bool validDistinctModuleLists(const JsonValue* loadedModules, const JsonValue* unavailableModules) {
  if (!validStringArray(
        loadedModules,
        lekh::ipc::kMaximumResponseListItems,
        lekh::ipc::kMaximumIdentifierLength
      ) || !validStringArray(
        unavailableModules,
        lekh::ipc::kMaximumResponseListItems,
        lekh::ipc::kMaximumIdentifierLength
      )) {
    return false;
  }
  std::set<std::wstring> names;
  for (const JsonValue& module : loadedModules->array) {
    if (module.string.empty() || !names.insert(module.string).second) return false;
  }
  for (const JsonValue& module : unavailableModules->array) {
    if (module.string.empty() || !names.insert(module.string).second) return false;
  }
  return true;
}

const wchar_t* commandType(SessionCommand command) {
  return command == SessionCommand::Cancel ? L"session.cancel" : L"session.end";
}

std::optional<JsonValue> parseResponse(const std::wstring& response) {
  const auto encodedLength = utf8EncodedLength(response);
  if (response.empty() || !encodedLength || *encodedLength > lekh::ipc::kMaximumFrameBytes) return std::nullopt;
  return JsonParser(response).parse();
}

bool validDecisionForExpectedKey(
  const EngineDecision& decision,
  const KeyEvent& expectedKey,
  const std::wstring& expectedCompositionText
) {
  if (decision.action == EngineAction::PassThrough) return true;
  if (expectedKey.ctrl || expectedKey.alt || expectedKey.meta ||
      !validOutboundString(expectedCompositionText, lekh::ipc::kMaximumCompositionLength)) {
    return false;
  }

  const bool romanizedLetter = expectedKey.key.size() == 1 && (
    (expectedKey.key[0] >= L'a' && expectedKey.key[0] <= L'z') ||
    (expectedKey.key[0] >= L'A' && expectedKey.key[0] <= L'Z')
  );
  const bool romanizedComposition = std::all_of(
    decision.compositionText.begin(),
    decision.compositionText.end(),
    [](wchar_t character) {
      return (character >= L'a' && character <= L'z') || (character >= L'A' && character <= L'Z');
    }
  );
  const bool expectedRomanizedComposition = std::all_of(
    expectedCompositionText.begin(),
    expectedCompositionText.end(),
    [](wchar_t character) {
      return (character >= L'a' && character <= L'z') || (character >= L'A' && character <= L'Z');
    }
  );
  if (!expectedRomanizedComposition) return false;
  if (romanizedLetter) {
    const std::wstring expectedNextComposition = expectedCompositionText + expectedKey.key;
    return decision.action == EngineAction::Compose &&
      expectedNextComposition.size() <= lekh::ipc::kMaximumCompositionLength &&
      romanizedComposition && decision.compositionText == expectedNextComposition &&
      decision.caret == decision.compositionText.size() && !decision.displayText.empty();
  }
  if (expectedCompositionText.empty()) return false;
  if (expectedKey.key == L"Backspace") {
    const std::wstring expectedNextComposition = expectedCompositionText.substr(
      0,
      expectedCompositionText.size() - 1
    );
    return decision.action == EngineAction::Compose && romanizedComposition &&
      decision.compositionText == expectedNextComposition && decision.caret == expectedNextComposition.size() &&
      decision.displayText.empty() == expectedNextComposition.empty();
  }
  if (expectedKey.key == L" " || expectedKey.key == L"Enter") {
    const std::wstring expectedCommit = expectedCompositionText +
      (expectedKey.key == L" " ? L" " : L"\n");
    return decision.action == EngineAction::Commit && !decision.committedText.empty() &&
      decision.compositionText.empty() && decision.displayText.empty() &&
      decision.committedText == expectedCommit;
  }
  if (expectedKey.key == L"Escape") {
    return decision.action == EngineAction::Cancel &&
      decision.compositionText.empty() && decision.displayText.empty();
  }
  return false;
}

} // namespace

std::wstring makeProtocolNegotiationRequest(const RequestMetadata& metadata) {
  const std::wstring prefix = requestPrefix(metadata, L"protocol.negotiate");
  if (prefix.empty()) return L"";
  return prefix + L"{\"client\":\"windows-tsf\",\"supportedVersions\":[" +
    std::to_wstring(lekh::ipc::kSchemaVersion) + L"]}}";
}

std::wstring makeEngineWarmRequest(const RequestMetadata& metadata) {
  const std::wstring prefix = requestPrefix(metadata, L"engine.warm");
  if (prefix.empty()) return L"";
  return prefix + L"{\"timeoutMs\":" +
    std::to_wstring(lekh::ipc::kHotPathDeadlineMilliseconds) + L"}}";
}

std::wstring makeBeginSessionRequest(const RequestMetadata& metadata) {
  const std::wstring prefix = requestPrefix(metadata, L"session.begin");
  if (prefix.empty()) return L"";
  return prefix + L"{\"context\":{\"fieldType\":\"normal\",\"leftTextWindow\":\"\",\"rightTextWindow\":\"\"," +
    L"\"locale\":\"ne-NP\",\"activeDomains\":[],\"preserveEnglish\":true,\"secureInput\":false," +
    L"\"mode\":\"romanized-traditional\",\"layoutId\":\"lekh-romanized\"," +
    L"\"enabledSurfaces\":[\"romanized-to-unicode\"],\"showRomanizedLabels\":true," +
    L"\"enableNextWordPrediction\":false}}}";
}

std::wstring makeProcessKeyRequest(
  const RequestMetadata& metadata,
  const SessionHandle& session,
  const KeyEvent& key
) {
  const std::wstring prefix = requestPrefix(metadata, L"session.processKeyStroke");
  if (prefix.empty() ||
      !validOutboundString(session.sessionId, lekh::ipc::kMaximumIdentifierLength, true) ||
      session.sessionEpoch == 0 || session.sessionEpoch > static_cast<std::uint64_t>(kMaximumSafeJsonInteger) ||
      !validOutboundString(key.key, lekh::ipc::kMaximumIdentifierLength, true) ||
      !validOutboundString(key.code, lekh::ipc::kMaximumIdentifierLength, true) ||
      key.timestamp > static_cast<std::uint64_t>(kMaximumSafeJsonInteger)) {
    return L"";
  }
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

std::wstring makeSessionRequest(
  const RequestMetadata& metadata,
  const SessionHandle& session,
  SessionCommand command
) {
  const std::wstring prefix = requestPrefix(metadata, commandType(command));
  if (prefix.empty() ||
      !validOutboundString(session.sessionId, lekh::ipc::kMaximumIdentifierLength, true) ||
      session.sessionEpoch == 0 || session.sessionEpoch > static_cast<std::uint64_t>(kMaximumSafeJsonInteger)) {
    return L"";
  }
  return prefix + L"{\"sessionId\":\"" + escapeJson(session.sessionId) +
    L"\",\"sessionEpoch\":" + std::to_wstring(session.sessionEpoch) + L"}}";
}

std::optional<NegotiatedProtocol> parseProtocolNegotiationResponse(
  const std::wstring& response,
  const RequestMetadata& request
) {
  const std::optional<JsonValue> root = parseResponse(response);
  if (!root || !hasExactEnvelope(*root, request, L"protocol.negotiate", L"", false)) return std::nullopt;
  const JsonValue* payload = member(*root, L"payload", JsonType::Object);
  const JsonValue* selectedVersion = payload ? member(*payload, L"selectedVersion", JsonType::Number) : nullptr;
  const JsonValue* payloadServer = payload ? member(*payload, L"serverInstanceId", JsonType::String) : nullptr;
  const JsonValue* limits = payload ? member(*payload, L"limits", JsonType::Object) : nullptr;
  const JsonValue* envelopeServer = member(*root, L"serverInstanceId", JsonType::String);
  if (!payload || !hasOnlyKeys(*payload, {L"selectedVersion", L"serverInstanceId", L"limits"}) ||
      !matchesSafeInteger(selectedVersion, lekh::ipc::kSchemaVersion) ||
      !boundedString(payloadServer, lekh::ipc::kMaximumIdentifierLength, true) || !envelopeServer ||
      payloadServer->string != envelopeServer->string || !limits || !validNegotiatedLimits(*limits)) {
    return std::nullopt;
  }
  return NegotiatedProtocol{payloadServer->string, lekh::ipc::kSchemaVersion};
}

std::optional<EngineWarmResult> parseEngineWarmResponse(
  const std::wstring& response,
  const RequestMetadata& request,
  const std::wstring& expectedServerInstanceId
) {
  const std::optional<JsonValue> root = parseResponse(response);
  if (!root || !hasExactEnvelope(*root, request, L"engine.warm", expectedServerInstanceId, false)) {
    return std::nullopt;
  }
  const JsonValue* payload = member(*root, L"payload", JsonType::Object);
  if (!payload || !hasOnlyKeys(*payload, {
        L"ready", L"partial", L"loadedModules", L"unavailableModules", L"warmTimeMs", L"warnings"
      })) {
    return std::nullopt;
  }
  const JsonValue* ready = member(*payload, L"ready", JsonType::Boolean);
  const JsonValue* partial = member(*payload, L"partial", JsonType::Boolean);
  const JsonValue* loadedModules = member(*payload, L"loadedModules", JsonType::Array);
  const JsonValue* unavailableModules = member(*payload, L"unavailableModules", JsonType::Array);
  if (!ready || !partial || ready->boolean == partial->boolean ||
      !validDistinctModuleLists(loadedModules, unavailableModules) ||
      !numberInRange(member(*payload, L"warmTimeMs", JsonType::Number), 0, std::numeric_limits<double>::max()) ||
      !validStringArray(
        member(*payload, L"warnings", JsonType::Array),
        lekh::ipc::kMaximumResponseListItems,
        lekh::ipc::kMaximumTextLength
      ) || (ready->boolean && !unavailableModules->array.empty()) ||
      (partial->boolean && unavailableModules->array.empty())) {
    return std::nullopt;
  }
  return EngineWarmResult{ready->boolean, partial->boolean};
}

std::optional<SessionHandle> parseBeginSessionResponse(
  const std::wstring& response,
  const RequestMetadata& request,
  const std::wstring& expectedServerInstanceId
) {
  const std::optional<JsonValue> root = parseResponse(response);
  if (!root || !hasExactEnvelope(*root, request, L"session.begin", expectedServerInstanceId, true)) return std::nullopt;
  const JsonValue* payload = member(*root, L"payload", JsonType::Object);
  const JsonValue* sessionId = payload ? member(*payload, L"sessionId", JsonType::String) : nullptr;
  const JsonValue* sessionEpoch = payload ? member(*payload, L"sessionEpoch", JsonType::Number) : nullptr;
  if (!payload || !hasOnlyKeys(*payload, {L"sessionId", L"sessionEpoch"}) ||
      !boundedString(sessionId, lekh::ipc::kMaximumIdentifierLength, true) || !isSafeInteger(sessionEpoch, 1) ||
      !matchesSafeInteger(member(*root, L"sessionEpoch", JsonType::Number), static_cast<std::uint64_t>(sessionEpoch->number))) {
    return std::nullopt;
  }
  return SessionHandle{sessionId->string, static_cast<std::uint64_t>(sessionEpoch->number)};
}

std::optional<EngineDecision> parseProcessKeyResponse(
  const std::wstring& response,
  const RequestMetadata& request,
  const std::wstring& expectedServerInstanceId,
  const SessionHandle& expectedSession,
  const KeyEvent& expectedKey,
  const std::wstring& expectedCompositionText
) {
  const std::optional<JsonValue> root = parseResponse(response);
  if (!root || !hasExactEnvelope(*root, request, L"session.processKeyStroke", expectedServerInstanceId, true) ||
      !hasSessionEpoch(*root, expectedSession.sessionEpoch)) return std::nullopt;
  const JsonValue* payload = member(*root, L"payload", JsonType::Object);
  if (!payload || !validCandidateUpdate(*payload, expectedSession)) return std::nullopt;
  const JsonValue* sessionId = payload ? member(*payload, L"sessionId", JsonType::String) : nullptr;
  const JsonValue* action = payload ? member(*payload, L"action", JsonType::String) : nullptr;
  const JsonValue* composition = payload ? member(*payload, L"compositionText", JsonType::String) : nullptr;
  const JsonValue* display = payload ? member(*payload, L"displayText", JsonType::String) : nullptr;
  const JsonValue* caret = payload ? member(*payload, L"caret", JsonType::Number) : nullptr;
  if (!sessionId || sessionId->string != expectedSession.sessionId || !action || !composition || !display || !caret ||
      caret->number < 0 || caret->number > static_cast<double>(std::numeric_limits<std::size_t>::max()) ||
      std::floor(caret->number) != caret->number || caret->number > static_cast<double>(utf16Length(composition->string)) ||
      !isUtf16Boundary(composition->string, static_cast<std::size_t>(caret->number))) {
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
    if (!boundedString(committed, lekh::ipc::kMaximumTextLength, true)) return std::nullopt;
    decision.action = EngineAction::Commit;
    decision.committedText = committed->string;
  } else if (action->string == L"cancel") {
    decision.action = EngineAction::Cancel;
  } else {
    return std::nullopt;
  }
  if (!validDecisionForExpectedKey(decision, expectedKey, expectedCompositionText)) return std::nullopt;
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
  if (!root || !hasExactEnvelope(*root, request, commandType(command), expectedServerInstanceId, true) ||
      !hasSessionEpoch(*root, expectedSession.sessionEpoch)) {
    return false;
  }
  const JsonValue* payload = member(*root, L"payload", JsonType::Object);
  const JsonValue* acknowledged = payload ? member(
    *payload,
    command == SessionCommand::Cancel ? L"cancelled" : L"ended",
    JsonType::Boolean
  ) : nullptr;
  return payload && hasOnlyKeys(*payload, {
    command == SessionCommand::Cancel ? L"cancelled" : L"ended"
  }) && acknowledged && acknowledged->boolean;
}

} // namespace lekh::tsf
