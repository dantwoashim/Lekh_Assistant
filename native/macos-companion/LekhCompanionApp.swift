import AppKit
import SwiftUI

@main
struct LekhCompanionApp: App {
  @StateObject private var model = LekhCompanionModel()

  var body: some Scene {
    WindowGroup {
      CompanionRootView()
        .environmentObject(model)
        .frame(minWidth: 820, minHeight: 620)
    }
    .windowStyle(.titleBar)
    .windowToolbarStyle(.unified)
    .defaultSize(width: 980, height: 700)
    .commands {
      CommandGroup(replacing: .newItem) { }
      CommandGroup(replacing: .appSettings) {
        Button("Lekh Keyboard Settings…") {
          NSApp.activate(ignoringOtherApps: true)
          NSApp.windows.first?.makeKeyAndOrderFront(nil)
        }
        .keyboardShortcut(",", modifiers: .command)
      }
    }
  }
}

struct CompanionRootView: View {
  @EnvironmentObject private var model: LekhCompanionModel
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var showingClearConfirmation = false
  private let refreshTimer = Timer.publish(every: 5.0, on: .main, in: .common).autoconnect()

  var body: some View {
    NavigationSplitView {
      sidebar
    } detail: {
      detail
        .navigationTitle(sectionTitle)
        .toolbar { toolbar }
    }
    .navigationSplitViewStyle(.balanced)
    .onChange(of: scenePhase) { phase in
      if phase == .active { model.refresh() }
    }
    .onReceive(refreshTimer) { _ in
      if scenePhase == .active { model.refreshIfStale() }
    }
    .alert(model.copy.clearLearningTitle, isPresented: $showingClearConfirmation) {
      Button(model.copy.cancel, role: .cancel) { }
      Button(model.copy.clear, role: .destructive) { model.clearPersonalization() }
    } message: {
      Text(model.copy.clearLearningBody)
    }
  }

  private var sidebar: some View {
    List(selection: $model.selectedSection) {
      Section {
        ForEach(CompanionSection.allCases) { section in
          Label(sectionLabel(section), systemImage: section.symbol)
            .tag(section)
        }
      }
      Section {
        Picker(model.copy.language, selection: Binding(
          get: { model.locale },
          set: { model.setLocale($0) }
        )) {
          ForEach(CompanionLocale.allCases) { locale in
            Text(locale.label).tag(locale)
          }
        }
        .pickerStyle(.menu)
      }
    }
    .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 260)
    .safeAreaInset(edge: .top) {
      BrandView(copy: model.copy)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }
  }

  @ViewBuilder private var detail: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        switch model.selectedSection {
        case .home:
          HomeView()
        case .typing:
          TypingView()
        case .privacy:
          PrivacyView(showingClearConfirmation: $showingClearConfirmation)
        case .diagnostics:
          DiagnosticsView()
        }
      }
      .frame(maxWidth: 760, alignment: .leading)
      .padding(28)
    }
    .background(Color(nsColor: .windowBackgroundColor))
    .safeAreaInset(edge: .bottom) {
      if let notice = model.notice {
        CompanionNoticeView(notice: notice)
          .padding(.horizontal, 20)
          .padding(.bottom, 12)
          .transition(reduceMotion ? .identity : .move(edge: .bottom).combined(with: .opacity))
      }
    }
  }

  @ToolbarContentBuilder private var toolbar: some ToolbarContent {
    ToolbarItemGroup {
      Button { model.revealInputMethod() } label: {
        Label(model.copy.revealInstallation, systemImage: "folder")
      }
      .help(model.copy.revealInstallation)
      Button { model.refresh() } label: {
        Label(model.copy.refresh, systemImage: "arrow.clockwise")
      }
      .disabled(model.isRefreshing)
      .help(model.copy.refresh)
    }
  }

  private var sectionTitle: String { sectionLabel(model.selectedSection) }

  private func sectionLabel(_ section: CompanionSection) -> String {
    switch section {
    case .home: return model.copy.home
    case .typing: return model.copy.typing
    case .privacy: return model.copy.privacy
    case .diagnostics: return model.copy.diagnostics
    }
  }
}

