import Carbon
import Foundation

let stalePrefixes = [
  "com.lekh.inputmethod."
]

let staleExact: Set<String> = [
  "com.lekh.inputmethod.LekhKeyboard",
  "com.lekh.inputmethod.LekhKeyboard.Romanized",
  "com.lekh.inputmethod.LekhKeyboard.Main",
  "com.lekh.inputmethod.keyboard",
  "com.lekh.inputmethod.keyboard.dev"
]

let preferenceDomains: [CFString] = [
  "com.apple.HIToolbox" as CFString,
  "com.apple.inputsources" as CFString
]

let preferenceArrayKeys: [CFString] = [
  "AppleEnabledInputSources" as CFString,
  "AppleSelectedInputSources" as CFString,
  "AppleEnabledThirdPartyInputSources" as CFString,
  "AppleInputSourceHistory" as CFString
]

func stringProperty(_ source: TISInputSource, _ key: CFString) -> String {
  TISGetInputSourceProperty(source, key)
    .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
}

func isLekhIdentifier(_ value: String) -> Bool {
  if staleExact.contains(value) { return true }
  return stalePrefixes.contains(where: { value.hasPrefix($0) })
}

func isLekhSource(_ source: TISInputSource) -> Bool {
  let id = stringProperty(source, kTISPropertyInputSourceID)
  if isLekhIdentifier(id) { return true }
  let localizedName = stringProperty(source, kTISPropertyLocalizedName)
  return localizedName.localizedCaseInsensitiveContains("Lekh")
}

func dictionaryContainsLekh(_ value: Any) -> Bool {
  guard let dictionary = value as? [AnyHashable: Any] else { return false }
  for (key, item) in dictionary {
    let keyString = String(describing: key)
    if keyString.localizedCaseInsensitiveContains("lekh") {
      return true
    }
    if let itemString = item as? String {
      if isLekhIdentifier(itemString) || itemString.localizedCaseInsensitiveContains("lekh") {
        return true
      }
    } else if let nestedDictionary = item as? [AnyHashable: Any],
              dictionaryContainsLekh(nestedDictionary) {
      return true
    } else if let nestedArray = item as? [Any],
              nestedArray.contains(where: dictionaryContainsLekh) {
      return true
    }
  }
  return false
}

func purgePreferenceArrays() -> Int {
  var removed = 0
  for domain in preferenceDomains {
    for key in preferenceArrayKeys {
      guard let value = CFPreferencesCopyAppValue(key, domain) else { continue }
      if let array = value as? [Any] {
        let filtered = array.filter { !dictionaryContainsLekh($0) }
        guard filtered.count != array.count else { continue }
        removed += array.count - filtered.count
        CFPreferencesSetAppValue(key, filtered as CFArray, domain)
      }
    }
    CFPreferencesAppSynchronize(domain)
  }
  return removed
}

func postInputSourceChangeNotification() {
  CFNotificationCenterPostNotification(
    CFNotificationCenterGetDistributedCenter(),
    CFNotificationName(kTISNotifyEnabledKeyboardInputSourcesChanged),
    nil,
    nil,
    true
  )
}

guard let unmanagedList = TISCreateInputSourceList(nil, true) else {
  fputs("Could not read input source list through TIS.\n", stderr)
  exit(1)
}

let list = unmanagedList.takeRetainedValue() as NSArray
var disabled = 0
var failed = 0
let preferenceRowsRemoved = purgePreferenceArrays()

for item in list {
  let source = item as! TISInputSource
  guard isLekhSource(source) else { continue }
  let status = TISDisableInputSource(source)
  if status == noErr {
    disabled += 1
  } else {
    failed += 1
    fputs("Could not disable stale Lekh input source \(stringProperty(source, kTISPropertyInputSourceID)); status=\(status)\n", stderr)
  }
}

postInputSourceChangeNotification()
print("Purged stale Lekh input sources. tisDisabled=\(disabled) preferenceRowsRemoved=\(preferenceRowsRemoved) failed=\(failed)")
exit(failed == 0 ? 0 : 2)
