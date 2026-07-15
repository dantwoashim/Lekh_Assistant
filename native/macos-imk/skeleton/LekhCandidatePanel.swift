import AppKit

public struct LekhCandidateDisplayItem: Equatable {
  public let text: String
  public let label: String?
  public let badge: String
  public let explanation: String
}

/// A nonactivating candidate row. Mouse selection happens on mouse-up inside
/// the row so a press-drag away cannot accidentally commit text.
private final class LekhCandidateRowView: NSView {
  let candidateIndex: Int
  let candidateText: String
  var onHighlight: ((Int, String) -> Void)?
  var onSelect: ((Int, String) -> Void)?

  private var trackingArea: NSTrackingArea?
  private var isPointerInside = false
  private let selected: Bool
  private let increaseContrast: Bool

  init(candidateIndex: Int, candidateText: String, selected: Bool, increaseContrast: Bool) {
    self.candidateIndex = candidateIndex
    self.candidateText = candidateText
    self.selected = selected
    self.increaseContrast = increaseContrast
    super.init(frame: .zero)
    wantsLayer = true
    updateBackground()
  }

  required init?(coder: NSCoder) {
    nil
  }

  override var acceptsFirstResponder: Bool { false }

  override func mouseUp(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    guard bounds.contains(point) else { return }
    if event.clickCount >= 2 {
      onSelect?(candidateIndex, candidateText)
    } else {
      onHighlight?(candidateIndex, candidateText)
    }
  }

  override func mouseEntered(with event: NSEvent) {
    isPointerInside = true
    updateBackground()
  }

  override func mouseExited(with event: NSEvent) {
    isPointerInside = false
    updateBackground()
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let trackingArea {
      removeTrackingArea(trackingArea)
    }
    let trackingArea = NSTrackingArea(
      rect: bounds,
      options: [.activeAlways, .inVisibleRect, .mouseEnteredAndExited],
      owner: self,
      userInfo: nil
    )
    addTrackingArea(trackingArea)
    self.trackingArea = trackingArea
  }

  override func resetCursorRects() {
    addCursorRect(bounds, cursor: .pointingHand)
  }

  override func accessibilityPerformPress() -> Bool {
    onSelect?(candidateIndex, candidateText)
    return true
  }

  private func updateBackground() {
    let color: NSColor
    if selected {
      color = NSColor.controlAccentColor.withAlphaComponent(increaseContrast ? 0.34 : 0.20)
    } else if isPointerInside {
      color = NSColor.labelColor.withAlphaComponent(increaseContrast ? 0.14 : 0.07)
    } else {
      color = .clear
    }
    layer?.backgroundColor = color.cgColor
    layer?.cornerRadius = 8
  }
}

/// Native, non-focus-stealing candidate UI with an explicit passive state.
/// The panel shows three choices while browsing is passive and expands to a
/// paged eight-row list only after the user presses an arrow key.
public final class LekhCandidatePanel: NSObject {
  public static let pageSize = 8
  public static let passiveVisibleRows = 3

  private var panel: NSPanel?
  private var onHighlight: ((Int, String) -> Void)?
  private var onSelect: ((Int, String) -> Void)?

  public var isVisible: Bool {
    guard let panel, panel.isVisible else { return false }
    return NSScreen.screens.contains { $0.visibleFrame.intersects(panel.frame) }
  }

  public override init() {
    super.init()
  }