private struct CompanionNoticeView: View {
  let notice: CompanionNotice

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: symbol)
        .foregroundStyle(color)
        .accessibilityHidden(true)
      Text(notice.message)
        .font(.callout)
        .foregroundStyle(.primary)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 11)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .strokeBorder(color.opacity(0.45), lineWidth: 1)
    }
    .shadow(color: .black.opacity(0.10), radius: 12, y: 5)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(notice.message)
    .accessibilityAddTraits(.updatesFrequently)
  }

  private var symbol: String {
    switch notice.severity {
    case .success: return "checkmark.circle.fill"
    case .information: return "info.circle.fill"
    case .warning: return "exclamationmark.triangle.fill"
    case .error: return "xmark.octagon.fill"
    }
  }

  private var color: Color {
    switch notice.severity {
    case .success: return .green
    case .information: return .accentColor
    case .warning: return .orange
    case .error: return .red
    }
  }
}

private struct BrandView: View {
  let copy: CompanionCopy

  var body: some View {
    HStack(spacing: 10) {
      ZStack {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(.orange.gradient)
        Text("ले")
          .font(.system(size: 18, weight: .bold))
          .foregroundStyle(.white)
      }
      .frame(width: 38, height: 38)
      VStack(alignment: .leading, spacing: 1) {
        Text(copy.appName).font(.headline)
        Text(copy.companion).font(.caption).foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }
}

private struct HomeView: View {
  @EnvironmentObject private var model: LekhCompanionModel

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      PageIntroduction(title: model.copy.welcomeTitle, body: model.copy.welcomeBody)
      StatusHero()
      SetupProgressView()
      GhostPreview()
    }
  }
}

private struct StatusHero: View {
  @EnvironmentObject private var model: LekhCompanionModel

  var body: some View {
    Card {
      HStack(alignment: .center, spacing: 18) {
        Image(systemName: statusSymbol)
          .font(.system(size: 28, weight: .medium))
          .foregroundStyle(statusColor)
          .frame(width: 48, height: 48)
          .background(statusColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        VStack(alignment: .leading, spacing: 5) {
          Text(statusTitle).font(.title3.weight(.semibold))
          Text(statusBody).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          if let version = model.status.version {
            Text("\(model.copy.version) \(version)")
              .font(.caption.monospacedDigit())
              .foregroundStyle(.tertiary)
          }
        }
        Spacer(minLength: 12)
        Button(actionTitle) { primaryAction() }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
      }
    }
    .accessibilityElement(children: .contain)
  }

  private var statusTitle: String {
    switch model.status.readiness {
    case .missing: return model.copy.missingTitle
    case .installedUnregistered, .approvalRequired: return model.copy.addTitle
    case .enabledNotSelected: return model.copy.readyTitle
    case .selectedUntested: return model.copy.selectedUnverifiedTitle
    case .healthy: return model.copy.workingTitle
    case .degraded: return model.copy.notRespondingTitle
    }
  }

  private var statusBody: String {
    switch model.status.readiness {
    case .missing: return model.copy.missingBody
    case .installedUnregistered, .approvalRequired: return model.copy.addBody
    case .enabledNotSelected: return model.copy.readyBody
    case .selectedUntested: return model.copy.selectedUnverifiedBody
    case .healthy: return model.copy.workingBody
    case .degraded: return model.copy.notRespondingBody
    }
  }

  private var statusSymbol: String {
    switch model.status.readiness {
    case .missing: return "keyboard.badge.ellipsis"
    case .installedUnregistered, .approvalRequired: return "plus.circle"
    case .enabledNotSelected: return "menubar.rectangle"
    case .selectedUntested: return "clock.badge.questionmark"
    case .healthy: return "checkmark.circle.fill"
    case .degraded: return "exclamationmark.triangle.fill"
    }
  }

  private var statusColor: Color {
    switch model.status.readiness {
    case .healthy: return .green
    case .degraded: return .red
    case .selectedUntested, .installedUnregistered, .approvalRequired, .enabledNotSelected: return .orange
    case .missing: return .secondary
    }
  }

  private var actionTitle: String {
    if !model.status.installed || model.status.sourceCount == 0 { return model.copy.openKeyboardSettings }
    if !model.status.enabled { return model.copy.enableLekh }
    if !model.status.selected { return model.copy.useLekhNow }
    return model.copy.tryTextEdit
  }

  private func primaryAction() {
    if model.status.selected {
      model.openPracticeApp()
    } else if model.status.installed, model.status.sourceCount > 0 {
      model.activateKeyboard()
    } else {
      model.openKeyboardSettings()
    }
  }
}

private struct SetupProgressView: View {
  @EnvironmentObject private var model: LekhCompanionModel

