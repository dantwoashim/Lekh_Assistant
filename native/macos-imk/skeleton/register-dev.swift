import Carbon
import Foundation

let bundlePath: String
let args = Array(CommandLine.arguments.dropFirst())
let shouldSelect = args.contains("--select")
let shouldDisable = args.contains("--disable")

if let explicitPath = args.first(where: { !$0.hasPrefix("--") }) {
  bundlePath = explicitPath
} else {
  bundlePath = NSHomeDirectory() + "/Library/Input Methods/Lekh Keyboard.app"
}

let bundleURL = URL(fileURLWithPath: bundlePath) as CFURL
let infoPlistURL = URL(fileURLWithPath: bundlePath)
  .appendingPathComponent("Contents/Info.plist")
guard let infoPlist = NSDictionary(contentsOf: infoPlistURL),
      let bundleIdentifier = infoPlist["CFBundleIdentifier"] as? String,
      let parentInputSourceId = (infoPlist["TISInputSourceID"] as? String) ?? (infoPlist["CFBundleIdentifier"] as? String),
      parentInputSourceId == bundleIdentifier,
      !parentInputSourceId.isEmpty else {
  fputs("Could not read matching CFBundleIdentifier/TISInputSourceID from \(infoPlistURL.path)\n", stderr)
  exit(1)
}

func firstInputMode(from infoPlist: NSDictionary) -> (modeId: String, inputSourceId: String)? {
  guard let componentInputModeDict = infoPlist["ComponentInputModeDict"] as? NSDictionary,
        let modeList = componentInputModeDict["tsInputModeListKey"] as? NSDictionary else {
    return nil
  }

  for item in modeList {
    guard let modeId = item.key as? String,
          let modeDictionary = item.value as? NSDictionary else {
      continue
    }
    let inputSourceId = (modeDictionary["TISInputSourceID"] as? String) ?? modeId
    return (modeId, inputSourceId)
  }

  return nil
}

let inputMode = firstInputMode(from: infoPlist)
let inputSourceId = inputMode?.inputSourceId ?? parentInputSourceId
let query = [kTISPropertyInputSourceID as String: inputSourceId] as CFDictionary
let parentQuery = [kTISPropertyInputSourceID as String: parentInputSourceId] as CFDictionary

func stringProperty(_ source: TISInputSource, _ key: CFString) -> String {
  TISGetInputSourceProperty(source, key)
    .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
}

func findInputSourceOnce(inputSourceId: String, query: CFDictionary) -> TISInputSource? {
  if let unmanagedList = TISCreateInputSourceList(query, false) {
    let list = unmanagedList.takeRetainedValue() as NSArray
    if let first = list.firstObject {
      return (first as! TISInputSource)
    }
  }

  if let unmanagedAll = TISCreateInputSourceList(nil, true) {
    let allSources = unmanagedAll.takeRetainedValue() as NSArray
    for item in allSources {
      let source = item as! TISInputSource
      let id = stringProperty(source, kTISPropertyInputSourceID)
      if id == inputSourceId {
        return source
      }
    }
  }

  return nil
}

func findInputSource(inputSourceId: String, query: CFDictionary) -> TISInputSource? {
  for _ in 0..<20 {
    if let source = findInputSourceOnce(inputSourceId: inputSourceId, query: query) {
      return source
    }
    Thread.sleep(forTimeInterval: 0.15)
  }
  return nil
}

func findAllInputSources(inputSourceId: String, query: CFDictionary) -> [TISInputSource] {
  var sources: [TISInputSource] = []
  for includeAll in [false, true] {
    guard let unmanagedList = TISCreateInputSourceList(query, includeAll) else { continue }
    let list = unmanagedList.takeRetainedValue() as NSArray
    for item in list {
      let source = item as! TISInputSource
      if stringProperty(source, kTISPropertyInputSourceID) == inputSourceId {
        sources.append(source)
      }
    }
  }
  return sources
}

