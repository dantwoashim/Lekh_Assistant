import Carbon
import Foundation

let args = Array(CommandLine.arguments.dropFirst())
let shouldSelectOnly = args.contains("--select-only")
let shouldSelect = args.contains("--select") || shouldSelectOnly
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

// `.Main` is the single macOS transport mode required for reliable IMK launch
// on current macOS. The four product typing modes remain internal engine
// pipelines and are never exposed as competing TIS sources.
let inputMode = firstInputMode(from: infoPlist)
let inputSourceId = inputMode?.inputSourceId ?? parentInputSourceId

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
        if !output.contains(where: { CFEqual($0, source) }) {
          output.append(source)
        }
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

func selectExistingSource() -> (selected: Bool, status: OSStatus) {
  var lastStatus = OSStatus(paramErr)
  for attempt in 0..<30 {
    guard let refreshedSource = findInputSource(inputSourceId) else {
      Thread.sleep(forTimeInterval: 0.5)
      continue
    }
    lastStatus = TISSelectInputSource(refreshedSource)
    Thread.sleep(forTimeInterval: 0.15)
    let selectedFlag = boolProperty(refreshedSource, kTISPropertyInputSourceIsSelected)
    let current = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
    let currentId = stringProperty(current, kTISPropertyInputSourceID)
    if lastStatus == noErr && (selectedFlag || currentId == inputSourceId) {
      return (true, lastStatus)
    }
    fputs("Select attempt \(attempt + 1) failed with status=\(lastStatus) selected=\(selectedFlag) current=\(currentId); retrying.\n", stderr)
    Thread.sleep(forTimeInterval: 0.5)
  }
  return (false, lastStatus)
}

func ensureInputSourceRegistered() -> (source: TISInputSource?, parent: TISInputSource?, registerStatus: OSStatus?) {
  // Registration is not merely discovery. After an atomic bundle replacement,
  // TIS may still expose an old source object while imklaunchagent has no live
  // endpoint for the new executable. Re-register the canonical installed URL
  // every time, then normalize any duplicate objects below.
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
  postInputSourceChangeNotification()
  guard lastStatus == noErr || disabledCount == 0 else {
    fputs("Lekh Keyboard input source could not be disabled. id=\(inputSourceId) status=\(lastStatus)\n", stderr)
    exit(4)
  }
  print("Lekh Keyboard input source disabled through TIS. id=\(inputSourceId) count=\(disabledCount)")
  exit(0)
}

if shouldSelectOnly {
  guard findInputSource(inputSourceId) != nil else {
    fputs("Lekh Keyboard input source is not registered. Run install-dev.sh before --select-only. id=\(inputSourceId)\n", stderr)
    exit(10)
  }
  guard isEnabled(inputSourceId) else {
    fputs("Lekh Keyboard input source is registered but not enabled. Approve it in System Settings, then retry. id=\(inputSourceId)\n", stderr)
    exit(11)
  }
  let selection = selectExistingSource()
  guard selection.selected else {
    fputs("Lekh Keyboard input source could not be selected without re-registration. status=\(selection.status)\n", stderr)
    exit(5)
  }
  print("Lekh Keyboard input source selected through TIS without re-registering or re-enabling. id=\(inputSourceId)")
  exit(0)
}

let registered = ensureInputSourceRegistered()
guard registered.source != nil else {
  let registerStatus = registered.registerStatus.map(String.init) ?? "not-run"
  fputs("Lekh Keyboard input source was not discoverable after registration. registerStatus=\(registerStatus)\n", stderr)
  exit(2)
}

var duplicateSourcesDisabled = 0
let matchingSources = allMatchingSources(inputSourceId)
let current = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
let currentId = stringProperty(current, kTISPropertyInputSourceID)
if currentId == inputSourceId || currentId == parentInputSourceId,
   let abc = findInputSource("com.apple.keylayout.ABC") {
  _ = TISSelectInputSource(abc)
  Thread.sleep(forTimeInterval: 0.2)
}
// Force a genuine disabled -> enabled transition even for one discoverable
// object. TIS can cache `isEnabled=true` while its effective enabled-source
// state is stale; a no-op enable then leaves the menu selectable but gives
// TextEdit no server session.
for duplicate in matchingSources where disableSource(duplicate) == noErr {
  duplicateSourcesDisabled += 1
}
postInputSourceChangeNotification()
Thread.sleep(forTimeInterval: 0.25)

guard let source = findInputSource(inputSourceId) ?? findInputSource(parentInputSourceId) else {
  fputs("Lekh Keyboard input source disappeared during duplicate normalization. id=\(inputSourceId)\n", stderr)
  exit(8)
}
let enableStatus = enableSource(source)
guard enableStatus == noErr else {
  fputs("Lekh Keyboard input source could not be enabled. status=\(enableStatus)\n", stderr)
  exit(3)
}
postInputSourceChangeNotification()
var activationApproved = false
for attempt in 0..<120 {
  if isEnabled(inputSourceId) || isEnabled(parentInputSourceId) {
    activationApproved = true
    break
  }
  if attempt == 4 {
    fputs("macOS approval required: choose Allow in the Keyboard settings sheet to enable Lekh Keyboard. Waiting up to 30 seconds.\n", stderr)
  }
  Thread.sleep(forTimeInterval: 0.25)
}
postInputSourceChangeNotification()

guard activationApproved else {
  fputs("Lekh Keyboard is installed but macOS activation approval was not completed. Open System Settings > Keyboard > Text Input > Edit, approve Lekh Keyboard, then rerun registration. id=\(inputSourceId)\n", stderr)
  exit(7)
}
let enabledMatches = allMatchingSources(inputSourceId).filter {
  boolProperty($0, kTISPropertyInputSourceIsEnabled)
}
guard enabledMatches.count == 1 else {
  fputs("Lekh Keyboard duplicate normalization left \(enabledMatches.count) enabled sources for id=\(inputSourceId).\n", stderr)
  exit(9)
}

if shouldSelect {
  let selection = selectExistingSource()
  guard selection.selected else {
    fputs("Lekh Keyboard input source could not be selected. status=\(selection.status)\n", stderr)
    exit(5)
  }
  print("Lekh Keyboard input source registered, normalized, enabled, and selected through TIS. id=\(inputSourceId) duplicatesDisabled=\(duplicateSourcesDisabled)")
} else {
  print("Lekh Keyboard input source registered, normalized, and enabled through TIS. It was not selected. id=\(inputSourceId) duplicatesDisabled=\(duplicateSourcesDisabled)")
}
