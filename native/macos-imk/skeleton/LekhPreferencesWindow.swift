import AppKit
import Foundation
import SQLite3
import UniformTypeIdentifiers

public final class LekhPreferencesWindowController: NSObject, NSTextViewDelegate {
  public static let shared = LekhPreferencesWindowController()

  private var window: NSWindow?
  private let maintenance = LekhPersonalDictionaryMaintenance()
  private let dictionaryTextView = NSTextView(frame: .zero)
  private let diagnosticsTextView = NSTextView(frame: .zero)
  private var tutorialWindow: NSWindow?
  private var diagnosticsProvider: (() -> String)?

  public func show(diagnosticsProvider: @escaping () -> String) {
    self.diagnosticsProvider = diagnosticsProvider
    let window = self.window ?? makeWindow()
    self.window = window
    refreshDictionaryText()
    refreshDiagnostics()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  public func showTutorial() {
    let window = tutorialWindow ?? makeTutorialWindow()
    tutorialWindow = window
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    LekhNativePreferences.firstRunTutorialSeen = true
  }

  public func showTutorialIfNeeded() {
    guard !LekhNativePreferences.firstRunTutorialSeen else { return }
    showTutorial()
  }

  private func makeWindow() -> NSWindow {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 720, height: 520),
      styleMask: [.titled, .closable, .miniaturizable],
      backing: .buffered,
      defer: false
    )
    window.title = LekhL10n.text("preferences.title")
    window.center()

    let tabs = NSTabView(frame: window.contentView?.bounds ?? .zero)
    tabs.translatesAutoresizingMaskIntoConstraints = false
    tabs.addTabViewItem(tab(identifier: "typing", label: LekhL10n.text("preferences.typing"), view: typingView()))
    tabs.addTabViewItem(tab(identifier: "personal", label: LekhL10n.text("preferences.personal"), view: personalDictionaryView()))
    tabs.addTabViewItem(tab(identifier: "diagnostics", label: LekhL10n.text("preferences.diagnostics"), view: diagnosticsView()))
    tabs.addTabViewItem(tab(identifier: "tutorial", label: LekhL10n.text("preferences.tutorial"), view: tutorialView()))

