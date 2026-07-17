import AppKit

public struct LekhCandidateDisplayItem: Equatable {
  public let text: String
  public let label: String?
  public let badge: String
  public let explanation: String
}

/// Content-free pointer acceptance state shared by the AppKit row and the
/// native unit probe. A mouse-up has authority only when the same row observed
/// the originating mouse-down inside its bounds.
public struct LekhCandidatePointerGate: Sendable {
  public enum Decision: Equatable, Sendable {
    case ignored
    case cancelled
    case selected
  }

  public private(set) var pressBeganInside = false

  public init() {}

  @discardableResult
  public mutating func beginPress(inside: Bool) -> Bool {
    pressBeganInside = inside
    return pressBeganInside
  }

  public mutating func endPress(inside: Bool) -> Decision {
    guard pressBeganInside else { return .ignored }
    pressBeganInside = false
    return inside ? .selected : .cancelled
  }
}

/// A nonactivating candidate row. Mouse selection happens on mouse-up inside
/// the row so a press-drag away cannot accidentally commit text.
private final class LekhCandidateRowView: NSView {
  let candidateIndex: Int
  let candidateText: String
  var onSelect: ((Int, String) -> Void)?
  var onDragCancellation: (() -> Void)?

  private var trackingArea: NSTrackingArea?
  private var isPointerInside = false
  private var pointerGate = LekhCandidatePointerGate()
  private let selected: Bool
  private let increaseContrast: Bool
  private let differentiateWithoutColor: Bool

  init(
    candidateIndex: Int,
    candidateText: String,
    selected: Bool,
    increaseContrast: Bool,
    differentiateWithoutColor: Bool
  ) {
    self.candidateIndex = candidateIndex
    self.candidateText = candidateText
    self.selected = selected
    self.increaseContrast = increaseContrast
    self.differentiateWithoutColor = differentiateWithoutColor
    super.init(frame: .zero)
    wantsLayer = true
    updateBackground()
  }

  required init?(coder: NSCoder) {
    nil
  }

  override var acceptsFirstResponder: Bool { false }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
    guard let event else { return false }
    return bounds.contains(convert(event.locationInWindow, from: nil))
  }

  override func mouseDown(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    guard pointerGate.beginPress(inside: bounds.contains(point)) else { return }
    isPointerInside = true
    updateBackground()
  }

  override func mouseDragged(with event: NSEvent) {
    guard pointerGate.pressBeganInside else { return }
    isPointerInside = bounds.contains(convert(event.locationInWindow, from: nil))
    updateBackground()
  }

  override func mouseUp(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    let releasedInside = bounds.contains(point)
    let decision = pointerGate.endPress(inside: releasedInside)
    isPointerInside = releasedInside
    updateBackground()
    if decision == .cancelled {
      // This callback carries no row index or candidate text. It proves only
      // that this row owned an inside mouse-down and received mouse-up outside.
      onDragCancellation?()
      return
    }
    guard decision == .selected else { return }
    // A validated mouse-up is already an explicit user acceptance. Commit on
    // the first click like a native macOS candidate row; the controller still
    // verifies the exact client, composition generation, row text and secure
    // state before it is allowed to mutate the host document.
    onSelect?(candidateIndex, candidateText)
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

  override func accessibilityPerformPress() -> Bool {
    onSelect?(candidateIndex, candidateText)
    return true
  }

  private func updateBackground() {
    let color: NSColor
    if selected {
      color = NSColor.controlAccentColor.withAlphaComponent(increaseContrast ? 0.34 : 0.20)
    } else if pointerGate.pressBeganInside && isPointerInside {
      color = NSColor.controlAccentColor.withAlphaComponent(increaseContrast ? 0.26 : 0.14)
    } else if isPointerInside {
      color = NSColor.labelColor.withAlphaComponent(increaseContrast ? 0.14 : 0.07)
    } else {
      color = .clear
    }
    layer?.backgroundColor = color.cgColor
    layer?.cornerRadius = 8
    if selected && (increaseContrast || differentiateWithoutColor) {
      layer?.borderWidth = increaseContrast ? 2 : 1
      layer?.borderColor = NSColor.controlAccentColor.cgColor
    } else {
      layer?.borderWidth = 0
      layer?.borderColor = nil
    }
  }
}

/// Native, non-focus-stealing candidate UI with an explicit passive state.
/// The panel shows three choices while browsing is passive and expands to a
/// paged eight-row list only after the user presses an arrow key.
public final class LekhCandidatePanel: NSObject {
  public static let pageSize = 8
  public static let passiveVisibleRows = 3

  private var panel: NSPanel?
  private var onSelect: ((Int, String) -> Void)?
  private var onDragCancellation: (() -> Void)?
  private var stableWidth: CGFloat?
  private var lastExpandedState: Bool?
  private var lastContentSignature: ContentSignature?

  private struct AccessibilityAppearance: Equatable {
    let reduceTransparency: Bool
    let increaseContrast: Bool
    let differentiateWithoutColor: Bool
  }

