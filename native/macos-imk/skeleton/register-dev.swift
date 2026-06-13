import Carbon
import Foundation

let args = Array(CommandLine.arguments.dropFirst())
let shouldSelect = args.contains("--select")
let shouldDisable = args.contains("--disable")
let bundlePath = args.first(where: { !$0.hasPrefix("--") }) ?? NSHomeDirectory() + "/Library/Input Methods/Lekh Keyboard.app"
let bundleURL = URL(fileURLWithPath: bundlePath) as CFURL
let infoPlistURL = URL(fileURLWithPath: bundlePath).appendingPathComponent("Contents/Info.plist")

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
          let modeDictionary = item.value as? NSDictionary else { continue }
    return (modeId, (modeDictionary["TISInputSourceID"] as? String) ?? modeId)
  }
  return nil
}

let inputMode = firstInputMode(from: infoPlist)
let inputSourceId = inputMode?.inputSourceId ?? parentInputSourceId
let hitoolboxDomain = "com.apple.HIToolbox" as CFString
let inputSourcesDomain = "com.apple.inputsources" as CFString
let enabledInputSourcesKey = "AppleEnabledInputSources" as CFString
let selectedInputSourcesKey = "AppleSelectedInputSources" as CFString
let enabledThirdPartyInputSourcesKey = "AppleEnabledThirdPartyInputSources" as CFString

func stringProperty(_ source: TISInputSource, _ key: CFString) -> String {
  TISGetInputSourceProperty(source, key)
    .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
}

func boolProperty(_ source: TISInputSource, _ key: CFString) -> Bool {
  guard let ptr = TISGetInputSourceProperty(source, key) else { return false }
  return CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(ptr).takeUnretainedValue())
}

func query(_ inputSourceId: String) -> CFDictionary {
  [kTISPropertyInputSourceID as String: inputSourceId] as CFDictionary
}

func findInputSourceOnce(_ inputSourceId: String, includeAll: Bool) -> TISInputSource? {
  guard let unmanagedList = TISCreateInputSourceList(query(inputSourceId), includeAll) else { return nil }
  let list = unmanagedList.takeRetainedValue() as NSArray
  for item in list {
    let source = item as! TISInputSource
    if stringProperty(source, kTISPropertyInputSourceID) == inputSourceId {
      return source
    }
  }
  return nil
}

func findInputSource(_ inputSourceId: String) -> TISInputSource? {
  for _ in 0..<20 {
    if let source = findInputSourceOnce(inputSourceId, includeAll: true) {
      return source
    }
    Thread.sleep(forTimeInterval: 0.15)
  }
  return nil
}

