import AppKit
import Carbon
import InputMethodKit
import LekhInputMethod
import OSLog

private let appLogger = Logger(subsystem: "com.lekh.inputmethod.keyboard", category: "app")

@objc(LekhInputMethodApplication)
final class LekhInputMethodApplication: NSApplication {}

private final class LekhInputMethodAppDelegate: NSObject, NSApplicationDelegate {
  private var server: IMKServer?
  private var statusMenu: LekhStatusMenuController?

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
    statusMenu = LekhStatusMenuController()
    appLogger.info("IMKServer started connection=\(connectionName, privacy: .public) pid=\(currentPid)")
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
      button.toolTip = "Lekh Keyboard"
      button.setAccessibilityLabel("Lekh Keyboard")
    }

    let menu = NSMenu(title: "Lekh Keyboard")
    menu.delegate = self
    statusItem.menu = menu
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()

    let title = NSMenuItem(title: "Lekh Keyboard", action: nil, keyEquivalent: "")
    title.isEnabled = false
    menu.addItem(title)

    let status = NSMenuItem(title: "Ready • Local only", action: nil, keyEquivalent: "")
    status.isEnabled = false
    menu.addItem(status)
    menu.addItem(.separator())

    let selectedRaw = UserDefaults.standard.string(forKey: "LekhNativeTypingMode") ?? LekhNativeTypingMode.romanizedTraditional.rawValue
    let selected = LekhNativeTypingMode(rawValue: selectedRaw) ?? .romanizedTraditional
    for mode in LekhNativeTypingMode.visibleModes {
      let item = NSMenuItem(title: mode.menuLabel, action: #selector(selectMode(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = mode.rawValue
      item.state = mode == selected ? .on : .off
      menu.addItem(item)
    }

    menu.addItem(.separator())
    let preferences = NSMenuItem(title: "Lekh Settings...", action: #selector(showPreferences(_:)), keyEquivalent: ",")
    preferences.target = self
    menu.addItem(preferences)

    let tutorial = NSMenuItem(title: "Typing Tutorial...", action: #selector(showTutorial(_:)), keyEquivalent: "")
    tutorial.target = self
    menu.addItem(tutorial)

    menu.addItem(.separator())
    let restoreABC = NSMenuItem(title: "Switch to ABC", action: #selector(switchToABC(_:)), keyEquivalent: "")
    restoreABC.target = self
    menu.addItem(restoreABC)

    let keyboardSettings = NSMenuItem(title: "Open macOS Keyboard Settings", action: #selector(openKeyboardSettings(_:)), keyEquivalent: "")
    keyboardSettings.target = self
    menu.addItem(keyboardSettings)
  }

  @objc private func selectMode(_ item: NSMenuItem) {
    guard let rawValue = item.representedObject as? String,
          let mode = LekhNativeTypingMode(rawValue: rawValue) else { return }
    UserDefaults.standard.set(mode.rawValue, forKey: "LekhNativeTypingMode")
    UserDefaults.standard.set(true, forKey: "LekhNativeTypingModeChosen.v2")
    UserDefaults.standard.synchronize()
    NotificationCenter.default.post(
      name: Notification.Name("LekhNativeTypingModeDidChange"),
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
