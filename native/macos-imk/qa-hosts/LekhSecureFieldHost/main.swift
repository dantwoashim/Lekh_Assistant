import AppKit
import Carbon
import Foundation

private let hostWindowIdentifier = "lekh.secureHost.window"
private let calibrationFieldIdentifier = "lekh.secureHost.calibration"
private let secureFieldIdentifier = "lekh.secureHost.field"

private struct HostStatus: Codable {
  let schemaVersion: Int
  let processIdentifier: Int32
  let statusSequence: UInt64
  let publishedAtUnixMs: Int64
  let phase: String
  let frontmost: Bool
  let windowIsKey: Bool
  let calibrationFieldFocused: Bool
  let secureFieldFocused: Bool
  let secureEventInputEnabled: Bool
  let calibrationReceivedUTF16Length: Int
  let secureReceivedUTF16Length: Int
  let secureExpectedUTF16Length: Int
  let secureExactMatch: Bool
  let secureHasMarkedText: Bool
  let secureDownCommandReceived: Bool
}

private final class SecureFieldHostDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTextFieldDelegate {
  private var expectedSecureText: String
  private let statusURL: URL
  private var statusTimer: Timer?
  private var secureDownCommandReceived = false
  private var statusSequence: UInt64 = 0

  private let window: NSWindow
  private let calibrationField = NSTextField(frame: .zero)
  private let secureField = NSSecureTextField(frame: .zero)

  init(expectedSecureText: String, statusURL: URL) {
    self.expectedSecureText = expectedSecureText
    self.statusURL = statusURL
    self.window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 460, height: 230),
      styleMask: [.titled, .closable],
      backing: .buffered,
      defer: false
    )
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApplication.shared.setActivationPolicy(.regular)
    configureWindow()
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApplication.shared.activate(ignoringOtherApps: true)
    window.makeFirstResponder(calibrationField)
    publishStatus()
    statusTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
      self?.publishStatus()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    FileHandle.standardInput.readabilityHandler = nil
    statusTimer?.invalidate()
    statusTimer = nil
    calibrationField.stringValue = ""
    secureField.stringValue = ""
    expectedSecureText = ""
  }

  func windowWillClose(_ notification: Notification) {
    NSApplication.shared.terminate(nil)
  }

  func controlTextDidChange(_ notification: Notification) {
    publishStatus()
  }

  func control(
    _ control: NSControl,
    textView: NSTextView,
    doCommandBy commandSelector: Selector
  ) -> Bool {
    guard control === secureField,
          commandSelector == #selector(NSResponder.moveDown(_:)) else { return false }
    // The probe records that the isolated secure editor received Down without
    // allowing the single-line host editor to move its insertion point.
    secureDownCommandReceived = true
    publishStatus()
    return true
  }

  private func configureWindow() {
    window.title = "Lekh Secure Field QA Host"
    window.identifier = NSUserInterfaceItemIdentifier(hostWindowIdentifier)
    window.setAccessibilityIdentifier(hostWindowIdentifier)
    window.isReleasedWhenClosed = false
    window.delegate = self

    let title = NSTextField(labelWithString: "Secure input verification")
    title.font = .systemFont(ofSize: 20, weight: .semibold)
    title.setAccessibilityIdentifier("lekh.secureHost.title")

    let explanation = NSTextField(wrappingLabelWithString: "This disposable QA host verifies secure-field isolation: raw host entry, no marked text or candidate UI, and no keyboard logging or learning.")
    explanation.textColor = .secondaryLabelColor
    explanation.maximumNumberOfLines = 2

    calibrationField.placeholderString = "Automation calibration"
    calibrationField.identifier = NSUserInterfaceItemIdentifier(calibrationFieldIdentifier)
    calibrationField.setAccessibilityIdentifier(calibrationFieldIdentifier)
    calibrationField.delegate = self

    secureField.placeholderString = "Secure test field"
    secureField.identifier = NSUserInterfaceItemIdentifier(secureFieldIdentifier)
    secureField.setAccessibilityIdentifier(secureFieldIdentifier)
    secureField.delegate = self

    let stack = NSStackView(views: [title, explanation, calibrationField, secureField])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    calibrationField.translatesAutoresizingMaskIntoConstraints = false
    secureField.translatesAutoresizingMaskIntoConstraints = false

    let content = NSView(frame: window.contentLayoutRect)
    content.addSubview(stack)
    window.contentView = content
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
      stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 22),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -22),
      calibrationField.widthAnchor.constraint(equalTo: stack.widthAnchor),
      secureField.widthAnchor.constraint(equalTo: stack.widthAnchor),
      calibrationField.heightAnchor.constraint(equalToConstant: 28),
      secureField.heightAnchor.constraint(equalToConstant: 28)
    ])
  }

  private func publishStatus() {
    statusSequence &+= 1
    let fieldEditor = window.fieldEditor(false, for: secureField) as? NSTextView
    let secureFocused = isFocused(secureField)
    let status = HostStatus(
      schemaVersion: 1,
      processIdentifier: ProcessInfo.processInfo.processIdentifier,
      statusSequence: statusSequence,
      publishedAtUnixMs: Int64(Date().timeIntervalSince1970 * 1_000),
      phase: secureFocused ? "secure" : "calibration",
      frontmost: NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier,
      windowIsKey: window.isKeyWindow,
      calibrationFieldFocused: isFocused(calibrationField),
      secureFieldFocused: secureFocused,
      secureEventInputEnabled: IsSecureEventInputEnabled(),
      calibrationReceivedUTF16Length: calibrationField.stringValue.utf16.count,
      secureReceivedUTF16Length: secureField.stringValue.utf16.count,
      secureExpectedUTF16Length: expectedSecureText.utf16.count,
      secureExactMatch: secureField.stringValue == expectedSecureText,
      secureHasMarkedText: fieldEditor?.hasMarkedText() ?? false,
      secureDownCommandReceived: secureDownCommandReceived
    )
    guard let data = try? JSONEncoder.hostStatus.encode(status) else { return }
    do {
      try FileManager.default.createDirectory(
        at: statusURL.deletingLastPathComponent(),
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
      try data.write(to: statusURL, options: [.atomic])
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: statusURL.path)
    } catch {
      // Evidence is optional to the host and must never echo field content.
    }
  }

  private func isFocused(_ field: NSTextField) -> Bool {
    guard let editor = window.fieldEditor(false, for: field) else { return false }
    return window.firstResponder === editor && field.currentEditor() === editor
  }
}