func boolProperty(_ source: TISInputSource, _ key: CFString) -> Bool {
  guard let ptr = TISGetInputSourceProperty(source, key) else { return false }
  return CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(ptr).takeUnretainedValue())
}

func enabledInputSource(inputSourceId: String, query: CFDictionary) -> TISInputSource? {
  if let unmanagedList = TISCreateInputSourceList(query, false) {
    let list = unmanagedList.takeRetainedValue() as NSArray
    for item in list {
      let source = item as! TISInputSource
      let id = stringProperty(source, kTISPropertyInputSourceID)
      if id == inputSourceId {
        return source
      }
    }
  }
  return nil
}

func isEnabledInTIS(inputSourceId: String, query: CFDictionary) -> Bool {
  guard let source = enabledInputSource(inputSourceId: inputSourceId, query: query) else { return false }
  return boolProperty(source, kTISPropertyInputSourceIsEnabled)
}

func backupPreferences(_ preferencesURL: URL) {
  guard FileManager.default.fileExists(atPath: preferencesURL.path) else { return }
  let timestamp = ISO8601DateFormatter()
    .string(from: Date())
    .replacingOccurrences(of: ":", with: "-")
  let backupURL = preferencesURL
    .deletingLastPathComponent()
    .appendingPathComponent("com.apple.HIToolbox.plist.lekh-backup-\(timestamp)")
  try? FileManager.default.copyItem(at: preferencesURL, to: backupURL)
}

func isLekhPreferenceEntry(_ dict: [String: Any], parentInputSourceId: String, inputSourceId: String) -> Bool {
  if let bundleId = dict["Bundle ID"] as? String,
     (bundleId == parentInputSourceId ||
      bundleId == inputSourceId ||
      bundleId == "com.lekh.inputmethod.keyboard" ||
      bundleId == "com.lekh.inputmethod.keyboard.dev" ||
      bundleId.hasPrefix("com.lekh.inputmethod.")) {
    return true
  }
  if let inputMode = dict["Input Mode"] as? String,
     (inputMode == inputSourceId || inputMode.hasPrefix("com.lekh.inputmethod.")) {
    return true
  }
  return false
}

func sanitizedPreferenceArray(_ value: Any?, parentInputSourceId: String, inputSourceId: String) -> [[String: Any]] {
  let array = value as? NSArray ?? []
  var result: [[String: Any]] = []
  var seen = Set<String>()
  for item in array {
    guard let dict = item as? [String: Any] else { continue }
    if isLekhPreferenceEntry(dict, parentInputSourceId: parentInputSourceId, inputSourceId: inputSourceId) {
      continue
    }
    let fingerprint = dict.keys.sorted().map { key in
      "\(key)=\(String(describing: dict[key] ?? ""))"
    }.joined(separator: "\u{1f}")
    if seen.contains(fingerprint) { continue }
    seen.insert(fingerprint)
    result.append(dict)
  }
  return result
}

func canonicalLekhPreferenceEntry(parentInputSourceId: String, inputSourceId: String, inputModeId: String?) -> [String: Any] {
  if let inputModeId {
    return [
      "Bundle ID": parentInputSourceId,
      "Input Mode": inputModeId,
      "InputSourceKind": "Input Mode"
    ]
  }
  return [
    "Bundle ID": inputSourceId,
    "InputSourceKind": "Keyboard Input Method"
  ]
}

func rewriteInputSourcesPreferences(parentInputSourceId: String, inputSourceId: String, inputModeId: String?, enabled: Bool) {
  let preferencesURL = URL(fileURLWithPath: NSHomeDirectory())
    .appendingPathComponent("Library/Preferences/com.apple.inputsources.plist")
  let preferences = (NSMutableDictionary(contentsOf: preferencesURL) ?? NSMutableDictionary())
  backupPreferences(preferencesURL)

  var enabledThirdParty = sanitizedPreferenceArray(
    preferences["AppleEnabledThirdPartyInputSources"],
    parentInputSourceId: parentInputSourceId,
    inputSourceId: inputSourceId
  )
  if enabled {
    enabledThirdParty.append(canonicalLekhPreferenceEntry(
      parentInputSourceId: parentInputSourceId,
      inputSourceId: inputSourceId,
      inputModeId: inputModeId
    ))
  }
  preferences["AppleEnabledThirdPartyInputSources"] = enabledThirdParty

  if !preferences.write(to: preferencesURL, atomically: true) {
    fputs("Could not write input source preferences at \(preferencesURL.path)\n", stderr)
  }
}

