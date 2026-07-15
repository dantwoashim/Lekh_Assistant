import AppKit

/// Completion-only ghost text that is never part of the host's marked text.
/// The nonactivating, mouse-transparent panel cannot steal focus or mutate the
/// host document. `show` returns whether the suggestion is actually visible so
/// the controller never accepts an invisible completion.
public final class LekhInlinePreviewPanel {
  private var panel: NSPanel?

  public var isVisible: Bool {
    guard let panel, panel.isVisible else { return false }
    return NSScreen.screens.contains { $0.visibleFrame.intersects(panel.frame) }
  }

  public init() {}

  @discardableResult
  public func show(
    suffix: String,
    anchorRect: NSRect?,
    hostFont: NSFont? = nil,
    acceptanceHint: String,
    announce: Bool = false
  ) -> Bool {
    guard !suffix.isEmpty,
          let anchorRect,
          Self.isUsable(anchorRect: anchorRect) else {
      hide()
      return false
    }

    let workspace = NSWorkspace.shared
    let increaseContrast = workspace.accessibilityDisplayShouldIncreaseContrast
    // Derive the visual scale from the host's line-height rectangle. This keeps
    // ghost text aligned in Notes, browsers, editors, and large-text fields
    // instead of imposing one system-font size on every client.
    let inferredPointSize = min(max(hostFont?.pointSize ?? anchorRect.height * 0.72, 11), 36)

    let completion = NSTextField(labelWithString: suffix)
    let hasDevanagari = suffix.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil
    completion.font = hostFont.flatMap {
      NSFont(descriptor: $0.fontDescriptor, size: inferredPointSize)
    } ?? (hasDevanagari
      ? LekhFont.devanagari(size: inferredPointSize, weight: increaseContrast ? .medium : .regular)
      : .systemFont(ofSize: inferredPointSize, weight: increaseContrast ? .medium : .regular))
    completion.textColor = increaseContrast ? .secondaryLabelColor : .tertiaryLabelColor
    completion.backgroundColor = .clear
    completion.isBezeled = false
    completion.lineBreakMode = .byClipping
    completion.setContentHuggingPriority(.required, for: .horizontal)
    completion.setAccessibilityElement(false)

    let hint = NSTextField(labelWithString: acceptanceHint)
    hint.font = .systemFont(ofSize: 9, weight: .semibold)
    hint.textColor = increaseContrast ? .labelColor : .secondaryLabelColor
    hint.backgroundColor = .clear
    hint.isBezeled = false
    hint.alignment = .center
    hint.setContentHuggingPriority(.required, for: .horizontal)
    hint.setAccessibilityElement(false)
    hint.wantsLayer = true
    hint.layer?.cornerRadius = 4
    hint.layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(increaseContrast ? 0.16 : 0.08).cgColor

    let content = NSStackView(views: [completion, hint])
    content.orientation = .horizontal
    content.alignment = .centerY
    content.spacing = 5
    content.edgeInsets = NSEdgeInsets(top: 1, left: 2, bottom: 1, right: 3)
    let accessibilityText = Self.accessibilityText(suffix: suffix, acceptanceHint: acceptanceHint)
    content.setAccessibilityElement(true)
    content.setAccessibilityRole(.staticText)
    content.setAccessibilityIdentifier("lekh.inlineCompletion")
    content.setAccessibilityLabel(accessibilityText)
    let screen = NSScreen.screens.first(where: { $0.frame.intersects(anchorRect) }) ?? NSScreen.main
    let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let x = anchorRect.maxX + 1
    let availableWidth = visible.maxX - x - 4
    guard x >= visible.minX + 4, availableWidth >= 18 else {
      hide()
      return false
    }

    // Keep the completion genuinely inline. Near a right screen edge, first
    // collapse the instructional pill to the familiar Tab glyph, then remove
    // it entirely. If even the suffix does not fit to the right of the caret,
    // do not clamp the panel back over text the user already typed; returning
    // false lets the controller show the anchored candidate list instead.
    content.layoutSubtreeIfNeeded()
    var desiredWidth = content.fittingSize.width + 4
    if desiredWidth > min(420, availableWidth) {
      hint.stringValue = "⇥"
      hint.toolTip = acceptanceHint
      content.layoutSubtreeIfNeeded()
      desiredWidth = content.fittingSize.width + 4
    }
    if desiredWidth > min(420, availableWidth) {
      hint.isHidden = true
      content.layoutSubtreeIfNeeded()
      desiredWidth = content.fittingSize.width + 4
    }
    guard desiredWidth <= min(420, availableWidth) else {
      hide()
      return false
    }

    let width = min(max(desiredWidth, 18), 420)
    let height = max(content.fittingSize.height + 2, anchorRect.height)
    let panel = self.panel ?? makePanel()
    self.panel = panel
    panel.contentView = content
    panel.setAccessibilityLabel(accessibilityText)

    let y = min(max(anchorRect.minY, visible.minY + 4), visible.maxY - height - 4)
    panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: true)
    panel.orderFrontRegardless()
    panel.displayIfNeeded()

    if announce {
      self.announce(suffix: suffix, acceptanceHint: acceptanceHint)
    }
    return isVisible
  }

  public func announce(suffix: String, acceptanceHint: String) {
    guard isVisible, NSWorkspace.shared.isVoiceOverEnabled else { return }
    NSAccessibility.post(
      element: NSApplication.shared,
      notification: .announcementRequested,
      userInfo: [
        .announcement: Self.accessibilityText(suffix: suffix, acceptanceHint: acceptanceHint),
        .priority: NSAccessibilityPriorityLevel.low.rawValue
      ]
    )
  }

  public func hide() {
    panel?.orderOut(nil)
  }

  private func makePanel() -> NSPanel {
    let panel = NSPanel(
      contentRect: .zero,
      styleMask: [.nonactivatingPanel, .borderless],
      backing: .buffered,
      defer: false
    )
    panel.level = .floating
    // Input-method agents may be hidden by LaunchServices while their client
    // remains active. This surface must remain independently orderable without
    // activating or unhiding the agent application.
    panel.canHide = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.ignoresMouseEvents = true
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
    panel.animationBehavior = .none
    panel.setAccessibilityElement(true)
    panel.setAccessibilityRole(.staticText)
    panel.setAccessibilityIdentifier("lekh.inlineCompletionPanel")
    return panel
  }

  private static func isUsable(anchorRect: NSRect) -> Bool {
    guard !anchorRect.isEmpty,
          anchorRect.origin.x.isFinite,
          anchorRect.origin.y.isFinite,
          anchorRect.size.width.isFinite,
          anchorRect.size.height.isFinite else { return false }
    return NSScreen.screens.contains { $0.frame.intersects(anchorRect) || $0.frame.contains(anchorRect.origin) }
  }

  private static func accessibilityText(suffix: String, acceptanceHint: String) -> String {
    [
      LekhL10n.text("inline.preview.accessibility"),
      LekhL10n.text("inline.preview.suggestedEnding", suffix),
      acceptanceHint
    ].joined(separator: ". ")
  }
}
