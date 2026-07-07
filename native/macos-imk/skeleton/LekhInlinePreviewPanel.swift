import AppKit

/// Completion-only ghost text that is never part of the host's marked text.
public final class LekhInlinePreviewPanel {
  private var panel: NSPanel?

  public init() {}

  public func show(suffix: String, anchorRect: NSRect?) {
    guard !suffix.isEmpty, let anchorRect, !anchorRect.isEmpty else {
      hide()
      return
    }

    let label = NSTextField(labelWithString: suffix)
    let hasDevanagari = suffix.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil
    label.font = hasDevanagari
      ? LekhFont.devanagari(size: NSFont.systemFontSize + 2)
      : .systemFont(ofSize: NSFont.systemFontSize)
    label.textColor = .placeholderTextColor
    label.backgroundColor = .clear
    label.isBezeled = false
    label.lineBreakMode = .byClipping
    label.sizeToFit()
    label.setAccessibilityElement(true)
    label.setAccessibilityRole(.staticText)
    label.setAccessibilityLabel(LekhL10n.text("inline.preview.accessibility"))

    let width = min(max(label.fittingSize.width + 6, 18), 420)
    let height = max(label.fittingSize.height + 2, anchorRect.height)
    let panel = self.panel ?? makePanel()
    self.panel = panel
    panel.contentView = label

    let screen = NSScreen.screens.first(where: { $0.frame.intersects(anchorRect) }) ?? NSScreen.main
    let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let x = min(max(anchorRect.maxX, visible.minX + 4), visible.maxX - width - 4)
    let y = min(max(anchorRect.minY, visible.minY + 4), visible.maxY - height - 4)
    panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: true)
    panel.orderFrontRegardless()
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
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.ignoresMouseEvents = true
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
    panel.animationBehavior = .none
    return panel
  }
}