func forceEnableInHIToolboxPreferences(
  parentInputSourceId: String,
  inputSourceId: String,
  inputModeId: String?,
  selectAsCurrent: Bool
) {
  let preferencesURL = URL(fileURLWithPath: NSHomeDirectory())
    .appendingPathComponent("Library/Preferences/com.apple.HIToolbox.plist")
  guard let preferences = NSMutableDictionary(contentsOf: preferencesURL) else {
    fputs("Could not read HIToolbox preferences at \(preferencesURL.path)\n", stderr)
    return
  }

  backupPreferences(preferencesURL)

  func sanitizedArray(_ value: Any?) -> [[String: Any]] {
    let array = value as? NSArray ?? []
    var result: [[String: Any]] = []
    for item in array {
      guard let dict = item as? [String: Any] else { continue }
      if isLekhPreferenceEntry(dict, parentInputSourceId: parentInputSourceId, inputSourceId: inputSourceId) {
       continue
      }
      result.append(dict)
    }
    return result
  }

  var enabled = sanitizedArray(preferences["AppleEnabledInputSources"])
  if let inputModeId {
    enabled.append([
      "Bundle ID": parentInputSourceId,
      "Input Mode": inputModeId,
      "InputSourceKind": "Input Mode"
    ])
  } else {
    enabled.append([
      "Bundle ID": inputSourceId,
      "InputSourceKind": "Keyboard Input Method"
    ])
  }
  preferences["AppleEnabledInputSources"] = enabled

  var history = sanitizedArray(preferences["AppleInputSourceHistory"])
  if let inputModeId {
    history.append([
      "Bundle ID": parentInputSourceId,
      "Input Mode": inputModeId,
      "InputSourceKind": "Input Mode"
    ])
  } else {
    history.append([
      "Bundle ID": inputSourceId,
      "InputSourceKind": "Keyboard Input Method"
    ])
  }
  preferences["AppleInputSourceHistory"] = history

  if selectAsCurrent {
    var selected = sanitizedArray(preferences["AppleSelectedInputSources"])
    if let inputModeId {
      selected.append([
        "Bundle ID": parentInputSourceId,
        "Input Mode": inputModeId,
        "InputSourceKind": "Input Mode"
      ])
    } else {
      selected.append([
        "Bundle ID": inputSourceId,
        "InputSourceKind": "Keyboard Input Method"
      ])
    }
    preferences["AppleSelectedInputSources"] = selected
  }
  preferences["AppleInputSourceUpdateTime"] = Date()

  if !preferences.write(to: preferencesURL, atomically: true) {
    fputs("Could not write HIToolbox preferences at \(preferencesURL.path)\n", stderr)
    return
  }

  let notificationCenter = CFNotificationCenterGetDistributedCenter()
  CFNotificationCenterPostNotification(
    notificationCenter,
    CFNotificationName(kTISNotifyEnabledKeyboardInputSourcesChanged),
    nil,
    nil,
    true
  )

  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/killall")
  process.arguments = ["cfprefsd", "TextInputMenuAgent", "TextInputSwitcher", "imklaunchagent"]
  try? process.run()
  process.waitUntilExit()
}

func ensureInputSourceRegistered() -> (source: TISInputSource?, parent: TISInputSource?, registerStatus: OSStatus?) {
  if let existing = findInputSource(inputSourceId: inputSourceId, query: query) {
    return (existing, findInputSource(inputSourceId: parentInputSourceId, query: parentQuery), nil)
  }

  let status = TISRegisterInputSource(bundleURL)
  return (
    findInputSource(inputSourceId: inputSourceId, query: query),
    findInputSource(inputSourceId: parentInputSourceId, query: parentQuery),
    status
  )
}

