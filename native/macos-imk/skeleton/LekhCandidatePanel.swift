import AppKit

public struct LekhCandidateDisplayItem: Equatable {
  public let text: String
  public let label: String?
  public let badge: String
  public let explanation: String
}

private final class LekhCandidateButton: NSButton {
  let candidateText: String

  init(candidateText: String) {
    self.candidateText = candidateText
    super.init(frame: .zero)
  }

  required init?(coder: NSCoder) {
    nil
  }
}

public final class LekhCandidatePanel: NSObject {
  private var panel: NSPanel?
  private var onSelect: ((String) -> Void)?

  public override init() {
    super.init()
  }

  public func show(items: [LekhCandidateDisplayItem], title: String, onSelect: @escaping (String) -> Void) {
    guard !items.isEmpty else {
      hide()
      return
    }
    self.onSelect = onSelect

    let panel = self.panel ?? makePanel()
    self.panel = panel
    panel.contentView = contentView(items: items, title: title)

    let rowHeight: CGFloat = 42
    let height = min(340, CGFloat(items.count) * rowHeight + 40)
    let width: CGFloat = 420
    let mouse = NSEvent.mouseLocation
    let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let x = min(max(mouse.x + 12, screenFrame.minX + 12), screenFrame.maxX - width - 12)
    let y = min(max(mouse.y - height - 12, screenFrame.minY + 12), screenFrame.maxY - height - 12)
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

  private func contentView(items: [LekhCandidateDisplayItem], title: String) -> NSView {
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
      stack.addArrangedSubview(row(index: index, item: item))
    }

    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: visual.leadingAnchor, constant: 12),
      stack.trailingAnchor.constraint(equalTo: visual.trailingAnchor, constant: -12),
      stack.topAnchor.constraint(equalTo: visual.topAnchor, constant: 10),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: visual.bottomAnchor, constant: -10)
    ])
    return visual
  }

  private func row(index: Int, item: LekhCandidateDisplayItem) -> NSView {
    let button = LekhCandidateButton(candidateText: item.text)
    button.target = self
    button.action = #selector(selectCandidate(_:))
    button.isBordered = false
    button.bezelStyle = .regularSquare
    button.toolTip = item.explanation
    button.translatesAutoresizingMaskIntoConstraints = false

    let container = NSStackView()
    container.orientation = .horizontal
    container.alignment = .centerY
    container.spacing = 8
    container.edgeInsets = NSEdgeInsets(top: 4, left: 2, bottom: 4, right: 2)

    let shortcut = NSTextField(labelWithString: "\(index + 1)")
    shortcut.alignment = .center
    shortcut.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
    shortcut.textColor = .secondaryLabelColor
    shortcut.widthAnchor.constraint(equalToConstant: 20).isActive = true
    container.addArrangedSubview(shortcut)

    let candidate = NSTextField(labelWithString: item.text)
    candidate.font = NSFont(name: "Kohinoor Devanagari", size: 20) ?? .systemFont(ofSize: 19, weight: .medium)
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
    badge.textColor = .tertiaryLabelColor
    badge.alignment = .right
    badge.widthAnchor.constraint(greaterThanOrEqualToConstant: 56).isActive = true
    container.addArrangedSubview(badge)

    button.addSubview(container)
    NSLayoutConstraint.activate([
      container.leadingAnchor.constraint(equalTo: button.leadingAnchor, constant: 4),
      container.trailingAnchor.constraint(equalTo: button.trailingAnchor, constant: -4),
      container.topAnchor.constraint(equalTo: button.topAnchor),
      container.bottomAnchor.constraint(equalTo: button.bottomAnchor),
      button.heightAnchor.constraint(equalToConstant: 36),
      button.widthAnchor.constraint(greaterThanOrEqualToConstant: 390)
    ])
    return button
  }

  @objc private func selectCandidate(_ sender: LekhCandidateButton) {
    onSelect?(sender.candidateText)
  }
}
