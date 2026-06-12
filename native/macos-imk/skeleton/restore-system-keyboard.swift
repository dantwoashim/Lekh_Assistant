import Carbon
import Foundation

let args = Array(CommandLine.arguments.dropFirst())
let supportDirectory = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library", isDirectory: true)
  .appendingPathComponent("Application Support", isDirectory: true)
  .appendingPathComponent("Lekh Keyboard", isDirectory: true)
let previousInputSourceURL = supportDirectory.appendingPathComponent("previous-input-source.txt")

func stringProperty(_ source: TISInputSource, _ key: CFString) -> String {
  TISGetInputSourceProperty(source, key)
    .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
}

if args.contains("--snapshot") {
  let current = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
  let currentId = stringProperty(current, kTISPropertyInputSourceID)
  if !currentId.hasPrefix("com.lekh.inputmethod.") && !currentId.isEmpty {
    try? FileManager.default.createDirectory(at: supportDirectory, withIntermediateDirectories: true)
    try? "\(currentId)\n".write(to: previousInputSourceURL, atomically: true, encoding: .utf8)
    print("Saved previous input source: \(currentId)")
    exit(0)
  }
  print("Current source is Lekh or unavailable; previous input source snapshot unchanged.")
  exit(0)
}

var restoreCandidates: [String] = []
if let previous = try? String(contentsOf: previousInputSourceURL, encoding: .utf8)
  .trimmingCharacters(in: .whitespacesAndNewlines),
  !previous.isEmpty,
  !previous.hasPrefix("com.lekh.inputmethod.") {
  restoreCandidates.append(previous)
}

let fallbackInputSourceIds = [
  "com.apple.keylayout.ABC",
  "com.apple.keylayout.US"
]

for inputSourceId in restoreCandidates + fallbackInputSourceIds {
  let query = [kTISPropertyInputSourceID as String: inputSourceId] as CFDictionary
  guard let unmanagedList = TISCreateInputSourceList(query, false) else { continue }
  let list = unmanagedList.takeRetainedValue() as NSArray
  guard let first = list.firstObject else { continue }
  let source = first as! TISInputSource

  _ = TISEnableInputSource(source)
  let selectStatus = TISSelectInputSource(source)
  if selectStatus == noErr {
    print("Selected safe macOS keyboard input source: \(inputSourceId)")
    exit(0)
  }
}

fputs("Could not select ABC or US keyboard input source.\n", stderr)
exit(2)