  var body: some View {
    Card {
      VStack(alignment: .leading, spacing: 14) {
        Text(model.copy.setupProgress).font(.headline)
        HStack(spacing: 0) {
          SetupStep(
            label: model.copy.installed,
            complete: model.status.installed,
            accessibilityState: model.status.installed ? model.copy.setupComplete : model.copy.setupIncomplete
          )
          SetupConnector(complete: model.status.enabled)
          SetupStep(
            label: model.copy.added,
            complete: model.status.enabled,
            accessibilityState: model.status.enabled ? model.copy.setupComplete : model.copy.setupIncomplete
          )
          SetupConnector(complete: model.status.selected)
          SetupStep(
            label: model.copy.active,
            complete: model.status.selected,
            accessibilityState: model.status.selected ? model.copy.setupComplete : model.copy.setupIncomplete
          )
        }
      }
    }
  }
}

private struct SetupStep: View {
  let label: String
  let complete: Bool
  let accessibilityState: String

  var body: some View {
    VStack(spacing: 7) {
      Image(systemName: complete ? "checkmark.circle.fill" : "circle")
        .font(.title3)
        .foregroundStyle(complete ? Color.green : Color.secondary.opacity(0.45))
      Text(label)
        .font(.caption)
        .foregroundStyle(complete ? .primary : .secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(label)
    .accessibilityValue(accessibilityState)
  }
}

private struct SetupConnector: View {
  let complete: Bool
  var body: some View {
    Rectangle()
      .fill(complete ? Color.green.opacity(0.7) : Color.secondary.opacity(0.2))
      .frame(height: 2)
      .accessibilityHidden(true)
  }
}

private struct GhostPreview: View {
  @EnvironmentObject private var model: LekhCompanionModel

  var body: some View {
    Card {
      VStack(alignment: .leading, spacing: 16) {
        VStack(alignment: .leading, spacing: 5) {
          Text(model.copy.ghostTitle).font(.headline)
          Text(model.copy.ghostBody).foregroundStyle(.secondary)
        }
        Label(previewState.label, systemImage: previewState.symbol)
          .font(.caption.weight(.semibold))
          .foregroundStyle(previewState.color)
          .accessibilityIdentifier("ghost-preview-status")
        Text(model.copy.ghostModeExample(model.preferences.mode))
          .font(.callout.weight(.medium))
        ViewThatFits(in: .horizontal) {
          HStack(alignment: .center, spacing: 16) {
            previewText
            Spacer(minLength: 12)
            acceptanceHint
          }
          VStack(alignment: .leading, spacing: 12) {
            previewText
            acceptanceHint
          }
        }
        .opacity(previewState.isDimmed ? 0.58 : 1)
        Text(model.copy.ghostConfidenceNote)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        if !model.preferences.inlinePreviewEnabled {
          Button(model.copy.enableGhostSuggestions) {
            model.setInlinePreview(true)
          }
          .buttonStyle(.bordered)
          .accessibilityIdentifier("ghost-preview-enable")
        }
      }
    }
  }

  private var previewText: some View {
    HStack(spacing: 0) {
      Text(sample.typed).underline()
      Text(sample.suggestion).foregroundStyle(.secondary)
    }
    .font(.system(size: 30, weight: .medium))
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(model.copy.ghostPreviewAccessibility(typed: sample.typed, suggestion: sample.suggestion))
    .accessibilityValue(previewState.label)
    .accessibilityIdentifier("ghost-preview-sample")
  }

  private var acceptanceHint: some View {
    HStack(spacing: 7) {
      KeyCap("Tab")
      Text(model.copy.accept).font(.callout).foregroundStyle(.secondary)
      Text("·").foregroundStyle(.tertiary).accessibilityHidden(true)
      Text(model.copy.ignore).font(.callout).foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(model.copy.ghostAcceptanceAccessibility)
  }

  private var sample: GhostPreviewSample {
    switch model.preferences.mode {
    case .romanizedNepali, .traditionalNepali:
      return GhostPreviewSample(typed: "स्वा", suggestion: "स्थ्य")
    case .romanizedRomanized, .traditionalRomanized:
      return GhostPreviewSample(typed: "swas", suggestion: "thya")
    }
  }

  private var previewState: GhostPreviewState {
    guard model.preferences.inlinePreviewEnabled else {
      return GhostPreviewState(
        label: model.copy.ghostDisabledStatus,
        symbol: "eye.slash",
        color: .secondary,
        isDimmed: true
      )
    }
    switch model.status.readiness {
    case .healthy:
      return GhostPreviewState(
        label: model.copy.ghostHealthyStatus,
        symbol: "checkmark.circle.fill",
        color: .green,
        isDimmed: false
      )
    case .selectedUntested:
      return GhostPreviewState(
        label: model.copy.ghostSelectedUntestedStatus,
        symbol: "clock.badge.questionmark",
        color: .orange,
        isDimmed: true
      )
    case .degraded:
      return GhostPreviewState(
        label: model.copy.ghostDegradedStatus,
        symbol: "exclamationmark.triangle.fill",
        color: .red,
        isDimmed: true
      )
    case .missing, .installedUnregistered, .approvalRequired, .enabledNotSelected:
      return GhostPreviewState(
        label: model.copy.ghostInactiveStatus,
        symbol: "info.circle.fill",
        color: .orange,
        isDimmed: true
      )
    }
  }
}

private struct GhostPreviewSample {
  let typed: String
  let suggestion: String
}

private struct GhostPreviewState {
  let label: String
  let symbol: String
  let color: Color
  let isDimmed: Bool
}

private struct TypingView: View {
  @EnvironmentObject private var model: LekhCompanionModel

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      PageIntroduction(title: model.copy.typingTitle, body: model.copy.typingBody)
      Card {
        VStack(alignment: .leading, spacing: 14) {
          Text(model.copy.modeTitle).font(.headline)
          Picker(model.copy.modeTitle, selection: Binding(
            get: { model.preferences.mode },
            set: { model.setMode($0) }
          )) {
            ForEach(NativeTypingMode.allCases) { mode in
              VStack(alignment: .leading) {
                Text(model.copy.modeName(mode))
                Text(model.copy.modeDetail(mode))
              }
              .tag(mode)
            }
          }
          .labelsHidden()
          .pickerStyle(.radioGroup)
          Text(model.copy.modeHint).font(.caption).foregroundStyle(.secondary)
        }
      }
      Card {
        VStack(alignment: .leading, spacing: 0) {
          Text(model.copy.assistance).font(.headline)
          Text(model.copy.assistanceDetail(model.preferences.mode))
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 3)
            .padding(.bottom, 8)
          PreferenceToggle(
            title: model.copy.ghostSuggestions,
            detail: model.copy.ghostSuggestionsDetail,
            value: model.preferences.inlinePreviewEnabled,
            setter: model.setInlinePreview
          )
          Divider()
          PreferenceToggle(
            title: model.copy.candidateList,
            detail: model.copy.candidateListDetail,
            value: model.preferences.customCandidatePanelEnabled,
            setter: model.setCandidatePanel
          )
          if showsProofreading {
            Divider()
            PreferenceToggle(
              title: model.copy.proofread,
              detail: model.copy.proofreadDetail,
              value: model.preferences.proofreadAsYouTypeEnabled,
              setter: model.setProofread
            )
          }
          if showsNepaliPunctuation {
            Divider()
            PreferenceToggle(
              title: model.copy.punctuation,
              detail: model.copy.punctuationDetail,
              value: model.preferences.smartPunctuationEnabled,
              setter: model.setPunctuation
            )
          }
        }
        .accessibilityIdentifier("typing-assistance-\(model.preferences.mode.rawValue)")
      }
      ShortcutCard()
    }
  }

