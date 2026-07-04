import AppKit

public struct LekhCandidateDisplayItem: Equatable {
  public let text: String
  public let label: String?
  public let badge: String
  public let explanation: String
}

private final class LekhCandidateRowView: NSView {
  let candidateText: String
  var onSelect: ((String) -> Void)?

  init(candidateText: String) {
    self.candidateText = candidateText
    super.init(frame: .zero)
    wantsLayer = true
  }

  required init?(coder: NSCoder) {
    nil
  }

  override func mouseDown(with event: NSEvent) {
    onSelect?(candidateText)
  }

  override func resetCursorRects() {
    addCursorRect(bounds, cursor: .pointingHand)
  }
}

public final class LekhCandidatePanel: NSObject {
  private var panel: NSPanel?
  private var onSelect: ((String) -> Void)?
  private let maxVisibleRows = 5

  public override init() {
    super.init()
  }

  public func show(
    items: [LekhCandidateDisplayItem],
    title: String,
    selectedIndex: Int,
    anchorRect: NSRect?,
    onSelect: @escaping (String) -> Void
  ) {
    guard !items.isEmpty else {
      hide()
      return
    }
    self.onSelect = onSelect

    let panel = self.panel ?? makePanel()
    self.panel = panel
    let visibleItems = Array(items.prefix(maxVisibleRows))
    panel.contentView = contentView(items: visibleItems, title: title, selectedIndex: min(selectedIndex, visibleItems.count - 1))

    let rowHeight: CGFloat = 38
    let height = min(250, CGFloat(visibleItems.count) * rowHeight + 42)
    let width: CGFloat = 420
    let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let fallbackPoint = NSEvent.mouseLocation
    let anchor = anchorRect ?? NSRect(x: fallbackPoint.x, y: fallbackPoint.y, width: 1, height: 20)
    let x = min(max(anchor.minX, screenFrame.minX + 12), screenFrame.maxX - width - 12)
    let preferredY = anchor.minY - height - 8
    let alternateY = anchor.maxY + 8
    let y = preferredY >= screenFrame.minY + 12
      ? preferredY
      : min(max(alternateY, screenFrame.minY + 12), screenFrame.maxY - height - 12)
    panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: true)
    panel.orderFrontRegardless()
  }

  public func hide() {
    panel?.orderOut(nil)
    onSelect = nil
  }

  private func makePanel() -> NSPanel {
    let panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 420, height: 220),
      styleMask: [.nonactivatingPanel, .hudWindow],
      backing: .buffered,
      defer: false
    )
    panel.level = .floating
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
    panel.animationBehavior = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? .none : .utilityWindow
    return panel
  }

  private func contentView(items: [LekhCandidateDisplayItem], title: String, selectedIndex: Int) -> NSView {
    let visual = NSVisualEffectView()
    visual.material = .hudWindow
    visual.blendingMode = .behindWindow
    visual.state = .active

    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 6
    stack.translatesAutoresizingMaskIntoConstraints = false
    visual.addSubview(stack)

    let titleLabel = NSTextField(labelWithString: title)
    titleLabel.font = .systemFont(ofSize: 11, weight: .semibold)
    titleLabel.textColor = .secondaryLabelColor
    stack.addArrangedSubview(titleLabel)

    for (index, item) in items.enumerated() {
      stack.addArrangedSubview(row(index: index, item: item, isSelected: index == selectedIndex))
    }

    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: visual.leadingAnchor, constant: 12),
      stack.trailingAnchor.constraint(equalTo: visual.trailingAnchor, constant: -12),
      stack.topAnchor.constraint(equalTo: visual.topAnchor, constant: 10),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: visual.bottomAnchor, constant: -10)
    ])
    return visual
  }

  private func row(index: Int, item: LekhCandidateDisplayItem, isSelected: Bool) -> NSView {
    let row = LekhCandidateRowView(candidateText: item.text)
    row.onSelect = { [weak self] candidate in
      self?.onSelect?(candidate)
    }
    row.toolTip = item.explanation
    row.translatesAutoresizingMaskIntoConstraints = false
    row.layer?.cornerRadius = 7
    row.layer?.backgroundColor = isSelected
      ? NSColor.controlAccentColor.withAlphaComponent(0.20).cgColor
      : NSColor.clear.cgColor

    let container = NSStackView()
    container.orientation = .horizontal
    container.alignment = .centerY
    container.spacing = 8
    container.edgeInsets = NSEdgeInsets(top: 4, left: 2, bottom: 4, right: 2)
    container.translatesAutoresizingMaskIntoConstraints = false

    let shortcut = NSTextField(labelWithString: "\(index + 1)")
    shortcut.alignment = .center
    shortcut.font = .monospacedDigitSystemFont(ofSize: 11, weight: isSelected ? .semibold : .medium)
    shortcut.textColor = isSelected ? .controlAccentColor : .secondaryLabelColor
    shortcut.widthAnchor.constraint(equalToConstant: 20).isActive = true
    container.addArrangedSubview(shortcut)

    let candidate = NSTextField(labelWithString: item.text)
    candidate.font = LekhFont.devanagari(size: 20, weight: isSelected ? .semibold : .medium)
    candidate.lineBreakMode = .byTruncatingTail
    candidate.textColor = .labelColor
    candidate.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    container.addArrangedSubview(candidate)

    if let label = item.label, !label.isEmpty {
      let helper = NSTextField(labelWithString: label)
      helper.font = .systemFont(ofSize: 11)
      helper.textColor = .secondaryLabelColor
      helper.lineBreakMode = .byTruncatingTail
      helper.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
      container.addArrangedSubview(helper)
    }

    let badge = NSTextField(labelWithString: item.badge)
    badge.font = .systemFont(ofSize: 10, weight: .semibold)
    badge.textColor = isSelected ? .secondaryLabelColor : .tertiaryLabelColor
    badge.alignment = .right
    badge.widthAnchor.constraint(greaterThanOrEqualToConstant: 56).isActive = true
    container.addArrangedSubview(badge)

    row.addSubview(container)
    NSLayoutConstraint.activate([
      container.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 4),
      container.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -4),
      container.topAnchor.constraint(equalTo: row.topAnchor),
      container.bottomAnchor.constraint(equalTo: row.bottomAnchor),
      row.heightAnchor.constraint(equalToConstant: 34),
      row.widthAnchor.constraint(greaterThanOrEqualToConstant: 390)
    ])
    return row
  }
}
