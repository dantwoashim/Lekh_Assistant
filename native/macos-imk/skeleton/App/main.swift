import AppKit
import Carbon
import InputMethodKit
import LekhInputMethod
import OSLog

private let appLogger = Logger(subsystem: "com.lekh.inputmethod.keyboard", category: "app")
private let expectedIMKConnectionName = LekhRuntimeHealth.expectedConnectionName

private final class LekhInputMethodAppDelegate: NSObject, NSApplicationDelegate {
  private var server: IMKServer?
  private var statusMenu: LekhStatusMenuController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    LekhNativePreferences.registerDefaults()

    guard let bundleIdentifier = Bundle.main.bundleIdentifier else {
      appLogger.fault("Missing bundle identifier; terminating IMK server.")
      NSApp.terminate(nil)
      return
    }

    let currentPid = ProcessInfo.processInfo.processIdentifier
    guard let connectionName = Bundle.main.object(forInfoDictionaryKey: "InputMethodConnectionName") as? String,
          connectionName == expectedIMKConnectionName else {
      appLogger.fault("Missing or unsupported InputMethodConnectionName; terminating IMK server.")
      NSApp.terminate(nil)
      return
    }
    // Establish the text-service connection before any optional subsystem or
    // menu construction. LaunchServices already provides application-instance
    // coalescing; a second NSRunningApplication scan is stale during atomic
    // upgrades and can kill the replacement while the old process is exiting,
    // leaving TIS selected with no server and causing raw-ASCII fallthrough.
    server = IMKServer(name: connectionName, bundleIdentifier: bundleIdentifier)
    LekhRuntimeHealth.markServerStarted(connectionName: connectionName)
    appLogger.info("IMKServer started connection=\(connectionName, privacy: .public) pid=\(currentPid)")

    // Everything below is nonessential to typing startup and may initialize
    // AppKit/MetricKit state. Defer it until the server is accepting sessions.
    DispatchQueue.main.async { [weak self] in
      LekhMetricReporterBootstrap.startIfOptedIn()
      self?.statusMenu = LekhStatusMenuController()
    }
  }
}

private final class LekhStatusMenuController: NSObject, NSMenuDelegate {
  private let statusItem: NSStatusItem

  override init() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    super.init()

    if let button = statusItem.button {
      button.title = "ले"
      button.font = NSFont(name: "Kohinoor Devanagari-Semibold", size: 15) ?? .systemFont(ofSize: 15, weight: .semibold)
      button.toolTip = LekhL10n.text("app.name")
      button.setAccessibilityLabel(LekhL10n.text("app.name"))
    }

    let menu = NSMenu(title: LekhL10n.text("app.name"))
    menu.delegate = self
    statusItem.menu = menu
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()

    let title = NSMenuItem(title: LekhL10n.text("app.name"), action: nil, keyEquivalent: "")
    title.isEnabled = false
    menu.addItem(title)

    let status = NSMenuItem(title: LekhL10n.text("status.readyLocal"), action: nil, keyEquivalent: "")
    status.isEnabled = false
    menu.addItem(status)
    menu.addItem(.separator())

    let selectedRaw = UserDefaults.standard.string(forKey: LekhNativePreferences.Keys.nativeTypingMode) ?? LekhNativeTypingMode.romanizedTraditional.rawValue
    let selected = LekhNativeTypingMode(rawValue: selectedRaw) ?? .romanizedTraditional
    for mode in LekhNativeTypingMode.visibleModes {
      let item = NSMenuItem(title: mode.menuLabel, action: #selector(selectMode(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = mode.rawValue
      item.state = mode == selected ? .on : .off
      menu.addItem(item)
    }

    menu.addItem(.separator())
    let preferences = NSMenuItem(title: LekhL10n.text("menu.preferences"), action: #selector(showPreferences(_:)), keyEquivalent: ",")
    preferences.target = self
    menu.addItem(preferences)

    let tutorial = NSMenuItem(title: LekhL10n.text("menu.tutorial"), action: #selector(showTutorial(_:)), keyEquivalent: "")
    tutorial.target = self
    menu.addItem(tutorial)

    menu.addItem(.separator())
    let restoreABC = NSMenuItem(title: LekhL10n.text("menu.switchABC"), action: #selector(switchToABC(_:)), keyEquivalent: "")
    restoreABC.target = self
    menu.addItem(restoreABC)

    let keyboardSettings = NSMenuItem(title: LekhL10n.text("menu.openKeyboardSettings"), action: #selector(openKeyboardSettings(_:)), keyEquivalent: "")
    keyboardSettings.target = self
    menu.addItem(keyboardSettings)
  }

  @objc private func selectMode(_ item: NSMenuItem) {
    guard let rawValue = item.representedObject as? String,
          let mode = LekhNativeTypingMode(rawValue: rawValue) else { return }
    UserDefaults.standard.set(mode.rawValue, forKey: LekhNativePreferences.Keys.nativeTypingMode)
    UserDefaults.standard.set(true, forKey: LekhNativePreferences.Keys.nativeTypingModeChosen)
    UserDefaults.standard.synchronize()
    NotificationCenter.default.post(
      name: LekhNativePreferences.modeDidChangeNotification,
      object: nil,
      userInfo: ["mode": mode.rawValue]
    )
  }

  @objc private func showPreferences(_ item: NSMenuItem) {
    LekhPreferencesWindowController.shared.show {
      "status=ready\nprivacy=local-only\ninputSource=com.lekh.inputmethod.LekhKeyboard.Main"
    }
  }

  @objc private func showTutorial(_ item: NSMenuItem) {
    LekhPreferencesWindowController.shared.showTutorial()
  }

  @objc private func switchToABC(_ item: NSMenuItem) {
    guard let abc = inputSource(id: "com.apple.keylayout.ABC") else { return }
    TISSelectInputSource(abc)
  }

  @objc private func openKeyboardSettings(_ item: NSMenuItem) {
    guard let url = URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension") else { return }
    NSWorkspace.shared.open(url)
  }

  private func inputSource(id inputSourceId: String) -> TISInputSource? {
    let query = [kTISPropertyInputSourceID as String: inputSourceId] as CFDictionary
    guard let unmanagedList = TISCreateInputSourceList(query, false) else { return nil }
    let list = unmanagedList.takeRetainedValue() as NSArray
    return list.firstObject as! TISInputSource?
  }
}

private let app = NSApplication.shared
private let delegate = LekhInputMethodAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
