import Carbon
import Foundation

let bundlePath: String
let args = Array(CommandLine.arguments.dropFirst())
let shouldSelect = args.contains("--select")

if let explicitPath = args.first(where: { !$0.hasPrefix("--") }) {
  bundlePath = explicitPath
} else {
  bundlePath = NSHomeDirectory() + "/Library/Input Methods/Lekh Keyboard.app"
}

let inputSourceId = "com.lekh.inputmethod.keyboard"
let bundleURL = URL(fileURLWithPath: bundlePath) as CFURL

let query = [kTISPropertyInputSourceID as String: inputSourceId] as CFDictionary

func findInputSourceOnce() -> TISInputSource? {
  // On some macOS builds, a direct query immediately after registration can
  // return a TISInputSource object that is discoverable/enabled but rejected by
  // TISSelectInputSource with paramErr (-50). The full registry scan returns
  // the same logical input source in a selectable form, so prefer it.
  if let unmanagedAll = TISCreateInputSourceList(nil, true) {
    let allSources = unmanagedAll.takeRetainedValue() as NSArray
    for item in allSources {
      let source = item as! TISInputSource
      let id = TISGetInputSourceProperty(source, kTISPropertyInputSourceID)
        .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
      if id == inputSourceId {
        return source
      }
    }
  }

  if let unmanagedList = TISCreateInputSourceList(query, false) {
    let list = unmanagedList.takeRetainedValue() as NSArray
    if let first = list.firstObject {
      return (first as! TISInputSource)
    }
  }

  return nil
}

func findInputSource() -> TISInputSource? {
  for _ in 0..<20 {
    if let source = findInputSourceOnce() {
      return source
    }
    Thread.sleep(forTimeInterval: 0.15)
  }
  return nil
}

func ensureInputSourceRegistered() -> (source: TISInputSource?, registerStatus: OSStatus?) {
  if let existing = findInputSource() {
    return (existing, nil)
  }

  let status = TISRegisterInputSource(bundleURL)
  return (findInputSource(), status)
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

if shouldSelect {
  var selected = false
  var lastSelectStatus = OSStatus(paramErr)
  for attempt in 0..<30 {
    guard let refreshedSource = findInputSource() else {
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

  print("Lekh Keyboard input source registered, enabled, and selected.")
} else {
  print("Lekh Keyboard input source registered and enabled. It was not selected.")
}