    let root = NSView()
    root.addSubview(tabs)
    NSLayoutConstraint.activate([
      tabs.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
      tabs.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
      tabs.topAnchor.constraint(equalTo: root.topAnchor, constant: 12),
      tabs.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12)
    ])
    window.contentView = root
    return window
  }

  private func makeTutorialWindow() -> NSWindow {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 560, height: 360),
      styleMask: [.titled, .closable],
      backing: .buffered,
      defer: false
    )
    window.title = "Lekh Keyboard"

    let mark = NSTextField(labelWithString: "ले")
    mark.alignment = .center
    mark.font = NSFont(name: "Kohinoor Devanagari-Semibold", size: 30) ?? .systemFont(ofSize: 30, weight: .semibold)
    mark.textColor = .white
    mark.wantsLayer = true
    mark.layer?.backgroundColor = NSColor(calibratedRed: 0.07, green: 0.14, blue: 0.12, alpha: 1).cgColor
    mark.layer?.cornerRadius = 10
    mark.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      mark.widthAnchor.constraint(equalToConstant: 58),
      mark.heightAnchor.constraint(equalToConstant: 58)
    ])

    let title = NSTextField(labelWithString: LekhL10n.text("tutorial.title"))
    title.font = .systemFont(ofSize: 24, weight: .semibold)
    title.textColor = .labelColor

    let body = NSTextField(wrappingLabelWithString: LekhL10n.text("tutorial.body"))
    body.font = .systemFont(ofSize: 14)
    body.textColor = .secondaryLabelColor

    let sample = NSTextField(labelWithString: "namaste  →  नमस्ते")
    sample.alignment = .center
    sample.font = NSFont(name: "Kohinoor Devanagari", size: 28) ?? .systemFont(ofSize: 26, weight: .medium)
    sample.wantsLayer = true
    sample.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
    sample.layer?.cornerRadius = 8
    sample.translatesAutoresizingMaskIntoConstraints = false
    sample.heightAnchor.constraint(equalToConstant: 58).isActive = true

    let done = NSButton(title: "Start Typing", target: self, action: #selector(closeTutorial(_:)))
    done.bezelStyle = .rounded

    let stack = verticalStack()
    stack.alignment = .centerX
    stack.edgeInsets = NSEdgeInsets(top: 28, left: 34, bottom: 28, right: 34)
    stack.addArrangedSubview(mark)
    stack.addArrangedSubview(title)
    stack.addArrangedSubview(body)
    stack.addArrangedSubview(sample)
    stack.addArrangedSubview(done)

    let root = NSView()
    root.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      stack.topAnchor.constraint(equalTo: root.topAnchor),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: root.bottomAnchor)
    ])
    window.contentView = root
    return window
  }

  private func tab(identifier: String, label: String, view: NSView) -> NSTabViewItem {
    let item = NSTabViewItem(identifier: identifier)
    item.label = label
    item.view = view
    return item
  }

  private func typingView() -> NSView {
    let stack = verticalStack()
    stack.edgeInsets = NSEdgeInsets(top: 18, left: 18, bottom: 18, right: 18)

    stack.addArrangedSubview(checkbox(
      title: LekhL10n.text("preferences.inline"),
      key: LekhNativePreferences.Keys.inlinePreviewEnabled,
      defaultValue: true
    ))
    stack.addArrangedSubview(checkbox(
      title: LekhL10n.text("preferences.candidates"),
      key: LekhNativePreferences.Keys.customCandidatePanelEnabled,
      defaultValue: true
    ))
    stack.addArrangedSubview(checkbox(
      title: LekhL10n.text("preferences.proofread"),
      key: LekhNativePreferences.Keys.proofreadAsYouTypeEnabled,
      defaultValue: true
    ))
    stack.addArrangedSubview(checkbox(
      title: LekhL10n.text("preferences.punctuation"),
      key: LekhNativePreferences.Keys.smartPunctuationEnabled,
      defaultValue: true
    ))
    stack.addArrangedSubview(checkbox(
      title: LekhL10n.text("preferences.optionLayer"),
      key: LekhNativePreferences.Keys.traditionalOptionLayerEnabled,
      defaultValue: true
    ))

    let strictness = sliderRow(
      title: LekhL10n.text("preferences.strictness"),
      key: LekhNativePreferences.Keys.transliterationStrictness,
      value: LekhNativePreferences.transliterationStrictness
    )
    stack.addArrangedSubview(strictness)

    let mixed = sliderRow(
      title: LekhL10n.text("preferences.mixed"),
      key: LekhNativePreferences.Keys.mixedScriptPreference,
      value: LekhNativePreferences.mixedScriptPreference
    )
    stack.addArrangedSubview(mixed)

    let halanta = NSPopUpButton()
    halanta.addItems(withTitles: ["smart", "explicit", "soft"])
    halanta.selectItem(withTitle: LekhNativePreferences.halantaBehavior)
    halanta.identifier = NSUserInterfaceItemIdentifier(LekhNativePreferences.Keys.halantaBehavior)
    halanta.target = self
    halanta.action = #selector(halantaChanged(_:))
    stack.addArrangedSubview(labeledControl(title: LekhL10n.text("preferences.halanta"), control: halanta))

    return scrollWrapper(stack)
  }

  private func personalDictionaryView() -> NSView {
    dictionaryTextView.isEditable = true
    dictionaryTextView.isRichText = false
    dictionaryTextView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
    dictionaryTextView.delegate = self

    let scroll = NSScrollView()
    scroll.borderType = .bezelBorder
    scroll.hasVerticalScroller = true
    scroll.documentView = dictionaryTextView
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 330).isActive = true

    let buttons = NSStackView()
    buttons.orientation = .horizontal
    buttons.spacing = 8
    buttons.addArrangedSubview(button(LekhL10n.text("preferences.refresh"), action: #selector(refreshDictionaryAction(_:))))
    buttons.addArrangedSubview(button(LekhL10n.text("preferences.save"), action: #selector(saveDictionaryAction(_:))))
    buttons.addArrangedSubview(button(LekhL10n.text("preferences.export"), action: #selector(exportDictionaryAction(_:))))
    buttons.addArrangedSubview(button(LekhL10n.text("preferences.delete"), action: #selector(deleteDictionaryAction(_:))))

    let stack = verticalStack()
    stack.edgeInsets = NSEdgeInsets(top: 18, left: 18, bottom: 18, right: 18)
    stack.addArrangedSubview(scroll)
    stack.addArrangedSubview(buttons)
    return stack
  }

  private func diagnosticsView() -> NSView {
    diagnosticsTextView.isEditable = false
    diagnosticsTextView.isRichText = false
    diagnosticsTextView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)

    let scroll = NSScrollView()
    scroll.borderType = .bezelBorder
    scroll.hasVerticalScroller = true
    scroll.documentView = diagnosticsTextView
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 360).isActive = true

    let stack = verticalStack()
    stack.edgeInsets = NSEdgeInsets(top: 18, left: 18, bottom: 18, right: 18)
    stack.addArrangedSubview(scroll)
    stack.addArrangedSubview(button(LekhL10n.text("preferences.refresh"), action: #selector(refreshDiagnosticsAction(_:))))
    return stack
  }

  private func tutorialView() -> NSView {
    let title = NSTextField(labelWithString: LekhL10n.text("tutorial.title"))
    title.font = .systemFont(ofSize: 22, weight: .semibold)

    let body = NSTextField(wrappingLabelWithString: LekhL10n.text("tutorial.body"))
    body.font = .systemFont(ofSize: 14)

    let sample = NSTextField(labelWithString: "namaste  →  नमस्ते")
    sample.font = NSFont(name: "Kohinoor Devanagari", size: 28) ?? .systemFont(ofSize: 26, weight: .medium)

    let stack = verticalStack()
    stack.edgeInsets = NSEdgeInsets(top: 32, left: 32, bottom: 32, right: 32)
    stack.addArrangedSubview(title)
    stack.addArrangedSubview(body)
    stack.addArrangedSubview(sample)
    stack.addArrangedSubview(button("OK", action: #selector(markTutorialSeen(_:))))
    return stack
  }

  private func checkbox(title: String, key: String, defaultValue: Bool) -> NSButton {
    let current = UserDefaults.standard.object(forKey: key) == nil
      ? defaultValue
      : UserDefaults.standard.bool(forKey: key)
    let checkbox = NSButton(checkboxWithTitle: title, target: self, action: #selector(checkboxChanged(_:)))
    checkbox.identifier = NSUserInterfaceItemIdentifier(key)
    checkbox.state = current ? .on : .off
    return checkbox
  }

  private func sliderRow(title: String, key: String, value: Double) -> NSView {
    let slider = NSSlider(value: value, minValue: 0, maxValue: 1, target: self, action: #selector(sliderChanged(_:)))
    slider.identifier = NSUserInterfaceItemIdentifier(key)
    return labeledControl(title: title, control: slider)
  }

  private func labeledControl(title: String, control: NSView) -> NSView {
    let label = NSTextField(labelWithString: title)
    label.widthAnchor.constraint(equalToConstant: 210).isActive = true
    let row = NSStackView()
    row.orientation = .horizontal
    row.alignment = .centerY
    row.spacing = 12
    row.addArrangedSubview(label)
    row.addArrangedSubview(control)
    return row
  }

  private func button(_ title: String, action: Selector) -> NSButton {
    NSButton(title: title, target: self, action: action)
  }

  private func verticalStack() -> NSStackView {
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 14
    stack.translatesAutoresizingMaskIntoConstraints = false
    return stack
  }

  private func scrollWrapper(_ view: NSView) -> NSView {
    let root = NSView()
    root.addSubview(view)
    NSLayoutConstraint.activate([
      view.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      view.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor),
      view.topAnchor.constraint(equalTo: root.topAnchor),
      view.bottomAnchor.constraint(lessThanOrEqualTo: root.bottomAnchor)
    ])
    return root
  }

  @objc private func checkboxChanged(_ sender: NSButton) {
    guard let key = sender.identifier?.rawValue else { return }
    UserDefaults.standard.set(sender.state == .on, forKey: key)
  }

  @objc private func sliderChanged(_ sender: NSSlider) {
    guard let key = sender.identifier?.rawValue else { return }
    UserDefaults.standard.set(sender.doubleValue, forKey: key)
  }

  @objc private func halantaChanged(_ sender: NSPopUpButton) {
    guard let value = sender.selectedItem?.title else { return }
    UserDefaults.standard.set(value, forKey: LekhNativePreferences.Keys.halantaBehavior)
  }

  @objc private func refreshDictionaryAction(_ sender: Any?) {
    refreshDictionaryText()
  }

  @objc private func saveDictionaryAction(_ sender: Any?) {
    maintenance.replaceFromTSV(dictionaryTextView.string)
    refreshDictionaryText()
  }

  @objc private func exportDictionaryAction(_ sender: Any?) {
    maintenance.exportJSONWithSavePanel()
  }

  @objc private func deleteDictionaryAction(_ sender: Any?) {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = LekhL10n.text("preferences.delete")
    alert.informativeText = "This deletes the local personal dictionary stored only on this Mac."
    alert.addButton(withTitle: LekhL10n.text("preferences.delete"))
    alert.addButton(withTitle: "Cancel")
    if alert.runModal() == .alertFirstButtonReturn {
      maintenance.deleteAll()
      refreshDictionaryText()
    }
  }

  @objc private func refreshDiagnosticsAction(_ sender: Any?) {
    refreshDiagnostics()
  }

  @objc private func markTutorialSeen(_ sender: Any?) {
    LekhNativePreferences.firstRunTutorialSeen = true
  }

  @objc private func closeTutorial(_ sender: Any?) {
    LekhNativePreferences.firstRunTutorialSeen = true
    tutorialWindow?.close()
  }

  private func refreshDictionaryText() {
    dictionaryTextView.string = maintenance.exportTSV()
  }

  private func refreshDiagnostics() {
    diagnosticsTextView.string = [
      diagnosticsProvider?() ?? "diagnostics=unavailable",
      "",
      LekhL10n.text("diagnostics.privacy")
    ].joined(separator: "\n")
  }
}

public final class LekhModePickerWindowController: NSObject {
  public static let shared = LekhModePickerWindowController()

  private var window: NSWindow?
  private var onSelect: ((LekhNativeTypingMode) -> Void)?

  public func show(current: LekhNativeTypingMode, onSelect: @escaping (LekhNativeTypingMode) -> Void) {
    self.onSelect = onSelect
    let window = makeWindow(current: current)
    self.window = window
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  private func makeWindow(current: LekhNativeTypingMode) -> NSWindow {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 580, height: 430),
      styleMask: [.titled, .closable],
      backing: .buffered,
      defer: false
    )
    window.title = "Choose Lekh Mode"

    let title = NSTextField(labelWithString: "Choose how Lekh should type")
    title.font = .systemFont(ofSize: 23, weight: .semibold)

    let body = NSTextField(wrappingLabelWithString: "You can change this anytime from the लेख menu bar item or with Control-Option-Space.")
    body.font = .systemFont(ofSize: 13)
    body.textColor = .secondaryLabelColor

    let options = NSStackView()
    options.orientation = .vertical
    options.alignment = .leading
    options.spacing = 8
    options.translatesAutoresizingMaskIntoConstraints = false

    for (index, mode) in LekhNativeTypingMode.visibleModes.enumerated() {
      let button = NSButton(title: "\(index + 1). \(mode.menuLabel)", target: self, action: #selector(selectMode(_:)))
      button.bezelStyle = .rounded
      button.alignment = .left
      button.tag = index
      button.state = mode == current ? .on : .off
      button.translatesAutoresizingMaskIntoConstraints = false
      button.widthAnchor.constraint(equalToConstant: 500).isActive = true
      button.heightAnchor.constraint(equalToConstant: 44).isActive = true
      options.addArrangedSubview(button)
    }

    let privacy = NSTextField(labelWithString: "Local only. No typing is sent anywhere.")
    privacy.font = .systemFont(ofSize: 12, weight: .medium)
    privacy.textColor = .secondaryLabelColor

    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 16
    stack.edgeInsets = NSEdgeInsets(top: 28, left: 34, bottom: 28, right: 34)
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.addArrangedSubview(title)
    stack.addArrangedSubview(body)
    stack.addArrangedSubview(options)
    stack.addArrangedSubview(privacy)

    let root = NSView()
    root.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      stack.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor),
      stack.topAnchor.constraint(equalTo: root.topAnchor),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: root.bottomAnchor)
    ])
    window.contentView = root
    return window
  }

  @objc private func selectMode(_ sender: NSButton) {
    guard LekhNativeTypingMode.visibleModes.indices.contains(sender.tag) else { return }
    let mode = LekhNativeTypingMode.visibleModes[sender.tag]
    onSelect?(mode)
    window?.close()
  }
}

private final class LekhPersonalDictionaryMaintenance {
  private let databaseURL: URL

  init(fileManager: FileManager = .default) {
    databaseURL = fileManager.homeDirectoryForCurrentUser
      .appendingPathComponent("Library", isDirectory: true)
      .appendingPathComponent("Application Support", isDirectory: true)
      .appendingPathComponent("Lekh Keyboard", isDirectory: true)
      .appendingPathComponent("lekh-keyboard.sqlite3")
  }

  func exportTSV() -> String {
    let rows = loadRows()
    let body = rows.map { "\($0.input)\t\($0.output)\t\($0.frequency)\t\($0.lastUsed)" }
    return (["# input\toutput\tfrequency\tlastUsed"] + body).joined(separator: "\n")
  }

  func replaceFromTSV(_ text: String) {
    let parsed = text
      .split(whereSeparator: \.isNewline)
      .compactMap { line -> (String, String, Int)? in
        let trimmed = String(line).trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed.hasPrefix("#") { return nil }
        let parts = trimmed.components(separatedBy: "\t")
        guard parts.count >= 2 else { return nil }
        return (
          parts[0].trimmingCharacters(in: .whitespacesAndNewlines),
          parts[1].trimmingCharacters(in: .whitespacesAndNewlines),
          max(1, Int(parts.dropFirst(2).first ?? "1") ?? 1)
        )
      }
    replace(rows: parsed)
  }

  func exportJSONWithSavePanel() {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = "lekh-personal-dictionary.json"
    panel.allowedContentTypes = [.json]
    guard panel.runModal() == .OK, let url = panel.url else { return }
    let rows = loadRows().map {
      [
        "input": $0.input,
        "output": $0.output,
        "frequency": "\($0.frequency)",
        "lastUsed": $0.lastUsed
      ]
    }
    let payload: [String: Any] = [
      "schemaVersion": 1,
      "privacy": "local-export",
      "entries": rows
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) {
      try? data.write(to: url, options: [.atomic])
    }
  }

  func deleteAll() {
    withDatabase(create: false) { database in
      sqlite3_exec(database, "DELETE FROM user_lexicon", nil, nil, nil)
    }
  }

  private func replace(rows: [(String, String, Int)]) {
    withDatabase(create: true) { database in
      sqlite3_exec(database, Self.createTableSQL, nil, nil, nil)
      sqlite3_exec(database, "DELETE FROM user_lexicon", nil, nil, nil)
      let sql = """
      INSERT INTO user_lexicon (normalized_input, chosen_output, frequency, last_used, blocked)
      VALUES (?, ?, ?, ?, 0)
      """
      var statement: OpaquePointer?
      guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else { return }
      defer { sqlite3_finalize(statement) }
      let now = ISO8601DateFormatter().string(from: Date())
      for row in rows {
        sqlite3_reset(statement)
        sqlite3_clear_bindings(statement)
        sqlite3_bind_text(statement, 1, row.0, -1, Self.sqliteTransient)
        sqlite3_bind_text(statement, 2, row.1, -1, Self.sqliteTransient)
        sqlite3_bind_int(statement, 3, Int32(row.2))
        sqlite3_bind_text(statement, 4, now, -1, Self.sqliteTransient)
        _ = sqlite3_step(statement)
      }
    }
  }

  private func loadRows() -> [(input: String, output: String, frequency: Int, lastUsed: String)] {
    var rows: [(String, String, Int, String)] = []
    withDatabase(create: false) { database in
      let sql = """
      SELECT normalized_input, chosen_output, frequency, last_used
      FROM user_lexicon
      WHERE blocked = 0
      ORDER BY frequency DESC, last_used DESC
      LIMIT 5000
      """
      var statement: OpaquePointer?
      guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else { return }
      defer { sqlite3_finalize(statement) }
      while sqlite3_step(statement) == SQLITE_ROW {
        guard let input = sqlite3_column_text(statement, 0),
              let output = sqlite3_column_text(statement, 1),
              let lastUsed = sqlite3_column_text(statement, 3) else { continue }
        rows.append((
          String(cString: input),
          String(cString: output),
          Int(sqlite3_column_int(statement, 2)),
          String(cString: lastUsed)
        ))
      }
    }
    return rows
  }

  private func withDatabase(create: Bool, _ body: (OpaquePointer) -> Void) {
    let parent = databaseURL.deletingLastPathComponent()
    if create {
      try? FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
    }
    guard create || FileManager.default.fileExists(atPath: databaseURL.path) else { return }

    var database: OpaquePointer?
    let flags = create
      ? SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
      : SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX
    guard sqlite3_open_v2(databaseURL.path, &database, flags, nil) == SQLITE_OK, let database else {
      sqlite3_close(database)
      return
    }
    defer { sqlite3_close(database) }
    body(database)
  }

  private static let createTableSQL = """
  CREATE TABLE IF NOT EXISTS user_lexicon (
    id INTEGER PRIMARY KEY,
    normalized_input TEXT NOT NULL,
    chosen_output TEXT NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 1,
    last_used TEXT NOT NULL,
    blocked INTEGER NOT NULL DEFAULT 0,
    UNIQUE(normalized_input, chosen_output)
  )
  """

  private static let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
}