  private struct ContentSignature: Equatable {
    let indexes: [Int]
    let items: [LekhCandidateDisplayItem]
    let title: String
    let sourceText: String?
    let selectedIndex: Int?
    let page: Int
    let pageCount: Int
    let totalCount: Int
    let expanded: Bool
    let passiveCommitText: String?
    let appearance: AccessibilityAppearance
  }

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
    onDragCancellation: @escaping () -> Void,
    onSelect: @escaping (Int, String) -> Void
  ) -> Bool {
    guard !items.isEmpty,
          let anchorRect,
          Self.isUsable(anchorRect: anchorRect) else {
      hide()
      return false
    }
    self.onDragCancellation = onDragCancellation
    self.onSelect = onSelect

    let pageSize = Self.pageSize
    let pageCount = max(1, Int(ceil(Double(items.count) / Double(pageSize))))
    let selectedPage = min(max((selectedIndex ?? 0) / pageSize, 0), pageCount - 1)
    let pageStart = selectedPage * pageSize
    let requestedRowCount = expanded ? pageSize : Self.passiveVisibleRows
    let pageEnd = min(pageStart + requestedRowCount, items.count)
    let indexedItems = (pageStart..<pageEnd).map { ($0, items[$0]) }
    let workspace = NSWorkspace.shared
    let appearance = AccessibilityAppearance(
      reduceTransparency: workspace.accessibilityDisplayShouldReduceTransparency,
      increaseContrast: workspace.accessibilityDisplayShouldIncreaseContrast,
      differentiateWithoutColor: workspace.accessibilityDisplayShouldDifferentiateWithoutColor
    )
    let contentSignature = ContentSignature(
      indexes: indexedItems.map(\.0),
      items: indexedItems.map(\.1),
      title: title,
      sourceText: sourceText,
      selectedIndex: selectedIndex,
      page: selectedPage,
      pageCount: pageCount,
      totalCount: items.count,
      expanded: expanded,
      passiveCommitText: passiveCommitText,
      appearance: appearance
    )

    let panel = self.panel ?? makePanel()
    self.panel = panel
    panel.animationBehavior = workspace.accessibilityDisplayShouldReduceMotion ? .none : .utilityWindow
    if panel.contentView == nil || lastContentSignature != contentSignature {
      panel.contentView = contentView(
        items: indexedItems,
        title: title,
        sourceText: sourceText,
        selectedIndex: selectedIndex,
        page: selectedPage,
        pageCount: pageCount,
        totalCount: items.count,
        expanded: expanded,
        passiveCommitText: passiveCommitText,
        appearance: appearance
      )
      lastContentSignature = contentSignature
    }
    panel.contentView?.layoutSubtreeIfNeeded()

    let fitting = panel.contentView?.fittingSize ?? NSSize(width: 420, height: 180)
    let screen = NSScreen.screens.first(where: { $0.frame.intersects(anchorRect) }) ?? NSScreen.main
    let screenFrame = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let minimumWidth: CGFloat = expanded ? 360 : 292
    let maximumWidth = min(480, screenFrame.width - 24)
    guard maximumWidth >= 120, screenFrame.height >= 96 else {
      hide()
      return false
    }
    let fittedWidth = min(max(fitting.width, min(minimumWidth, maximumWidth)), maximumWidth)
    let wasVisible = isVisible
    if !wasVisible || lastExpandedState != expanded {
      stableWidth = nil
    }
    // Candidate labels frequently fluctuate by a few points while the user is
    // typing. Grow when necessary, but do not repeatedly shrink and re-expand
    // the window during one passive/browsing presentation.
    let width = min(max(fittedWidth, stableWidth ?? 0), maximumWidth)
    stableWidth = width
    lastExpandedState = expanded
    let height = min(max(fitting.height, 72), screenFrame.height - 24)
    let x = min(max(anchorRect.minX, screenFrame.minX + 12), screenFrame.maxX - width - 12)
    let preferredY = anchorRect.minY - height - 8
    let alternateY = anchorRect.maxY + 8
    let y = preferredY >= screenFrame.minY + 12
      ? preferredY
      : min(max(alternateY, screenFrame.minY + 12), screenFrame.maxY - height - 12)
    panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: false)
    if wasVisible {
      panel.displayIfNeeded()
    } else {
      panel.orderFrontRegardless()
    }

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
    if panel?.isVisible == true {
      panel?.orderOut(nil)
    }
    stableWidth = nil
    lastExpandedState = nil
    onDragCancellation = nil
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
    panel.isFloatingPanel = true
    panel.worksWhenModal = true
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
    // Expose the floating surface as a real accessibility window. Its content
    // remains a list and each choice remains an individually pressable row.
    // A top-level `.group` made the panel difficult for VoiceOver, Switch
    // Control, and host automation to discover among the IMK process windows.
    panel.setAccessibilityRole(.window)
    panel.setAccessibilityIdentifier("lekh.candidatePanel")
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
    passiveCommitText: String?,
    appearance: AccessibilityAppearance
  ) -> NSView {
    let reduceTransparency = appearance.reduceTransparency
    let increaseContrast = appearance.increaseContrast

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
          increaseContrast: increaseContrast,
          differentiateWithoutColor: appearance.differentiateWithoutColor
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
    increaseContrast: Bool,
    differentiateWithoutColor: Bool
  ) -> NSView {
    let row = LekhCandidateRowView(
      candidateIndex: absoluteIndex,
      candidateText: item.text,
      selected: isSelected,
      increaseContrast: increaseContrast,
      differentiateWithoutColor: differentiateWithoutColor
    )
    row.onSelect = { [weak self] index, candidate in
      self?.onSelect?(index, candidate)
    }
    row.onDragCancellation = { [weak self] in
      self?.onDragCancellation?()
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

    if differentiateWithoutColor {
      let selectionIndicator = NSTextField(labelWithString: isSelected ? "✓" : "")
      selectionIndicator.alignment = .center
      selectionIndicator.font = .systemFont(ofSize: 11, weight: .bold)
      selectionIndicator.textColor = .labelColor
      selectionIndicator.widthAnchor.constraint(equalToConstant: 12).isActive = true
      selectionIndicator.setAccessibilityElement(false)
      container.addArrangedSubview(selectionIndicator)
    }

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