if shouldDisable {
  let sources = findAllInputSources(inputSourceId: inputSourceId, query: query)
  rewriteInputSourcesPreferences(
    parentInputSourceId: parentInputSourceId,
    inputSourceId: inputSourceId,
    inputModeId: inputMode?.modeId,
    enabled: false
  )
  if !sources.isEmpty {
    var lastDisableStatus = OSStatus(noErr)
    for source in sources {
      lastDisableStatus = TISDisableInputSource(source)
      if parentInputSourceId != inputSourceId,
         let parent = findInputSource(inputSourceId: parentInputSourceId, query: parentQuery) {
        _ = TISDisableInputSource(parent)
      }
    }
    let disableStatus = lastDisableStatus
    guard disableStatus == noErr else {
      fputs("Lekh Keyboard input source could not be disabled. id=\(inputSourceId) status=\(disableStatus)\n", stderr)
      exit(4)
    }
    print("Lekh Keyboard input source disabled. id=\(inputSourceId) count=\(sources.count)")
  } else {
    print("Lekh Keyboard input source was not discoverable; nothing to disable. id=\(inputSourceId)")
  }
  exit(0)
}

let registered = ensureInputSourceRegistered()

guard let source = registered.source else {
  let registerStatus = registered.registerStatus.map(String.init) ?? "not-run"
  fputs("Lekh Keyboard input source was not discoverable after registration. registerStatus=\(registerStatus)\n", stderr)
  exit(2)
}

let enableStatus = TISEnableInputSource(source)
guard enableStatus == noErr else {
  fputs("Lekh Keyboard input source could not be enabled. status=\(enableStatus)\n", stderr)
  exit(3)
}

rewriteInputSourcesPreferences(
  parentInputSourceId: parentInputSourceId,
  inputSourceId: inputSourceId,
  inputModeId: inputMode?.modeId,
  enabled: true
)

if inputMode != nil ||
   enabledInputSource(inputSourceId: inputSourceId, query: query) == nil ||
   !boolProperty(source, kTISPropertyInputSourceIsEnabled) {
  forceEnableInHIToolboxPreferences(
    parentInputSourceId: parentInputSourceId,
    inputSourceId: inputSourceId,
    inputModeId: inputMode?.modeId,
    selectAsCurrent: shouldSelect
  )
  Thread.sleep(forTimeInterval: 0.5)
}

guard isEnabledInTIS(inputSourceId: inputSourceId, query: query) else {
  fputs("Lekh Keyboard input source is discoverable but still not enabled after TISEnableInputSource. id=\(inputSourceId)\n", stderr)
  exit(7)
}

if shouldSelect {
  var selected = false
  var lastSelectStatus = OSStatus(paramErr)
  for attempt in 0..<30 {
    guard let refreshedSource = findInputSource(inputSourceId: inputSourceId, query: query) else {
      Thread.sleep(forTimeInterval: 0.5)
      continue
    }

    lastSelectStatus = TISSelectInputSource(refreshedSource)
    if lastSelectStatus == noErr {
      selected = true
      break
    }
    fputs("Select attempt \(attempt + 1) failed with status=\(lastSelectStatus); retrying.\n", stderr)
    Thread.sleep(forTimeInterval: 0.5)
  }

  guard selected else {
    fputs("Lekh Keyboard input source could not be selected. status=\(lastSelectStatus)\n", stderr)
    exit(5)
  }

  let current = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
  let currentId = TISGetInputSourceProperty(current, kTISPropertyInputSourceID)
    .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""

  guard currentId == inputSourceId else {
    fputs("Lekh Keyboard was enabled but is not current. current=\(currentId)\n", stderr)
    exit(6)
  }

  print("Lekh Keyboard input source registered, enabled, and selected. id=\(inputSourceId)")
} else {
  print("Lekh Keyboard input source registered and enabled. It was not selected. id=\(inputSourceId)")
}
