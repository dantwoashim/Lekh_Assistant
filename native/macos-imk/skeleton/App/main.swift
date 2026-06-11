import AppKit
import InputMethodKit
import LekhInputMethod

private let connectionName = "Lekh_Keyboard_Connection"

private final class LekhInputMethodAppDelegate: NSObject, NSApplicationDelegate {
  private var server: IMKServer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    server = IMKServer(name: connectionName, bundleIdentifier: Bundle.main.bundleIdentifier)
  }
}

private let app = NSApplication.shared
private let delegate = LekhInputMethodAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
