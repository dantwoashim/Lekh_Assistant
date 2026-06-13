import AppKit
import InputMethodKit
import LekhInputMethod
import OSLog

private let appLogger = Logger(subsystem: "com.lekh.inputmethod.keyboard", category: "app")

@objc(LekhInputMethodApplication)
final class LekhInputMethodApplication: NSApplication {}

private final class LekhInputMethodAppDelegate: NSObject, NSApplicationDelegate {
  private var server: IMKServer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    LekhNativePreferences.registerDefaults()
    LekhMetricReporterBootstrap.startIfOptedIn()

    guard let bundleIdentifier = Bundle.main.bundleIdentifier else {
      appLogger.fault("Missing bundle identifier; terminating IMK server.")
      NSApp.terminate(nil)
      return
    }

    let currentPid = ProcessInfo.processInfo.processIdentifier
    let duplicates = NSRunningApplication
      .runningApplications(withBundleIdentifier: bundleIdentifier)
      .filter { $0.processIdentifier != currentPid }
    if !duplicates.isEmpty {
      appLogger.error("Another Lekh IMK server is already running; terminating duplicate pid=\(currentPid)")
      NSApp.terminate(nil)
      return
    }

    let connectionName = Bundle.main.object(forInfoDictionaryKey: "InputMethodConnectionName") as? String
      ?? "com.lekh.inputmethod.LekhKeyboard_Connection"
    server = IMKServer(name: connectionName, bundleIdentifier: bundleIdentifier)
    appLogger.info("IMKServer started connection=\(connectionName, privacy: .public) pid=\(currentPid)")
  }
}

private let app = NSApplication.shared
private let delegate = LekhInputMethodAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