  private var showsProofreading: Bool {
    model.preferences.mode == .traditionalNepali || model.preferences.mode == .traditionalRomanized
  }

  private var showsNepaliPunctuation: Bool {
    model.preferences.mode == .romanizedNepali || model.preferences.mode == .traditionalNepali
  }
}

private struct ExcludedApplicationRow: View {
  @EnvironmentObject private var model: LekhCompanionModel
  let application: ExcludedApplication

  var body: some View {
    HStack(spacing: 10) {
      applicationIcon
        .resizable()
        .frame(width: 28, height: 28)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(application.displayName).font(.body.weight(.medium))
        Text(application.bundleIdentifier).font(.caption.monospaced()).foregroundStyle(.secondary)
      }
      Spacer()
      Button(model.copy.removeApplication) {
        model.removeExcludedApplication(application)
      }
      .buttonStyle(.borderless)
      .accessibilityLabel("\(model.copy.removeApplication) \(application.displayName)")
    }
  }

  private var applicationIcon: Image {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: application.bundleIdentifier) else {
      return Image(systemName: "app")
    }
    return Image(nsImage: NSWorkspace.shared.icon(forFile: url.path))
  }
}

private struct ShortcutCard: View {
  @EnvironmentObject private var model: LekhCompanionModel
  var body: some View {
    Card {
      VStack(alignment: .leading, spacing: 12) {
        Text(model.copy.shortcuts).font(.headline)
        ShortcutRow(
          keys: ["Tab", "→"],
          label: model.copy.shortcutAccept,
          accessibilityLabel: model.copy.shortcutAccessibility(keys: ["Tab", "→"], action: model.copy.shortcutAccept)
        )
        ShortcutRow(
          keys: ["↓", "↑"],
          label: model.copy.shortcutAlternates,
          accessibilityLabel: model.copy.shortcutAccessibility(keys: ["↓", "↑"], action: model.copy.shortcutAlternates)
        )
        ShortcutRow(
          keys: ["Space"],
          label: model.copy.shortcutRaw,
          accessibilityLabel: model.copy.shortcutAccessibility(keys: ["Space"], action: model.copy.shortcutRaw)
        )
        ShortcutRow(
          keys: ["Esc"],
          label: model.copy.shortcutDismiss,
          accessibilityLabel: model.copy.shortcutAccessibility(keys: ["Esc"], action: model.copy.shortcutDismiss)
        )
      }
    }
  }
}

