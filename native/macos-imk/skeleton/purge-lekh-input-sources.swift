import Carbon
import Foundation

let stalePrefixes = [
  "com.lekh.inputmethod."
]

let staleExact: Set<String> = [
  "com.lekh.inputmethod.LekhKeyboard",
  "com.lekh.inputmethod.LekhKeyboard.Romanized",
  "com.lekh.inputmethod.keyboard",
  "com.lekh.inputmethod.keyboard.dev"
]

func stringProperty(_ source: TISInputSource, _ key: CFString) -> String {
  TISGetInputSourceProperty(source, key)
    .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
}

func isLekhSource(_ source: TISInputSource) -> Bool {
  let id = stringProperty(source, kTISPropertyInputSourceID)
  if staleExact.contains(id) { return true }
  if stalePrefixes.contains(where: { id.hasPrefix($0) }) { return true }
  let localizedName = stringProperty(source, kTISPropertyLocalizedName)
  return localizedName.localizedCaseInsensitiveContains("Lekh")
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
print("Disabled stale Lekh input sources through TIS. disabled=\(disabled) failed=\(failed)")
exit(failed == 0 ? 0 : 2)