  @discardableResult
  public func show(
    items: [LekhCandidateDisplayItem],
    title: String,
    sourceText: String? = nil,
    selectedIndex: Int?,
    anchorRect: NSRect?,
    expanded: Bool,
    passiveCommitText: String? = nil,
    announceSelection: Bool = false,
    onHighlight: @escaping (Int, String) -> Void,
    onSelect: @escaping (Int, String) -> Void
  ) -> Bool {
    guard !items.isEmpty,
          let anchorRect,
          Self.isUsable(anchorRect: anchorRect) else {
      hide()
      return false
    }
    self.onHighlight = onHighlight
    self.onSelect = onSelect

    let pageSize = Self.pageSize
    let pageCount = max(1, Int(ceil(Double(items.count) / Double(pageSize))))
    let selectedPage = min(max((selectedIndex ?? 0) / pageSize, 0), pageCount - 1)
    let pageStart = selectedPage * pageSize
    let requestedRowCount = expanded ? pageSize : Self.passiveVisibleRows
    let pageEnd = min(pageStart + requestedRowCount, items.count)
    let indexedItems = (pageStart..<pageEnd).map { ($0, items[$0]) }

    let panel = self.panel ?? makePanel()
    self.panel = panel
    panel.animationBehavior = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? .none : .utilityWindow
    panel.contentView = contentView(
      items: indexedItems,
      title: title,
      sourceText: sourceText,
      selectedIndex: selectedIndex,
      page: selectedPage,
      pageCount: pageCount,
      totalCount: items.count,
      expanded: expanded,
      passiveCommitText: passiveCommitText
    )
    panel.contentView?.layoutSubtreeIfNeeded()

    let fitting = panel.contentView?.fittingSize ?? NSSize(width: 420, height: 180)
    let screen = NSScreen.screens.first(where: { $0.frame.intersects(anchorRect) }) ?? NSScreen.main
    let screenFrame = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let minimumWidth: CGFloat = expanded ? 360 : 292
    let width = min(max(fitting.width, minimumWidth), min(480, screenFrame.width - 24))
    let height = min(max(fitting.height, 72), screenFrame.height - 24)
    let x = min(max(anchorRect.minX, screenFrame.minX + 12), screenFrame.maxX - width - 12)
    let preferredY = anchorRect.minY - height - 8
    let alternateY = anchorRect.maxY + 8
    let y = preferredY >= screenFrame.minY + 12
      ? preferredY
      : min(max(alternateY, screenFrame.minY + 12), screenFrame.maxY - height - 12)
    panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: true)
    panel.orderFrontRegardless()

