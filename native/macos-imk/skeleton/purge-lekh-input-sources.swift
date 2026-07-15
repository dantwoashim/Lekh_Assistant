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
  return isLekhIdentifier(id)
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
// Never edit Apple's private input-source preference domains directly. TIS
// owns approval, enabled-source, selected-source and history state; private
// array rewrites can make a source flash in the menu and then disappear.
print("Disabled stale Lekh input sources through TIS. tisDisabled=\(disabled) failed=\(failed)")
exit(failed == 0 ? 0 : 2)