private struct ShortcutRow: View {
  let keys: [String]
  let label: String
  let accessibilityLabel: String
  var body: some View {
    HStack {
      HStack(spacing: 5) {
        ForEach(keys, id: \.self) { KeyCap($0) }
      }
      .frame(width: 100, alignment: .leading)
      Text(label).foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
  }
}

private struct PrivacyView: View {
  @EnvironmentObject private var model: LekhCompanionModel
  @Binding var showingClearConfirmation: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      PageIntroduction(title: model.copy.privacyTitle, body: model.copy.privacyBody)
      LazyVGrid(
        columns: [GridItem(.adaptive(minimum: 210), spacing: 14, alignment: .top)],
        alignment: .leading,
        spacing: 14
      ) {
        TrustCard(symbol: "lock.laptopcomputer", title: model.copy.localOnly, detail: model.copy.localOnlyDetail)
        TrustCard(symbol: "eye.slash", title: model.copy.secureFields, detail: model.copy.secureFieldsDetail)
        TrustCard(symbol: "hand.tap", title: model.copy.explicitLearning, detail: model.copy.explicitLearningDetail)
      }
      .accessibilityIdentifier("privacy-trust-grid")
      Card {
        VStack(alignment: .leading, spacing: 0) {
          PreferenceToggle(
            title: model.copy.personalLearning,
            detail: model.copy.personalLearningDetail,
            value: model.preferences.personalizationEnabled,
            setter: model.setPersonalization
          )
          Divider()
          PreferenceToggle(
            title: model.copy.contextRanking,
            detail: model.copy.contextRankingDetail,
            value: model.preferences.nextWordPredictionEnabled,
            setter: model.setNextWord
          )
        }
      }
      Card {
        VStack(alignment: .leading, spacing: 12) {
          HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
              Text(model.copy.neverLearnInApps).font(.headline)
              Text(model.copy.neverLearnInAppsDetail).font(.callout).foregroundStyle(.secondary)
            }
            Spacer(minLength: 16)
            Button(model.copy.addApplications) { model.chooseExcludedApplications() }
          }
          if model.excludedApplications.isEmpty {
            Text(model.copy.noExcludedApplications)
              .font(.callout)
              .foregroundStyle(.tertiary)
          } else {
            Divider()
            ForEach(model.excludedApplications) { application in
              ExcludedApplicationRow(application: application)
              if application.id != model.excludedApplications.last?.id { Divider() }
            }
          }
        }
      }
      Card {
        HStack {
          VStack(alignment: .leading, spacing: 4) {
            Text(model.copy.learnedWords).font(.headline)
            Text(model.copy.learnedCount(model.learnedEntryCount)).foregroundStyle(.secondary)
          }
          Spacer()
          if model.isClearingLearning {
            ProgressView().controlSize(.small).accessibilityLabel(model.copy.clearingLearning)
          }
          Button(model.copy.clearLearning, role: .destructive) {
            showingClearConfirmation = true
          }
          .disabled(model.learnedEntryCount == 0 || model.isClearingLearning)
        }
      }
    }
  }
}