private extension JSONEncoder {
  static var hostStatus: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return encoder
  }
}

private func readSyntheticExpectation() -> String? {
  var data = Data()
  while data.count <= 1_024 {
    let chunk = FileHandle.standardInput.availableData
    guard !chunk.isEmpty else { return nil }
    data.append(chunk)
    guard let newline = data.firstIndex(of: 0x0A) else { continue }
    let trailing = data.index(after: newline)..<data.endIndex
    guard trailing.isEmpty else { return nil }
    let lineData = data[..<newline]
    guard let line = String(data: lineData, encoding: .utf8),
        let decoded = Data(base64Encoded: line),
        let value = String(data: decoded, encoding: .utf8),
        !value.isEmpty,
        value.utf16.count <= 128,
        value.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
      return nil
    }
    return value
  }
  return nil
}

guard let statusPath = ProcessInfo.processInfo.environment["LEKH_SECURE_HOST_STATUS_PATH"],
      statusPath.hasPrefix("/"),
      let expectedSecureText = readSyntheticExpectation() else {
  exit(2)
}

private let application = NSApplication.shared
private let delegate = SecureFieldHostDelegate(
  expectedSecureText: expectedSecureText,
  statusURL: URL(fileURLWithPath: statusPath)
)
application.delegate = delegate
FileHandle.standardInput.readabilityHandler = { handle in
  // The expectation line was consumed synchronously above. Any subsequent
  // bytes or EOF means the controlling probe disappeared or violated the
  // one-message protocol; either way, release Secure Event Input immediately.
  _ = handle.availableData
  DispatchQueue.main.async {
    application.terminate(nil)
  }
}
application.run()
