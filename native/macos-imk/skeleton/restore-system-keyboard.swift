import Carbon
import Foundation

let fallbackInputSourceIds = [
  "com.apple.keylayout.ABC",
  "com.apple.keylayout.US"
]

for inputSourceId in fallbackInputSourceIds {
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