private struct TrustCard: View {
  let symbol: String
  let title: String
  let detail: String
  var body: some View {
    Card {
      VStack(alignment: .leading, spacing: 9) {
        Image(systemName: symbol).font(.title2).foregroundStyle(.orange).accessibilityHidden(true)
        Text(title).font(.headline)
        Text(detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, minHeight: 132, maxHeight: .infinity, alignment: .topLeading)
      .accessibilityElement(children: .combine)
    }
  }
}

private struct DiagnosticsView: View {
  @EnvironmentObject private var model: LekhCompanionModel

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      PageIntroduction(title: model.copy.diagnosticsTitle, body: model.copy.diagnosticsBody)
      Card {
        VStack(alignment: .leading, spacing: 0) {
          DiagnosticRow(label: model.copy.keyboardBundle, value: model.status.installed ? model.copy.installed : model.copy.unavailable)
          Divider()
          DiagnosticRow(label: model.copy.enabledState, value: model.status.enabled ? model.copy.yes : model.copy.no)
          Divider()
          DiagnosticRow(label: model.copy.selectedState, value: model.status.selected ? model.copy.yes : model.copy.no)
          Divider()
          DiagnosticRow(label: model.copy.runtimeHealth, value: runtimeHealthLabel)
          Divider()
          DiagnosticRow(label: model.copy.registeredSources, value: "\(model.status.sourceCount)")
          Divider()
          DiagnosticRow(label: model.copy.signature, value: signatureLabel)
          Divider()
          DiagnosticRow(
            label: model.copy.deterministicEngine,
            value: model.status.deterministicEngineReady ? model.copy.assetsPresent : model.copy.incomplete
          )
          Divider()
          DiagnosticRow(label: model.copy.localDictionary, value: dictionaryLabel)
          Divider()
          DiagnosticRow(label: model.copy.neuralFallback, value: neuralLabel)
        }
      }
      if let artifact = model.status.neuralArtifact {
        Text("\(model.copy.modelArtifact): \(artifact)")
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
      }
      Card {
        VStack(alignment: .leading, spacing: 12) {
          Text(model.copy.diagnosticsFootnote).foregroundStyle(.secondary)
          Button {
            model.copyDiagnostics()
          } label: {
            Label(model.copy.copyDiagnostics, systemImage: "doc.on.doc")
          }
        }
      }
    }
  }

  private var signatureLabel: String {
    switch model.status.signature {
    case .developerID: return model.copy.signedProduction
    case .adHoc, .unsigned: return model.copy.developmentBuild
    case .unavailable: return model.copy.unavailable
    }
  }

  private var neuralLabel: String {
    switch model.status.neuralRuntime {
    case .claimedProduction: return model.copy.manifestClaimUnverified
    case .experimental: return model.copy.experimentalLocalFallback
    case .gated: return model.copy.packagedDisabled
    case .unavailable: return model.copy.notPackaged
    }
  }

  private var runtimeHealthLabel: String {
    switch model.status.readiness {
    case .healthy: return model.copy.ready
    case .selectedUntested: return model.copy.selectedUnverifiedTitle
    case .degraded: return model.copy.notRespondingTitle
    default: return model.copy.unavailable
    }
  }

  private var dictionaryLabel: String {
    guard model.status.dictionaryBytes > 0 else { return model.copy.unavailable }
    return ByteCountFormatter.string(fromByteCount: model.status.dictionaryBytes, countStyle: .file)
  }
}