    if announceSelection,
       NSWorkspace.shared.isVoiceOverEnabled,
       let selectedIndex,
       items.indices.contains(selectedIndex) {
      let item = items[selectedIndex]
      announce(LekhL10n.text("candidate.accessibility", selectedIndex + 1, item.text, item.badge))
    }
    // `orderFrontRegardless` only requests presentation. A detached Space,
    // invalid screen, or host transition can make that request a no-op. The
    // controller may authorize keyboard acceptance only after the panel is
    // actually visible on a current screen.
    return isVisible
  }

  public func hide() {
    panel?.orderOut(nil)
    onHighlight = nil
    onSelect = nil
  }

  private func makePanel() -> NSPanel {
    let panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 420, height: 220),
      styleMask: [.nonactivatingPanel, .borderless],
      backing: .buffered,
      defer: false
    )
    panel.level = .floating
    // Candidate UI belongs to the active text session, not to the IMK agent's
    // activation/hidden state. Keep it independently visible without stealing
    // focus from the host application.
    panel.canHide = false
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.becomesKeyOnlyIfNeeded = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
    panel.animationBehavior = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? .none : .utilityWindow
    panel.setAccessibilityElement(true)
    panel.setAccessibilityRole(.group)
    panel.setAccessibilityLabel(LekhL10n.text("candidate.panel.accessibility"))
    return panel
  }

  private func contentView(
    items: [(index: Int, item: LekhCandidateDisplayItem)],
    title: String,
    sourceText: String?,
    selectedIndex: Int?,
    page: Int,
    pageCount: Int,
    totalCount: Int,
    expanded: Bool,
    passiveCommitText: String?
  ) -> NSView {
    let workspace = NSWorkspace.shared
    let reduceTransparency = workspace.accessibilityDisplayShouldReduceTransparency
    let increaseContrast = workspace.accessibilityDisplayShouldIncreaseContrast

    let visual = NSVisualEffectView()
    visual.material = .popover
    visual.blendingMode = reduceTransparency ? .withinWindow : .behindWindow
    visual.state = .active
    visual.wantsLayer = true
    visual.layer?.cornerRadius = 12
    visual.layer?.masksToBounds = true
    visual.layer?.backgroundColor = reduceTransparency ? NSColor.windowBackgroundColor.cgColor : NSColor.clear.cgColor
    visual.layer?.borderWidth = increaseContrast ? 1.5 : 0.5
    visual.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(increaseContrast ? 0.9 : 0.45).cgColor
    visual.setAccessibilityElement(true)
    visual.setAccessibilityRole(.list)
    visual.setAccessibilityLabel(LekhL10n.text("candidate.panel.accessibility"))

    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 5
    stack.translatesAutoresizingMaskIntoConstraints = false
    visual.addSubview(stack)

    let header = NSStackView()
    header.orientation = .horizontal
    header.alignment = .centerY
    header.spacing = 8

    let titleLabel = NSTextField(labelWithString: title)
    titleLabel.font = .systemFont(ofSize: 11, weight: .semibold)
    titleLabel.textColor = increaseContrast ? .labelColor : .secondaryLabelColor
    titleLabel.lineBreakMode = .byTruncatingTail
    titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    header.addArrangedSubview(titleLabel)

    if let sourceText, !sourceText.isEmpty {
      let sourceLabel = NSTextField(labelWithString: sourceText)
      let sourceHasDevanagari = sourceText.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil
      sourceLabel.font = sourceHasDevanagari
        ? LekhFont.devanagari(size: 12)
        : .systemFont(ofSize: 11, weight: .regular)
      sourceLabel.textColor = increaseContrast ? .secondaryLabelColor : .tertiaryLabelColor
      sourceLabel.lineBreakMode = .byTruncatingMiddle
      sourceLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
      header.addArrangedSubview(sourceLabel)
    }

    let headerSpacer = NSView()
    headerSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    headerSpacer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    header.addArrangedSubview(headerSpacer)

    let countText = pageCount > 1
      ? LekhL10n.text("candidate.page", page + 1, pageCount)
      : LekhL10n.text("candidate.count", totalCount)
    let countLabel = NSTextField(labelWithString: countText)
    countLabel.font = .monospacedDigitSystemFont(ofSize: 10, weight: .medium)
    countLabel.textColor = increaseContrast ? .secondaryLabelColor : .tertiaryLabelColor
    countLabel.alignment = .right
    header.addArrangedSubview(countLabel)
    stack.addArrangedSubview(header)

    let routineBadges = Set([
      LekhL10n.text("candidate.badge.unicode"),
      LekhL10n.text("candidate.badge.roman")
    ])
    let visibleBadges = Set(items.map { $0.item.badge })
    let showBadges = visibleBadges.count > 1 || visibleBadges.contains { !routineBadges.contains($0) }

    for (visibleOffset, indexedItem) in items.enumerated() {
      stack.addArrangedSubview(
        row(
          absoluteIndex: indexedItem.index,
          shortcutNumber: visibleOffset + 1,
          item: indexedItem.item,
          isSelected: indexedItem.index == selectedIndex,
          expanded: expanded,
          showBadge: showBadges,
          increaseContrast: increaseContrast
        )
      )
    }

    let hintText: String
    if expanded {
      hintText = LekhL10n.text("candidate.hint.active")
    } else if let passiveCommitText, !passiveCommitText.isEmpty {
      hintText = LekhL10n.text("candidate.hint.passiveAuto", passiveCommitText)
    } else {
      hintText = LekhL10n.text("candidate.hint.passive")
    }
    let hint = NSTextField(labelWithString: hintText)
    hint.font = .systemFont(ofSize: 10, weight: .medium)
    hint.textColor = increaseContrast ? .secondaryLabelColor : .tertiaryLabelColor
    hint.lineBreakMode = .byTruncatingTail
    stack.addArrangedSubview(hint)

    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: visual.leadingAnchor, constant: 10),
      stack.trailingAnchor.constraint(equalTo: visual.trailingAnchor, constant: -10),
      stack.topAnchor.constraint(equalTo: visual.topAnchor, constant: 9),
      stack.bottomAnchor.constraint(equalTo: visual.bottomAnchor, constant: -9),
      header.widthAnchor.constraint(equalTo: stack.widthAnchor)
    ])
    return visual
  }

  private func row(
    absoluteIndex: Int,
    shortcutNumber: Int,
    item: LekhCandidateDisplayItem,
    isSelected: Bool,
    expanded: Bool,
    showBadge: Bool,
    increaseContrast: Bool
  ) -> NSView {
    let row = LekhCandidateRowView(
      candidateIndex: absoluteIndex,
      candidateText: item.text,
      selected: isSelected,
      increaseContrast: increaseContrast
    )
    row.onSelect = { [weak self] index, candidate in
      self?.onSelect?(index, candidate)
    }
    row.onHighlight = { [weak self] index, candidate in
      self?.onHighlight?(index, candidate)
    }
    row.toolTip = item.explanation
    row.setAccessibilityElement(true)
    row.setAccessibilityRole(.button)
    row.setAccessibilityIdentifier("lekh.candidate.\(absoluteIndex)")
    row.setAccessibilityLabel(LekhL10n.text("candidate.accessibility", absoluteIndex + 1, item.text, item.badge))
    row.setAccessibilityHelp(item.explanation)
    row.setAccessibilitySelected(isSelected)
    row.translatesAutoresizingMaskIntoConstraints = false

    let container = NSStackView()
    container.orientation = .horizontal
    container.alignment = .centerY
    container.spacing = 8
    container.edgeInsets = NSEdgeInsets(top: 4, left: 3, bottom: 4, right: 3)
    container.translatesAutoresizingMaskIntoConstraints = false

    let shortcutText = expanded ? "\(shortcutNumber)" : "⌥\(shortcutNumber)"
    let shortcut = NSTextField(labelWithString: shortcutText)
    shortcut.alignment = .center
    shortcut.font = .monospacedDigitSystemFont(ofSize: 10, weight: isSelected ? .bold : .semibold)
    shortcut.textColor = isSelected ? .controlAccentColor : .secondaryLabelColor
    shortcut.widthAnchor.constraint(equalToConstant: expanded ? 23 : 31).isActive = true
    shortcut.setAccessibilityElement(false)
    container.addArrangedSubview(shortcut)

    let candidate = NSTextField(labelWithString: item.text)
    let hasDevanagari = item.text.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil
    candidate.font = hasDevanagari
      ? LekhFont.devanagari(size: 20, weight: isSelected ? .semibold : .medium)
      : NSFont.systemFont(ofSize: 16, weight: isSelected ? .semibold : .medium)
    candidate.lineBreakMode = .byTruncatingTail
    candidate.textColor = .labelColor
    candidate.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    candidate.setAccessibilityElement(false)
    container.addArrangedSubview(candidate)

    if let label = item.label, !label.isEmpty, label != item.text {
      let helper = NSTextField(labelWithString: label)
      helper.font = .systemFont(ofSize: 11)
      helper.textColor = increaseContrast ? .secondaryLabelColor : .tertiaryLabelColor
      helper.lineBreakMode = .byTruncatingTail
      helper.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
      helper.setAccessibilityElement(false)
      container.addArrangedSubview(helper)
    }

    if showBadge {
      let badge = NSTextField(labelWithString: item.badge)
      badge.font = .systemFont(ofSize: 10, weight: .semibold)
      badge.textColor = increaseContrast ? .secondaryLabelColor : .tertiaryLabelColor
      badge.alignment = .right
      badge.widthAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
      badge.setAccessibilityElement(false)
      container.addArrangedSubview(badge)
    }

    row.addSubview(container)
    NSLayoutConstraint.activate([
      container.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 3),
      container.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -3),
      container.topAnchor.constraint(equalTo: row.topAnchor),
      container.bottomAnchor.constraint(equalTo: row.bottomAnchor),
      row.heightAnchor.constraint(greaterThanOrEqualToConstant: 36),
      row.widthAnchor.constraint(greaterThanOrEqualToConstant: expanded ? 338 : 270)
    ])
    return row
  }

  private func announce(_ text: String) {
    NSAccessibility.post(
      element: NSApplication.shared,
      notification: .announcementRequested,
      userInfo: [
        .announcement: text,
        .priority: NSAccessibilityPriorityLevel.medium.rawValue
      ]
    )
  }

  private static func isUsable(anchorRect: NSRect) -> Bool {
    guard !anchorRect.isEmpty,
          anchorRect.origin.x.isFinite,
          anchorRect.origin.y.isFinite,
          anchorRect.size.width.isFinite,
          anchorRect.size.height.isFinite else { return false }
    return NSScreen.screens.contains { $0.frame.intersects(anchorRect) || $0.frame.contains(anchorRect.origin) }
  }
}
