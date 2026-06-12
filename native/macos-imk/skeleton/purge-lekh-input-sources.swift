import Carbon
import Foundation

let preferencesURL = URL(fileURLWithPath: NSHomeDirectory())
  .appendingPathComponent("Library/Preferences/com.apple.HIToolbox.plist")
let thirdPartyInputSourcesURL = URL(fileURLWithPath: NSHomeDirectory())
  .appendingPathComponent("Library/Preferences/com.apple.inputsources.plist")

func killPreferenceAndInputSourceAgents() {
  let killall = Process()
  killall.executableURL = URL(fileURLWithPath: "/usr/bin/killall")
  killall.arguments = [
    "cfprefsd",
    "TextInputMenuAgent",
    "TextInputSwitcher",
    "imklaunchagent"
  ]
  try? killall.run()
  killall.waitUntilExit()
}

killPreferenceAndInputSourceAgents()
Thread.sleep(forTimeInterval: 0.25)

guard let preferences = NSMutableDictionary(contentsOf: preferencesURL) else {
  fputs("Could not read HIToolbox preferences at \(preferencesURL.path)\n", stderr)
  exit(1)
}

let timestamp = ISO8601DateFormatter()
  .string(from: Date())
  .replacingOccurrences(of: ":", with: "-")
let backupURL = preferencesURL
  .deletingLastPathComponent()
  .appendingPathComponent("com.apple.HIToolbox.plist.lekh-backup-\(timestamp)")
try? FileManager.default.copyItem(at: preferencesURL, to: backupURL)
let thirdPartyBackupURL = thirdPartyInputSourcesURL
  .deletingLastPathComponent()
  .appendingPathComponent("com.apple.inputsources.plist.lekh-backup-\(timestamp)")
if FileManager.default.fileExists(atPath: thirdPartyInputSourcesURL.path) {
  try? FileManager.default.copyItem(at: thirdPartyInputSourcesURL, to: thirdPartyBackupURL)
}

let staleBundleIds: Set<String> = [
  "com.lekh.inputmethod.LekhKeyboard",
  "com.lekh.inputmethod.keyboard",
  "com.lekh.inputmethod.keyboard.dev"
]

let abcSource: [String: Any] = [
  "InputSourceKind": "Keyboard Layout",
  "KeyboardLayout ID": 252,
  "KeyboardLayout Name": "ABC"
]

func isLekhInputSource(_ dictionary: [String: Any]) -> Bool {
  for (key, value) in dictionary {
    guard let stringValue = value as? String else { continue }
    let lowercased = stringValue.lowercased()
    if key == "Bundle ID" {
      if staleBundleIds.contains(stringValue) ||
         stringValue.hasPrefix("com.lekh.inputmethod.") ||
         lowercased.contains("lekh") {
        return true
      }
    }
    if key == "Input Mode",
       (stringValue.hasPrefix("com.lekh.inputmethod.") || lowercased.contains("lekh")) {
      return true
    }
    if key == "InputSourceKind", lowercased.contains("lekh") {
      return true
    }
    if lowercased == "lekh keyboard" {
      return true
    }
  }
  return false
}

func fingerprint(_ dictionary: [String: Any]) -> String {
  dictionary.keys.sorted().map { key in
    "\(key)=\(String(describing: dictionary[key] ?? ""))"
  }.joined(separator: "\u{1f}")
}

func sanitizedArray(_ value: Any?) -> ([[String: Any]], Int) {
  let array = value as? NSArray ?? []
  var result: [[String: Any]] = []
  var seen = Set<String>()
  var removed = 0

  for item in array {
    guard let dictionary = item as? [String: Any] else {
      removed += 1
      continue
    }
    if isLekhInputSource(dictionary) {
      removed += 1
      continue
    }
    let key = fingerprint(dictionary)
    if seen.contains(key) {
      removed += 1
      continue
    }
    seen.insert(key)
    result.append(dictionary)
  }

  return (result, removed)
}

func containsABC(_ array: [[String: Any]]) -> Bool {
  array.contains { dictionary in
    dictionary["InputSourceKind"] as? String == "Keyboard Layout" &&
    dictionary["KeyboardLayout Name"] as? String == "ABC"
  }
}

func ensureABC(_ array: [[String: Any]]) -> [[String: Any]] {
  if containsABC(array) {
    return array
  }
  return array + [abcSource]
}

var totalRemoved = 0
for key in ["AppleEnabledInputSources", "AppleInputSourceHistory", "AppleSelectedInputSources"] {
  let (array, removed) = sanitizedArray(preferences[key])
  totalRemoved += removed

  if key == "AppleInputSourceHistory" {
    preferences[key] = [abcSource]
  } else {
    preferences[key] = ensureABC(array)
  }
}

preferences["AppleCurrentKeyboardLayoutInputSourceID"] = "com.apple.keylayout.ABC"
preferences["AppleInputSourceUpdateTime"] = Date()

guard preferences.write(to: preferencesURL, atomically: true) else {
  fputs("Could not write HIToolbox preferences at \(preferencesURL.path)\n", stderr)
  exit(2)
}

if let thirdPartyPreferences = NSMutableDictionary(contentsOf: thirdPartyInputSourcesURL) {
  let (enabledThirdParty, _) = sanitizedArray(thirdPartyPreferences["AppleEnabledThirdPartyInputSources"])
  thirdPartyPreferences["AppleEnabledThirdPartyInputSources"] = enabledThirdParty
  if !thirdPartyPreferences.write(to: thirdPartyInputSourcesURL, atomically: true) {
    fputs("Could not write input source preferences at \(thirdPartyInputSourcesURL.path)\n", stderr)
  }
}

let notificationCenter = CFNotificationCenterGetDistributedCenter()
CFNotificationCenterPostNotification(
  notificationCenter,
  CFNotificationName(kTISNotifyEnabledKeyboardInputSourcesChanged),
  nil,
  nil,
  true
)

for inputSourceId in ["com.apple.keylayout.ABC", "com.apple.keylayout.US"] {
  let query = [kTISPropertyInputSourceID as String: inputSourceId] as CFDictionary
  guard let unmanagedList = TISCreateInputSourceList(query, false) else { continue }
  let list = unmanagedList.takeRetainedValue() as NSArray
  guard let first = list.firstObject else { continue }
  let source = first as! TISInputSource
  _ = TISEnableInputSource(source)
  if TISSelectInputSource(source) == noErr {
    break
  }
}

killPreferenceAndInputSourceAgents()

print("Purged stale Lekh input-source preference entries. removed=\(totalRemoved)")