private struct DiagnosticRow: View {
  let label: String
  let value: String
  var body: some View {
    HStack {
      Text(label)
      Spacer()
      Text(value).foregroundStyle(.secondary).textSelection(.enabled)
    }
    .padding(.vertical, 10)
  }
}

private struct PreferenceToggle: View {
  let title: String
  let detail: String
  let value: Bool
  let setter: (Bool) -> Void

  var body: some View {
    HStack(alignment: .center, spacing: 18) {
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(.body.weight(.medium))
        Text(detail).font(.callout).foregroundStyle(.secondary)
      }
      Spacer(minLength: 24)
      Toggle("", isOn: Binding(get: { value }, set: setter))
        .labelsHidden()
        .toggleStyle(.switch)
        .accessibilityLabel(title)
        .accessibilityHint(detail)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 11)
  }
}

private struct PageIntroduction: View {
  let title: String
  let description: String

  init(title: String, body: String) {
    self.title = title
    description = body
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text(title).font(.largeTitle.weight(.bold))
      Text(description).font(.title3).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
  }
}

private struct Card<Content: View>: View {
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  @Environment(\.colorSchemeContrast) private var colorSchemeContrast
  @ViewBuilder let content: Content

  var body: some View {
    content
      .padding(18)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        reduceTransparency || colorSchemeContrast == .increased
          ? Color(nsColor: .controlBackgroundColor)
          : Color(nsColor: .controlBackgroundColor).opacity(0.72),
        in: RoundedRectangle(cornerRadius: 14, style: .continuous)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(Color.primary.opacity(colorSchemeContrast == .increased ? 0.28 : 0.07), lineWidth: 1)
      )
  }
}

private struct KeyCap: View {
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text)
      .font(.caption.weight(.semibold).monospaced())
      .padding(.horizontal, 7)
      .padding(.vertical, 4)
      .background(Color(nsColor: .tertiaryLabelColor).opacity(0.13), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).stroke(Color.primary.opacity(0.12)))
  }
}
