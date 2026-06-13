import AppKit
import InputMethodKit
import LekhInputMethod
import OSLog

#if canImport(Sparkle)
import Sparkle
#endif

private let appLogger = Logger(subsystem: "com.lekh.inputmethod.keyboard", category: "app")

@objc(LekhInputMethodApplication)
final class LekhInputMethodApplication: NSApplication {}

private final class LekhInputMethodAppDelegate: NSObject, NSApplicationDelegate {
  private var server: IMKServer?
  #if canImport(Sparkle)
  private var updaterController: SPUStandardUpdaterController?
  #endif

  func applicationDidFinishLaunching(_ notification: Notification) {
    LekhNativePreferences.registerDefaults()
    LekhMetricReporterBootstrap.startIfOptedIn()
    startSignedAppUpdatesIfConfigured()

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

  private func startSignedAppUpdatesIfConfigured() {
    #if canImport(Sparkle)
    guard let feedURL = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String,
          URL(string: feedURL)?.scheme == "https",
          let publicKey = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
          !publicKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return
    }
    updaterController = SPUStandardUpdaterController(
      startingUpdater: true,
      updaterDelegate: nil,
      userDriverDelegate: nil
    )
    appLogger.info("Sparkle signed app updater started.")
    #endif
  }
}

private let app = NSApplication.shared
private let delegate = LekhInputMethodAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