func allMatchingSources(_ inputSourceId: String) -> [TISInputSource] {
  var output: [TISInputSource] = []
  for includeAll in [false, true] {
    guard let unmanagedList = TISCreateInputSourceList(query(inputSourceId), includeAll) else { continue }
    let list = unmanagedList.takeRetainedValue() as NSArray
    for item in list {
      let source = item as! TISInputSource
      if stringProperty(source, kTISPropertyInputSourceID) == inputSourceId {
        output.append(source)
      }
    }
  }
  return output
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

func dictionaryContainsLekh(_ value: Any) -> Bool {
  guard let dictionary = value as? [AnyHashable: Any] else { return false }
  for (_, item) in dictionary {
    if let itemString = item as? String,
       itemString.localizedCaseInsensitiveContains("lekh") || itemString.hasPrefix("com.lekh.inputmethod.") {
      return true
    }
    if let nestedDictionary = item as? [AnyHashable: Any],
       dictionaryContainsLekh(nestedDictionary) {
      return true
    }
    if let nestedArray = item as? [Any],
       nestedArray.contains(where: dictionaryContainsLekh) {
      return true
    }
  }
  return false
}

func inputSourceKind(_ value: Any) -> String {
  guard let dictionary = value as? [AnyHashable: Any] else { return "" }
  return dictionary["InputSourceKind"] as? String ?? ""
}

func existingPreferenceArray(_ key: CFString, domain: CFString) -> [Any] {
  CFPreferencesCopyAppValue(key, domain) as? [Any] ?? []
}

func setPreferenceArray(_ array: [Any], key: CFString, domain: CFString) {
  CFPreferencesSetAppValue(key, array as CFArray, domain)
}

func withoutLekhRows(_ array: [Any]) -> [Any] {
  array.filter { !dictionaryContainsLekh($0) }
}

func syncMenuBarPreferences(selected: Bool) {
  let inputModeRow: [String: Any] = [
    "Bundle ID": parentInputSourceId,
    "Input Mode": inputSourceId,
    "InputSourceKind": "Input Mode"
  ]
  let parentRow: [String: Any] = [
    "Bundle ID": parentInputSourceId,
    "InputSourceKind": "Keyboard Input Method"
  ]

  var enabledRows = withoutLekhRows(existingPreferenceArray(enabledInputSourcesKey, domain: hitoolboxDomain))
  enabledRows.append(inputModeRow)
  setPreferenceArray(enabledRows, key: enabledInputSourcesKey, domain: hitoolboxDomain)

  var thirdPartyRows = withoutLekhRows(existingPreferenceArray(enabledThirdPartyInputSourcesKey, domain: inputSourcesDomain))
  thirdPartyRows.append(parentRow)
  setPreferenceArray(thirdPartyRows, key: enabledThirdPartyInputSourcesKey, domain: inputSourcesDomain)

  if selected {
    let preservedSelectedRows = withoutLekhRows(existingPreferenceArray(selectedInputSourcesKey, domain: hitoolboxDomain))
      .filter {
        let kind = inputSourceKind($0)
        return kind != "Keyboard Layout" && kind != "Input Mode"
      }
    setPreferenceArray(preservedSelectedRows + [inputModeRow], key: selectedInputSourcesKey, domain: hitoolboxDomain)
  }

  CFPreferencesAppSynchronize(hitoolboxDomain)
  CFPreferencesAppSynchronize(inputSourcesDomain)
}

func removeMenuBarPreferences() {
  setPreferenceArray(withoutLekhRows(existingPreferenceArray(enabledInputSourcesKey, domain: hitoolboxDomain)), key: enabledInputSourcesKey, domain: hitoolboxDomain)
  setPreferenceArray(withoutLekhRows(existingPreferenceArray(selectedInputSourcesKey, domain: hitoolboxDomain)), key: selectedInputSourcesKey, domain: hitoolboxDomain)
  setPreferenceArray(withoutLekhRows(existingPreferenceArray(enabledThirdPartyInputSourcesKey, domain: inputSourcesDomain)), key: enabledThirdPartyInputSourcesKey, domain: inputSourcesDomain)
  CFPreferencesAppSynchronize(hitoolboxDomain)
  CFPreferencesAppSynchronize(inputSourcesDomain)
}

func disableSource(_ source: TISInputSource) -> OSStatus {
  TISDisableInputSource(source)
}

func enableSource(_ source: TISInputSource) -> OSStatus {
  TISEnableInputSource(source)
}

func isEnabled(_ inputSourceId: String) -> Bool {
  guard let source = findInputSourceOnce(inputSourceId, includeAll: false) else { return false }
  return boolProperty(source, kTISPropertyInputSourceIsEnabled)
}

func ensureInputSourceRegistered() -> (source: TISInputSource?, parent: TISInputSource?, registerStatus: OSStatus?) {
  if let existing = findInputSource(inputSourceId) {
    return (existing, findInputSource(parentInputSourceId), nil)
  }
  let status = TISRegisterInputSource(bundleURL)
  return (findInputSource(inputSourceId), findInputSource(parentInputSourceId), status)
}

if shouldDisable {
  var disabledCount = 0
  var lastStatus = OSStatus(noErr)
  for id in Set([inputSourceId, parentInputSourceId]) {
    for source in allMatchingSources(id) {
      lastStatus = disableSource(source)
      if lastStatus == noErr { disabledCount += 1 }
    }
  }
  removeMenuBarPreferences()
  postInputSourceChangeNotification()
  guard lastStatus == noErr || disabledCount == 0 else {
    fputs("Lekh Keyboard input source could not be disabled. id=\(inputSourceId) status=\(lastStatus)\n", stderr)
    exit(4)
  }
  print("Lekh Keyboard input source disabled through TIS. id=\(inputSourceId) count=\(disabledCount)")
  exit(0)
}

let registered = ensureInputSourceRegistered()
guard let source = registered.source else {
  let registerStatus = registered.registerStatus.map(String.init) ?? "not-run"
  fputs("Lekh Keyboard input source was not discoverable after registration. registerStatus=\(registerStatus)\n", stderr)
  exit(2)
}

let enableStatus = enableSource(source)
guard enableStatus == noErr else {
  fputs("Lekh Keyboard input source could not be enabled. status=\(enableStatus)\n", stderr)
  exit(3)
}
if let parent = registered.parent {
  _ = enableSource(parent)
}
postInputSourceChangeNotification()
Thread.sleep(forTimeInterval: 0.5)
syncMenuBarPreferences(selected: shouldSelect)
postInputSourceChangeNotification()
Thread.sleep(forTimeInterval: 0.5)
syncMenuBarPreferences(selected: shouldSelect)
postInputSourceChangeNotification()

guard isEnabled(inputSourceId) || isEnabled(parentInputSourceId) else {
  fputs("Lekh Keyboard input source is discoverable but still not enabled after TISEnableInputSource. id=\(inputSourceId)\n", stderr)
  exit(7)
}

if shouldSelect {
  var selected = false
  var lastSelectStatus = OSStatus(paramErr)
  for attempt in 0..<30 {
    guard let refreshedSource = findInputSource(inputSourceId) ?? findInputSource(parentInputSourceId) else {
      Thread.sleep(forTimeInterval: 0.5)
      continue
    }
    lastSelectStatus = TISSelectInputSource(refreshedSource)
    Thread.sleep(forTimeInterval: 0.15)
    let selectedFlag = boolProperty(refreshedSource, kTISPropertyInputSourceIsSelected)
    let current = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
    let currentId = stringProperty(current, kTISPropertyInputSourceID)
    if lastSelectStatus == noErr && (selectedFlag || currentId == inputSourceId || currentId == parentInputSourceId) {
      selected = true
      break
    }
    fputs("Select attempt \(attempt + 1) failed with status=\(lastSelectStatus) selected=\(selectedFlag) current=\(currentId); retrying.\n", stderr)
    Thread.sleep(forTimeInterval: 0.5)
  }
  guard selected else {
    fputs("Lekh Keyboard input source could not be selected. status=\(lastSelectStatus)\n", stderr)
    exit(5)
  }
  print("Lekh Keyboard input source registered, enabled, and selected through TIS. id=\(inputSourceId)")
} else {
  print("Lekh Keyboard input source registered and enabled through TIS. It was not selected. id=\(inputSourceId)")
}
