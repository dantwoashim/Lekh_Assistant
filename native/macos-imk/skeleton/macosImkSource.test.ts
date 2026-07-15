import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("macOS IMK proof target source", () => {
  it("contains a real IMKInputController subclass instead of the old placeholder source", () => {
    const controllerPath = join(root, "native/macos-imk/skeleton/LekhInputController.swift");
    expect(existsSync(controllerPath)).toBe(true);
    expect(existsSync(join(root, "native/macos-imk/skeleton/LekhInputController.placeholder.swift"))).toBe(false);

    const source = readFileSync(controllerPath, "utf8");
    expect(source).toContain("IMKInputController");
    expect(source).toContain("handle(_ event: NSEvent!");
    expect(source).toContain("inputText");
    expect(source).toContain("setMarkedText");
    expect(source).toContain("insertText");
  });

  it("deletes the per-keystroke XPC path and keeps local fail-open behavior", () => {
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhEngineCore.swift"), "utf8");
    const controller = readFileSync(join(root, "native/macos-imk/skeleton/LekhInputController.swift"), "utf8");

    expect(source).not.toContain("LekhXpcEngineClient");
    expect(source).not.toContain("LekhXpcRequestEnvelope");
    expect(source).not.toContain("EngineXPC");
    expect(controller).toContain("processFailOpenKey");
    expect(controller).toContain("insertRaw");
    expect(source).toContain("return .passThrough");
  });

  it("loads the packaged native runtime suggestion pack for flagship Romanized typing", () => {
    const controller = readFileSync(join(root, "native/macos-imk/skeleton/LekhInputController.swift"), "utf8");
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhEngineCore.swift"), "utf8");
    const packageScript = readFileSync(join(root, "scripts/package-macos-imk-dev.mjs"), "utf8");
    const canonicalTokens = readFileSync(join(root, "data/engine/lekh-token-candidates.v1.json"), "utf8");

    expect(controller).not.toContain("LEKH_IMK_USE_XPC");
    expect(controller).not.toContain("/tmp/lekh");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhDiagnostics.swift"), "utf8")).toContain("LEKH_IMK_DIAGNOSTICS");
    expect(controller).toContain("LekhDiagnosticsPolicy.diagnosticsEnabled(secureInputActive: IsSecureEventInputEnabled())");
    expect(controller).toContain("menu.dictionaryWarning");
    expect(controller).toContain("LekhNativeEngineClient");
    expect(packageScript).toContain("runtime-suggestions.json");
    expect(packageScript).toContain("runtime-suggestions.lkb");
    expect(packageScript).toContain("lekh-engine-contract.v1.json");
    expect(packageScript).toContain("--configuration");
    expect(packageScript).toContain("release");
    expect(packageScript).toContain("lipo");
    expect(packageScript).toContain("sanitize-runtime-suggestions");
    expect(packageScript).toContain("compile-runtime-lexicon-binary");
    expect(source).toContain("Data(contentsOf: url, options: [.mappedIfSafe])");
    expect(source).toContain("withExtension: \"lkb\"");
    expect(source).toContain("withExtension: \"json\"");
    expect(source).toContain("RuntimeSuggestionPack");
    expect(source).toContain("loadEngineContract");
    expect(source).toContain("LekhBinaryLexicon");
    expect(source).toContain("LEKHBLX1");
    expect(source).toContain("LekhDictionaryPackVerifier.installedPackStatus");
    expect(source).toContain("confidence: row.confidence");
    expect(source).toContain("LekhRomanizedComposer");
    expect(source).toContain("loadCanonicalTokenOverrides");
    expect(source).toContain('url(forResource: "lekh-token-candidates.v1"');
    expect(packageScript).toContain("tokenCandidateBundlePath");
    expect(source).toContain("composePhraseCandidates");
    expect(canonicalTokens).toContain('"input": "xaina"');
    expect(canonicalTokens).toContain("बाटो");
    expect(source).toContain("LekhUserLexiconStore");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhDictionaryPackVerifier.swift"), "utf8")).toContain("Ed25519");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhDictionaryPackVerifier.swift"), "utf8")).toContain("minAppVersion");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhDictionaryPackVerifier.swift"), "utf8")).toContain("compareVersion");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhDictionaryPackVerifier.swift"), "utf8")).toContain("LEKH_PACK_V2");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhDictionaryPackVerifier.swift"), "utf8")).toContain("installedPackStatus");
    expect(existsSync(join(root, "native/macos-imk/skeleton/LekhNeuralTransliterator.swift"))).toBe(false);
    expect(existsSync(join(root, "native/macos-imk/skeleton/LekhNeuralCandidateService.swift"))).toBe(true);
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhNeuralCandidateService.swift"), "utf8")).toContain("MLModel(contentsOf:");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhNeuralCandidateService.swift"), "utf8")).toContain("guard !secureInputActive else");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhNeuralCandidateService.swift"), "utf8")).toContain("LekhExperimentalNeuralTypingEnabled");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhNeuralCandidateService.swift"), "utf8")).toContain("LEKH_EXPERIMENTAL_NEURAL_TYPING");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhInputController.swift"), "utf8")).toContain("requestAsyncNeuralCandidates");
    expect(controller).toContain("neuralTailEligible: decision.neuralTailEligible");
    expect(controller).toContain("if neuralTailEligible {");
    expect(source).toContain("private func isNeuralTailEligible(");
    expect(source).toContain("runtimeRows(for: normalized, exactOnly: true, limit: 1).isEmpty");
    expect(source).toContain("LekhNeuralCandidateService.shared.status");
    expect(packageScript).toContain("LEKH_PACKAGE_NEURAL_MODEL");
    expect(packageScript).toContain("LEKH_EXPERIMENTAL_NEURAL_TYPING");
    expect(packageScript).toContain("neuralPackagingRequested");
    expect(source).toContain("mayPersonalizeExplicitChoice");
    expect(source).toContain("isVerifiedTokenCompletionCandidate");
    expect(controller).toContain("engineClient.mayPersonalizeExplicitChoice");
    expect(packageScript).toContain(".lekh-imk-package.${process.pid}");
    expect(packageScript).toContain("publish-bundle-atomic-swap");
    expect(packageScript).toContain("published-codesign-verify");
    expect(packageScript).toContain("artifact: publishedAppBundle");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhMetricReporter.swift"), "utf8")).toContain("LekhMetricKitOptIn");
    expect(source).toContain("lekh-keyboard.sqlite3");
    expect(source).toContain("CREATE TABLE IF NOT EXISTS user_lexicon");
    expect(source).toContain("userLexicon.record");
    expect(source).toContain("userLexicon.candidates");
    expect(source).toContain("composeToken");
    expect(source).toContain("ruleCandidates(for:");
    expect(source).toContain("genericConjunctPairs");
    expect(source).toContain("LekhDevanagariRomanizer");
    expect(source).toContain("transliterationStrictness");
    expect(source).toContain("com.lekh.inputmethod.personalization-writer");
    expect(source).not.toContain('("swasthya karyalaya",');
    expect(source).not.toContain('("jilla prashasan karyalaya",');
    expect(packageScript).toContain("runtimeJsonBundlePath");
    expect(packageScript).toContain("neuralModelPackaged = true");
    expect(packageScript).toContain("experimentalNeuralTypingEnabled");
  });

  it("contains native mode switching for all four typing surfaces", () => {
    const controller = readFileSync(join(root, "native/macos-imk/skeleton/LekhInputController.swift"), "utf8");
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhEngineCore.swift"), "utf8");

    expect(source).toContain("LekhNativeTypingMode");
    expect(source).toContain("romanized-romanized");
    expect(source).toContain("romanized-traditional");
    expect(source).toContain("traditional-traditional");
    expect(source).toContain("traditional-romanized");
    expect(source).toContain("visibleModes");
    expect(source).toContain(".traditionalRomanized");
    expect(controller).toContain("Control+Option+Space");
    expect(controller).toContain("modeMenuOpen");
    expect(controller).not.toContain("shouldShowFirstModePicker");
    expect(controller).toContain("Activation must never open or focus Lekh UI");
    expect(controller).not.toContain("modePrompt.activate");
    expect(controller).not.toContain("showTutorialIfNeeded");
    expect(controller).toContain("menu() -> NSMenu!");
    expect(controller).toContain("selectModeFromInputMenu");
    expect(controller).toContain("menu.forgetCandidate");
    expect(controller).toContain("forgetCurrentCandidateFromInputMenu");
    expect(controller).toContain("engineClient.observeCommit");
    expect(controller).toContain("engineClient.forgetCandidate");
    expect(controller).toContain("modeFromMenuKey");
    expect(controller).toContain("finishCompositionBeforeModeSwitch");
    expect(controller).toContain("LekhNativePreferences.Keys.nativeTypingModeChosen");
    expect(controller).toContain("modifiers.contains(.control), modifiers.contains(.option), keyCode == 49");
    expect(controller).toContain("inputText(_ string: String!, key keyCode: Int, modifiers flags: Int, client sender: Any!)");
    expect(controller).toContain("event.inputTextKey");
    expect(controller).toContain("TISSetInputMethodKeyboardLayoutOverride");
    expect(controller).toContain("LekhKeyboardLayoutTranslator.shared");
    expect(controller).toContain("layoutTranslator.translateTraditionalKey");
    expect(controller).toContain("com.apple.keylayout.ABC");
    expect(controller).toContain("com.apple.keylayout.Nepali");
    expect(controller).toContain("usesTraditionalKeyboardLayout");
    expect(controller).toContain("processFailOpenKey");
    expect(controller).toContain("replacePreviouslyPassedThroughRawText");
    expect(controller).toContain("selectedRange()");
    expect(controller).toContain("return true");
    expect(controller).toContain("LEKH_IMK_INLINE_COMPOSITION");
    expect(controller).toContain("LekhLatencyRingBuffer");
    expect(controller).toContain("menu.diagnostics");
    expect(controller).toContain("LekhCandidatePanel");
    expect(controller).toContain("handleCandidateCommand");
    expect(controller).toContain("candidateShortcutIndex");
    expect(controller).toContain("commitSelectedCandidate");
    expect(controller).toContain("refreshCandidatePanel");
    expect(controller).not.toContain("visiblePreviewText");
    expect(controller).not.toContain("modeMenuDecision");
    expect(controller).toContain("showPreferencesFromInputMenu");
    expect(controller).toContain("traditionalOptionText");
    const layoutTranslator = readFileSync(join(root, "native/macos-imk/skeleton/LekhKeyboardLayoutTranslator.swift"), "utf8");
    expect(layoutTranslator).toContain("UCKeyTranslate");
    expect(layoutTranslator).toContain("kTISPropertyUnicodeKeyLayoutData");
    expect(layoutTranslator).toContain("deliberately not a hand-written Nepali keymap");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhNativePreferences.swift"), "utf8")).toContain("Keys.inlinePreviewEnabled: true");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhNativePreferences.swift"), "utf8")).toContain("Keys.customCandidatePanelEnabled: true");
    expect(source).toContain("previewText(rawBuffer");
    expect(source).toContain("loadProofreadRows");
    expect(source).toContain("smartPunctuation(for:");
    expect(source).toContain("LekhMixedScriptPolicy.preserveCandidate");
  });

  it("renders engine-owned target-script ghost completions outside host marked text", () => {
    const controller = readFileSync(join(root, "native/macos-imk/skeleton/LekhInputController.swift"), "utf8");
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhEngineCore.swift"), "utf8");
    const candidateController = readFileSync(join(root, "native/macos-imk/skeleton/LekhCandidateController.swift"), "utf8");
    const candidatePanel = readFileSync(join(root, "native/macos-imk/skeleton/LekhCandidatePanel.swift"), "utf8");
    const inlinePreviewPanel = readFileSync(join(root, "native/macos-imk/skeleton/LekhInlinePreviewPanel.swift"), "utf8");

    const decisionBlock = source.slice(
      source.indexOf("private func decision(for rawBuffer"),
      source.indexOf("private func bestCandidate")
    );
    const selectionChangedBlock = controller.slice(
      controller.indexOf("open override func candidateSelectionChanged"),
      controller.indexOf("open override func menu()")
    );
    const candidateSelectedBlock = controller.slice(
      controller.indexOf("open override func candidateSelected"),
      controller.indexOf("open override func candidateSelectionChanged")
    );
    const modifierPassThroughBlock = controller.slice(
      controller.indexOf("if shouldPassThrough(modifiers: modifiers)"),
      controller.indexOf("if let optionText")
    );
    expect(decisionBlock).toContain("let markedText = previewText(rawBuffer: rawBuffer, candidates: candidates, mode: mode)");
    expect(decisionBlock).toContain("let inlineSuggestion = inlineSuggestion(");
    expect(decisionBlock).toContain("inlineSuggestion: inlineSuggestion");
    expect(source).toContain("private func inlineSuggestion(");
    expect(source).toContain("trimmed.hasPrefix(markedText)");
    expect(source).toContain("LekhInlineSuggestion(suffix: suffix, acceptedText: trimmed)");
    expect(controller).toContain("decision.inlineSuggestion");
    expect(controller).toContain('acceptanceHint: LekhL10n.text("inline.preview.acceptHint")');
    expect(controller).not.toContain("inlineGhostText(");
    expect(controller).toContain("private func markedTextObject(_ rawText: String)");
    expect(controller).not.toContain("ghostRange");
    expect(controller).not.toContain("NSColor.placeholderTextColor");
    expect(inlinePreviewPanel).toContain("final class LekhInlinePreviewPanel");
    expect(inlinePreviewPanel).toContain("NSPanel(");
    expect(inlinePreviewPanel).toContain("increaseContrast ? .secondaryLabelColor : .tertiaryLabelColor");
    expect(inlinePreviewPanel).toContain("let content = NSStackView");
    expect(inlinePreviewPanel).toContain("panel.ignoresMouseEvents = true");
    expect(inlinePreviewPanel).toContain("panel.canHide = false");
    expect(inlinePreviewPanel).toContain("public var isVisible: Bool");
    expect(inlinePreviewPanel).toContain("@discardableResult");
    expect(inlinePreviewPanel).toContain("announce: Bool = false");
    expect(inlinePreviewPanel).toContain("anchorRect.height * 0.72");
    expect(inlinePreviewPanel).toContain("hostFont: NSFont? = nil");
    expect(inlinePreviewPanel).toContain("hostFont?.pointSize");
    expect(inlinePreviewPanel).toContain("NSFont(descriptor: $0.fontDescriptor");
    expect(inlinePreviewPanel).toContain('LekhL10n.text("inline.preview.suggestedEnding", suffix)');
    expect(inlinePreviewPanel).toContain("public func announce(suffix: String, acceptanceHint: String)");
    expect(controller).toContain("private func scheduleInlineSuggestionAnnouncement(");
    expect(controller).toContain("DispatchQueue.main.asyncAfter(deadline: .now() + 0.35)");
    expect(controller).toContain("lastAnnouncedInlineAcceptedText != suggestion.acceptedText");
    expect(inlinePreviewPanel).toContain("let availableWidth = visible.maxX - x - 4");
    expect(inlinePreviewPanel).toContain('hint.stringValue = "⇥"');
    expect(inlinePreviewPanel).not.toContain("let x = min(max(anchorRect.maxX");
    expect(controller).toContain("cursorLocation: rawText.utf16.count");
    expect(controller).toContain("selectedRange.location - markedRange.location");
    expect(controller).toContain("candidateIndices.append(compositionLength)");
    expect(controller).toContain("private func compositionAnchor(for client: IMKTextInput?)");
    expect(controller).toContain("attributes?.values.lazy.compactMap { $0 as? NSFont }.first");
    expect(controller).toContain("hostFont: hostFont");
    expect(controller).not.toContain("attributes(forCharacterIndex: selectedRange.location");
    expect(selectionChangedBlock).toContain("candidateState.select(index: index)");
    expect(selectionChangedBlock).toContain("refreshCandidatePanel()");
    expect(selectionChangedBlock).not.toContain("setMarkedText");
    expect(selectionChangedBlock).not.toContain("visiblePreviewText");
    expect(candidateSelectedBlock).toContain("guard candidateSelectionExplicit");
    expect(candidateSelectedBlock).toContain("candidateState.currentState().candidates.contains(text)");
    expect(modifierPassThroughBlock).not.toContain("commitCurrentComposition");
    expect(controller).toContain("showModePicker()");
    expect(controller).not.toContain("apply(modeMenuDecision()");
    expect(controller).toContain("key == \" \"");
    expect(controller).toContain("key == \"\\n\"");
    expect(controller).toContain("key == \"\\t\", !modifiers.contains(.shift)");
    expect(controller).toContain("key == lekhArrowRightKey, let suggestion = visibleInlineSuggestion(for: client)");
    expect(controller).toContain("guard inlinePreviewPanel.isVisible,");
    expect(controller).toContain("commitCandidateText(suggestion.acceptedText");
    expect(candidateController).toContain("moveSelection(delta:");
    expect(candidateController).toContain("candidateForShortcut");
    expect(candidateController).toContain("public let selectedIndex: Int?");
    expect(candidateController).toContain("public func clearSelection()");
    expect(candidateController).toContain("movePage(delta:");
    expect(candidatePanel).toContain("selectedIndex:");
    expect(candidatePanel).toContain("private final class LekhCandidateRowView: NSView");
    expect(candidatePanel).toContain("container.translatesAutoresizingMaskIntoConstraints = false");
    expect(candidatePanel).toContain("controlAccentColor.withAlphaComponent");
    expect(candidatePanel).toContain("override func accessibilityPerformPress() -> Bool");
    expect(candidatePanel).toContain("accessibilityDisplayShouldReduceTransparency");
    expect(candidatePanel).toContain("accessibilityDisplayShouldIncreaseContrast");
    expect(candidatePanel).toContain("accessibilityDisplayShouldDifferentiateWithoutColor");
    expect(candidatePanel).toContain("differentiateWithoutColor");
    expect(candidatePanel).toContain('labelWithString: isSelected ? "✓" : ""');
    expect(candidatePanel).toContain("panel.canHide = false");
    expect(candidatePanel).toContain("panel.setAccessibilityRole(.window)");
    expect(candidatePanel).toContain('panel.setAccessibilityIdentifier("lekh.candidatePanel")');
    expect(candidatePanel).not.toContain("panel.setAccessibilityRole(.group)");
    expect(candidatePanel).not.toContain("NSEvent.mouseLocation");
    expect(candidatePanel).not.toContain("cursor: .pointingHand");
    expect(inlinePreviewPanel).toContain("panel.setAccessibilityElement(true)");
    expect(inlinePreviewPanel).toContain("panel.setAccessibilityRole(.window)");
    expect(inlinePreviewPanel).toContain("content.setAccessibilityHelp(acceptanceHint)");
  });

  it("uses passive, progressive candidate disclosure and route-consistent safe acceptance", () => {
    const controller = readFileSync(join(root, "native/macos-imk/skeleton/LekhInputController.swift"), "utf8");
    const candidateController = readFileSync(join(root, "native/macos-imk/skeleton/LekhCandidateController.swift"), "utf8");
    const candidatePanel = readFileSync(join(root, "native/macos-imk/skeleton/LekhCandidatePanel.swift"), "utf8");

    expect(candidateController).toContain("selectedIndex: nil");
    expect(candidateController).toContain("target = delta < 0 ? state.candidates.count - 1 : 0");
    expect(candidateController).toContain("(0..<candidateCount).contains(selectedIndex)");
    expect(controller).toContain("let candidateSurfaceIsVisible = isCurrentCandidateSurface(for: client)");
    expect(controller).toContain("let explicitShortcut = candidateSurfaceIsVisible &&");
    expect(controller).toContain("candidateSelectionExplicit || modifiers.contains(.option)");
    expect(controller).toContain("candidateState.indexForShortcut");
    expect(controller).toContain("guard candidateSelectionExplicit else");
    expect(controller).toContain("pendingInlineSuggestion");
    expect(controller).toContain("activeInlineSuggestion = ghostIsVisible ? suggestion : nil");
    expect(controller).toContain("private static let compositionSurfaceRetryDelays");
    expect(controller).toContain("Self.compositionSurfaceRetryDelays.indices.contains(attempt + 1)");
    expect(controller).toContain("private func lekhHostProbeLog(_ message: String)");
    expect(controller).toContain("surface.result ghost=");
    expect(controller).toContain("private func handleEscape(client: IMKTextInput, route: String)");
    expect(controller).toContain("private func dismissCompositionAlternatives(client: IMKTextInput)");
    expect(controller).toContain("selector == #selector(NSResponder.insertTab(_:))");
    expect(controller).toContain("selector == #selector(NSResponder.moveDown(_:))");
    expect(controller).toContain("selector == #selector(NSResponder.pageDown(_:))");
    expect(controller).toContain("open override func hidePalettes()");
    expect(controller).toContain("private struct LekhSurfaceToken: Equatable");
    expect(controller).toContain("clientIdentifier: ObjectIdentifier");
    expect(controller).toContain("private func isCurrentCandidateSurface(for client: IMKTextInput)");
    expect(controller).toContain("private func revokeCandidateAcceptance()");
    expect(controller).toContain("candidateState.clearSelection()");
    expect(controller).toContain("guard refreshCandidatePanel(announceSelection: true).isVisible else");
    expect(controller).toContain("return .visibleCustom");
    expect(controller).toContain("return .visibleSystem");
    expect(candidatePanel).toContain("return isVisible");
    expect(candidatePanel).toContain("expanded: Bool");
    expect(candidatePanel).toContain("passiveCommitText: String?");
    expect(candidatePanel).toContain('LekhL10n.text("candidate.hint.passiveAuto", passiveCommitText)');
    expect(candidatePanel).toContain("public static let passiveVisibleRows = 3");
    expect(candidatePanel).toContain("override func mouseDown(with event:");
    expect(candidatePanel).toContain("override func mouseDragged(with event:");
    expect(candidatePanel).toContain("mouseUp(with event:");
    expect(candidatePanel).toContain("let shouldCommit = isPressActive && bounds.contains(point)");
    expect(candidatePanel).toContain("onSelect?(candidateIndex, candidateText)");
    expect(candidatePanel).not.toContain("onHighlight");
    expect(controller).toContain("onSelect: { [weak self] selectedIndex, selectedText in");
    expect(candidatePanel).toContain("let minimumWidth: CGFloat = expanded ? 360 : 292");
    expect(candidatePanel).toContain("private var stableWidth: CGFloat?");
    expect(candidatePanel).toContain("lastContentSignature != contentSignature");
    expect(candidatePanel).toContain("panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: false)");
    expect(candidatePanel).toContain("if wasVisible {");
    expect(candidatePanel).toContain("panel.displayIfNeeded()");
    expect(candidateController).toContain("delta != 0");
    expect(candidateController).toContain("delta % state.candidates.count");
  });

  it("fails open through command-selector secure fields and never traps host Escape", () => {
    const controller = readFileSync(join(root, "native/macos-imk/skeleton/LekhInputController.swift"), "utf8");
    const commandBlock = controller.slice(
      controller.indexOf("open override func didCommand"),
      controller.indexOf("open override func candidates")
    );
    const escapeBlock = controller.slice(
      controller.indexOf("private func handleEscape"),
      controller.indexOf("private func dismissCompositionAlternatives")
    );
    const secureBlock = controller.slice(
      controller.indexOf("private func clearStateForSecureInput"),
      controller.indexOf("private func cancelLocalComposition")
    );

    expect(commandBlock.indexOf("if IsSecureEventInputEnabled()")).toBeLessThan(
      commandBlock.indexOf("NSResponder.cancelOperation")
    );
    expect(commandBlock).toContain("clearStateForSecureInput(client:");
    expect(commandBlock).toContain("NSResponder.insertNewlineIgnoringFieldEditor");
    expect(commandBlock).toContain("NSResponder.insertTabIgnoringFieldEditor");
    expect(commandBlock).toContain("NSResponder.deleteForward");
    expect(commandBlock).toContain("NSResponder.moveLeftAndModifySelection");
    expect(controller).toContain('guard !IsSecureEventInputEnabled() else { return "" }');
    expect(controller).toContain('return NSAttributedString(string: "")');
    expect(escapeBlock).toContain("return commitRawComposition(client: client, suffix: \"\")");
    expect(escapeBlock).not.toContain("return false");
    expect(secureBlock).toContain("let hadComposition = engineClient.hasComposition");
    expect(secureBlock).toContain("let clientOwnsComposition = isCompositionOwner(client)");
    expect(secureBlock).toContain("if hadComposition, clientOwnsComposition {");
    expect(secureBlock).not.toContain("observeCommit");
    expect(controller).toContain("private weak var compositionOwnerObject: AnyObject?");
    expect(controller).toContain("private func prepareForClientTransition(_ client: IMKTextInput)");
    expect(controller).toContain("guard mayMutateComposition(client) else { return false }");
    expect(controller).toContain('composition.abandon reason=clientTransition');
    const markedTextBlock = controller.slice(
      controller.indexOf("private func markedTextObject"),
      controller.indexOf("private func updateCandidates")
    );
    expect(markedTextBlock).not.toContain("NSFont.systemFont");
    expect(markedTextBlock).not.toContain("NSColor.labelColor");
    expect(controller).toContain("neuralCandidateService.cancelPending()");
    expect(controller).toContain("if IsSecureEventInputEnabled() {\n      neuralCandidateService.cancelPending()\n      return\n    }\n    guard nativeMode");
  });

  it("keeps the companion, input menu, and live IMK preferences coherent at word boundaries", () => {
    const controller = readFileSync(join(root, "native/macos-imk/skeleton/LekhInputController.swift"), "utf8");
    const english = readFileSync(join(root, "native/macos-imk/skeleton/Resources/en.lproj/Localizable.strings"), "utf8");
    const nepali = readFileSync(join(root, "native/macos-imk/skeleton/Resources/ne.lproj/Localizable.strings"), "utf8");

    expect(controller).toContain('lekhSharedPreferencesDomain = "com.lekh.inputmethod.LekhKeyboard"');
    expect(controller).toContain('"com.lekh.inputmethod.preferences.changed"');
    expect(controller).toContain("CFNotificationCenterGetDarwinNotifyCenter()");
    expect(controller).toContain("DispatchQueue.main.async { [weak controller] in");
    expect(controller).toContain("guard Thread.isMainThread else {");
    expect(controller).toContain("DispatchQueue.main.async { [weak self] in\n        self?.sharedPreferencesDidChange()");
    expect(controller).toContain("private func applyPendingPreferencesAtBoundary(force: Bool = false)");
    expect(controller).toContain("guard !engineClient.hasComposition(sessionId: sessionId) else { return }");
    expect(controller).toContain("applyPendingPreferencesAtBoundary()\n\n    if IsSecureEventInputEnabled()");
    expect(controller).toContain('lekhCompanionBundleIdentifier = "com.lekh.keyboard.companion"');
    expect(controller).toContain("workspace.openApplication(at: companionURL");
    expect(controller).toContain("showLegacyPreferences()");
    expect(controller).toContain("togglePrivateModeFromInputMenu");
    expect(controller).toContain("LekhNativePreferences.Keys.personalizationEnabled");
    expect(controller).toContain("private func finishCompositionBeforeModeSwitch(client: IMKTextInput?) -> Bool");
    expect(controller).toContain("return commitRawComposition(client: client, suffix: \"\")");
    expect(controller).not.toContain("modeSelectedDecision");
    expect(english).toContain('"menu.privateMode" = "Private Mode";');
    expect(nepali).toContain('"menu.privateMode" = "निजी मोड";');
  });

  it("orders delimiter acceptance as explicit choice, eligible engine authorization, then exact raw", () => {
    const controller = readFileSync(join(root, "native/macos-imk/skeleton/LekhInputController.swift"), "utf8");
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhEngineCore.swift"), "utf8");
    const commitBlock = controller.slice(
      controller.indexOf("private func commitCurrentComposition"),
      controller.indexOf("private func handleEscape")
    );
    const validationBlock = controller.slice(
      controller.indexOf("private func isValidAutoCommitCandidate"),
      controller.indexOf("private func processFailOpenKey")
    );

    expect(controller).toContain('if key == " " {\n      return commitCurrentComposition(client: client, suffix: " ")');
    expect(controller).toContain('if key == "\\n" {\n      return commitCurrentComposition(client: client, suffix: "\\n")');
    expect(commitBlock).toContain("if candidateSelectionExplicit,");
    expect(commitBlock).toContain("isCurrentCandidateSurface(for: client),");
    expect(commitBlock).toContain("let selected = candidateState.selectedCandidate()");
    expect(commitBlock).toContain("revokeCandidateAcceptance()");
    expect(commitBlock).toContain("if let autoCommitCandidate = activeAutoCommitCandidate");
    expect(commitBlock).toContain("return commitRawComposition(client: client, suffix: suffix)");
    expect(commitBlock.indexOf("candidateSelectionExplicit")).toBeLessThan(commitBlock.indexOf("activeAutoCommitCandidate"));
    expect(commitBlock.indexOf("activeAutoCommitCandidate")).toBeLessThan(commitBlock.lastIndexOf("commitRawComposition"));
    expect(controller).toContain("decision.autoCommitCandidate.flatMap");
    expect(validationBlock).toContain("candidate.sourceInput == rawBuffer");
    expect(validationBlock).toContain("probability >= 0.92 && margin >= 0.12");
    expect(validationBlock).toContain("nativeMode == .traditionalRomanized && !targetHasDevanagari");
    expect(controller).toContain("allowPersonalization: false");
    expect(controller).toContain("activeAutoCommitCandidate = nil\n      return commitRawComposition");
    expect(source).toContain("LekhNativeAutoCommitPolicy");
    expect(source).toContain("let passiveAutoCommit = autoCommitCandidate(");
    expect(source).toContain("let committedBody = passiveAutoCommit?.text ?? rawBuffer");
    expect(source).toContain("case .romanizedRomanized, .traditionalTraditional:\n      return nil");
    expect(source).toContain("isAllowedActiveTokenCandidate(input: normalized, candidate: $0, mode: mode)");
    expect(source).toContain("if !containsWhitespace(trimmedInput), containsWhitespace(trimmedCandidate)");
    expect(controller).toContain("engineClient.normalizedPunctuation(key, mode: nativeMode)");
    expect(source).toContain("func normalizedPunctuation(_ key: String, mode: LekhNativeTypingMode) -> String");
  });

  it("keeps native inline preview as the default typing experience", () => {
    const controller = readFileSync(join(root, "native/macos-imk/skeleton/LekhInputController.swift"), "utf8");

    const inlineCompositionBlock = controller.slice(
      controller.indexOf("private var usesInlineComposition"),
      controller.indexOf("public init(engineClient")
    );
    expect(inlineCompositionBlock).toContain('LEKH_IMK_INLINE_COMPOSITION');
    expect(inlineCompositionBlock).toContain("return true");
    expect(inlineCompositionBlock).not.toContain("LekhNativePreferences.inlinePreviewEnabled");
    expect(controller).toContain("applyPendingPreferencesAtBoundary(force: true)");
    expect(controller).toContain("setKeyboardLayoutOverride()");
  });

  it("loads the real runtime pack in the optimized native behavior probe", () => {
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhEngineCore.swift"), "utf8");
    const probe = readFileSync(join(root, "native/macos-imk/skeleton/Tests/LekhInputMethodBehaviorProbe/main.swift"), "utf8");

    expect(source).toContain('ProcessInfo.processInfo.processName == "LekhInputMethodBehaviorProbe"');
    expect(source).toContain('environment["LEKH_TEST_RUNTIME_SUGGESTIONS_PATH"]');
    expect(probe).toContain("decision.inlineSuggestion != nil");
    expect(probe).toContain("assertPrimaryModeEmitsSafeTargetScriptGhostCompletion");
  });

  it("ranks runtime dictionary candidates before deterministic fallback candidates", () => {
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhEngineCore.swift"), "utf8");
    const candidatesFor = source.slice(
      source.indexOf("private func candidatesFor"),
      source.indexOf("private func runtimeRows")
    );

    expect(candidatesFor.indexOf("let exactRuntime = runtimeRows(for: normalized, exactOnly: true")).toBeGreaterThan(-1);
    expect(candidatesFor.indexOf("let deterministicRuleCandidates = ruleCandidates")).toBeGreaterThan(-1);
    expect(candidatesFor.indexOf("let exactRuntime = runtimeRows(for: normalized, exactOnly: true")).toBeLessThan(
      candidatesFor.indexOf("let deterministicRuleCandidates = ruleCandidates")
    );
  });

  it("keeps native runtime candidates multi-valued and confidence-ranked", () => {
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhEngineCore.swift"), "utf8");

    expect(source).toContain("private let exactCandidates: [String: [NativeCandidateRow]]");
    expect(source).toContain("exact[row.romanized, default: []].append(row)");
    expect(source).toContain("private static func ranked(_ rows: [NativeCandidateRow]");
    expect(source).toContain("if $0.confidence != $1.confidence { return $0.confidence > $1.confidence }");
    expect(source).not.toContain("private let exactCandidates: [String: [String]]");
  });

  it("keeps Devanagari Traditional input in the native composition buffer", () => {
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhEngineCore.swift"), "utf8");

    expect(source).toContain("shouldAppendToComposition");
    expect(source).toContain("scalar.value >= 0x0900 && scalar.value <= 0x097F");
    expect(source).toContain("traditionalCandidates");
  });

  it("packages as a real macOS input method bundle with install and uninstall scripts", () => {
    const plist = readFileSync(join(root, "native/macos-imk/skeleton/Info.plist"), "utf8");
    const appMain = readFileSync(join(root, "native/macos-imk/skeleton/App/main.swift"), "utf8");
    const controller = readFileSync(join(root, "native/macos-imk/skeleton/LekhInputController.swift"), "utf8");
    const runtimeHealth = readFileSync(join(root, "native/macos-imk/skeleton/LekhRuntimeHealth.swift"), "utf8");

    expect(plist).toContain("com.lekh.inputmethod.LekhKeyboard");
    expect(plist).toContain("TISInputSourceID");
    expect(plist).toContain("TISIntendedLanguage");
    expect(plist).toContain("<string>ne</string>");
    expect(plist).not.toContain("ne-Deva");
    expect(plist).toContain("InputMethodConnectionName");
    expect(plist).toContain("com.lekh.inputmethod.LekhKeyboard_Connection");
    expect(plist).toContain("InputMethodServerControllerClass");
    expect(plist).toContain("LekhInputController");
    expect(plist).toContain("NSPrincipalClass");
    expect(plist).toContain("NSApplication");
    expect(plist).toContain("LekhDictionaryPackEd25519PublicKeyBase64");
    expect(plist).toContain("leXuq4+d5aRli02qEchU+UEo7qRbrzB1kpA21t+5nHY=");
    expect(plist).not.toContain("SUFeedURL");
    expect(plist).not.toContain("SUPublicEDKey");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/Package.swift"), "utf8")).not.toContain("Sparkle");
    expect(plist).toContain("tsInputMethodIconFileKey");
    expect(plist).toContain("tsInputMethodCharacterRepertoireKey");
    expect(plist).toContain("ComponentInputModeDict");
    expect(plist).toContain("tsInputModeListKey");
    expect(plist).toContain("smUnicodeScript");
    expect(plist).not.toContain("smDevanagari");
    expect(plist).toContain("com.lekh.inputmethod.LekhKeyboard.Main");
    expect(plist).not.toContain("com.lekh.inputmethod.LekhKeyboard.Romanized");
    expect(plist).toContain("tsVisibleInputModeOrderedArrayKey");
    expect(plist).toContain("Latn");
    expect(plist).toContain("Deva");
    expect(appMain).toContain("IMKServer");
    expect(appMain).toContain("LekhRuntimeHealth.expectedConnectionName");
    expect(runtimeHealth).toContain('expectedConnectionName = "com.lekh.inputmethod.LekhKeyboard_Connection"');
    expect(runtimeHealth).toContain("runtime-health.v1.json");
    expect(appMain).toContain("LekhRuntimeHealth.markServerStarted");
    expect(controller).toContain("LekhRuntimeHealth.markControllerInitialized()");
    expect(appMain.indexOf("server = IMKServer")).toBeLessThan(appMain.indexOf("LekhMetricReporterBootstrap.startIfOptedIn"));
    expect(appMain).not.toContain("runningApplications(withBundleIdentifier:");
    expect(existsSync(join(root, "native/macos-imk/skeleton/install-dev.sh"))).toBe(true);
    expect(existsSync(join(root, "native/macos-imk/skeleton/PkgInfo"))).toBe(true);
    expect(existsSync(join(root, "native/macos-imk/skeleton/register-dev.swift"))).toBe(true);
    expect(existsSync(join(root, "native/macos-imk/skeleton/restore-system-keyboard.swift"))).toBe(true);
    expect(existsSync(join(root, "native/macos-imk/skeleton/restore-system-keyboard.sh"))).toBe(true);
    expect(existsSync(join(root, "native/macos-imk/skeleton/uninstall-dev.sh"))).toBe(true);
    expect(existsSync(join(root, "scripts/package-macos-imk-dev.mjs"))).toBe(true);
    expect(existsSync(join(root, "scripts/check-macos-imk-dev-install.mjs"))).toBe(true);
  });

  it("keeps host-app TextEdit typing as a probe instead of a fake release gate", () => {
    const packageJson = readFileSync(join(root, "package.json"), "utf8");
    const probe = readFileSync(join(root, "scripts/check-macos-imk-host-textedit.mjs"), "utf8");
    const manualProbe = readFileSync(join(root, "native/macos-imk/skeleton/manual-host-textedit-test.sh"), "utf8");

    expect(packageJson).toContain("probe:macos-imk-host:textedit");
    expect(packageJson).not.toContain("check:macos-imk-host:textedit");
    expect(probe).toContain("blocked-automation");
    expect(probe).toContain("restoreScript");
    expect(probe).not.toContain('run("open", ["-gj", appBundle])');
    expect(manualProbe).toContain("--select-only");
    expect(manualProbe).not.toContain("pkill -x LekhInputMethodApp");
    expect(manualProbe).not.toContain('open -gj "$APP"');
  });

  it("binds ghost evidence to the exact host process, surface, text, and installed build", () => {
    const probe = readFileSync(join(root, "scripts/check-macos-imk-host-ghost.mjs"), "utf8");
    const interactionProbe = readFileSync(join(root, "scripts/check-macos-imk-host-interaction-safety.mjs"), "utf8");
    const hostHarness = readFileSync(join(root, "scripts/lib/macos-imk-host-harness.mjs"), "utf8");

    expect(probe).toContain("CGEvent.postToPid");
    expect(probe).toContain("targetedKeyPostingSource");
    expect(probe).not.toContain(".cghidEventTap");
    expect(probe).not.toContain('run("pkill"');
    expect(probe).toContain('row.identifier === "lekh.inlineCompletionPanel"');
    expect(probe).toContain('row.completionIdentifier === "lekh.inlineCompletion"');
    expect(probe).toContain('row.completionRole === "AXStaticText"');
    expect(probe).toContain('row.completionDescription.includes("हरू")');
    expect(probe).toContain('compositionText !== "लेख"');
    expect(probe).toContain('line.includes("surface.result ghost=1")');
    expect(probe).toContain('actual !== "लेखहरू"');
    expect(probe).toContain("bundleIdentity = installedBundleIdentity(appBundle)");
    expect(probe).toContain("waitForExactRuntimeHealth");
    expect(probe).toContain("productionLifecycleEvidence: true");
    expect(probe).toContain("rawABCObserved");
    expect(interactionProbe).toContain("CGEvent.postToPid");
    expect(interactionProbe).toContain("targetedPostingSource");
    expect(interactionProbe).not.toContain(".cghidEventTap");
    expect(interactionProbe).toContain("lekhInputSourceId");
    expect(interactionProbe).toContain("engineProof");
    expect(interactionProbe).toContain('"--style", "ndjson"');
    expect(interactionProbe).toContain("event.processID !== pid");
    expect(interactionProbe).toContain("timestampMs < sinceMs");
    expect(interactionProbe).toContain("surfaceDiagnosticsStartedAt");
    expect(hostHarness).toContain('export const lekhInputSourceId = "com.lekh.inputmethod.LekhKeyboard.Main"');
    expect(hostHarness).toContain('run("/usr/bin/open", ["-F", "-n", "-a", "TextEdit", realDocumentPath])');
    expect(hostHarness).toContain("processExecutablePath(record.processIdentifier)");
    expect(hostHarness).toContain("running executable SHA-256 does not match the installed bundle");
    expect(hostHarness).toContain("restoreExactInputSource");
    expect(hostHarness.match(/var selectedRange = CFRange/g)).toHaveLength(1);
    expect(hostHarness).toContain('snapshot?.operationStatus === expectedStatus');
  });

  it("does not auto-select the unfinished IMK during normal dev install", () => {
    const installScript = readFileSync(join(root, "native/macos-imk/skeleton/install-dev.sh"), "utf8");
    const registerScript = readFileSync(join(root, "native/macos-imk/skeleton/register-dev.swift"), "utf8");
    const checkScript = readFileSync(join(root, "scripts/check-macos-imk-dev-install.mjs"), "utf8");
    const hostHarness = readFileSync(join(root, "scripts/lib/macos-imk-host-harness.mjs"), "utf8");

    expect(registerScript).toContain("--select");
    expect(registerScript).toContain("--select-only");
    expect(registerScript).toContain("--disable");
    expect(registerScript).toContain("shouldSelect");
    expect(registerScript).toContain("CFBundleIdentifier");
    expect(registerScript).toContain("TISRegisterInputSource");
    expect(registerScript).toContain("TISEnableInputSource");
    expect(registerScript).not.toContain("enableSource(parent)");
    expect(registerScript).not.toContain("CFPreferencesSetAppValue");
    expect(registerScript).not.toContain('"AppleEnabledInputSources"');
    expect(registerScript).not.toContain('"AppleSelectedInputSources"');
    expect(registerScript).not.toContain('"InputSourceKind": "Keyboard Input Method"');
    expect(registerScript).not.toContain("com.apple.HIToolbox.plist");
    expect(registerScript).not.toContain("com.apple.inputsources.plist");
    expect(installScript).toContain("restore-system-keyboard.sh");
    expect(installScript).toContain("purge-lekh-input-sources.swift");
    expect(installScript).not.toContain("defaults delete");
    expect(installScript).not.toContain("codesign --force");
    expect(installScript).not.toContain("xattr -cr");
    expect(installScript).not.toContain("--noqtn");
    expect(installScript).toContain("atomic-install-swap.swift");
    expect(installScript).toContain("verify_bundle \"$APP\"");
    expect(installScript).toContain("verify_bundle \"$TMP_DEST\"");
    expect(installScript).toContain("verify_bundle \"$DEST\"");
    expect(installScript).toContain("restoring the prior input method");
    expect(installScript).toContain("stop_lekh_input_method_for_replacement");
    expect(installScript).toContain("/bin/kill -TERM");
    expect(installScript).toContain("/bin/kill -KILL");
    expect(installScript).not.toContain("pkill -x LekhInputMethodApp");
    expect(installScript).not.toContain("killall TextInputMenuAgent");
    expect(installScript).not.toContain("killall imklaunchagent");
    expect(installScript).toContain('swift "$(dirname "$0")/register-dev.swift" "$DEST"');
    expect(installScript).not.toContain('swift "$(dirname "$0")/register-dev.swift" "$DEST" --select');
    expect(checkScript).toContain('"--select-only"');
    expect(checkScript).toContain("launchColdTextEdit");
    expect(checkScript).toContain("waitForExactRuntimeHealth");
    expect(checkScript).toContain("restoreExactInputSource");
    expect(checkScript).toContain("unattributedWarningLines");
    expect(hostHarness).toContain("controllerActivatedAt");
    expect(checkScript).toContain("registryIsExact");
    expect(checkScript).not.toContain('spawn(executablePath');
    expect(checkScript).not.toContain('spawnSync("pkill"');
  });

  it("separates install registration from prompt-free host-probe selection", () => {
    const registerScript = readFileSync(join(root, "native/macos-imk/skeleton/register-dev.swift"), "utf8");
    const selectOnlyBranch = registerScript.slice(
      registerScript.indexOf("if shouldSelectOnly"),
      registerScript.indexOf("let registered = ensureInputSourceRegistered()")
    );

    expect(registerScript).toContain("let status = TISRegisterInputSource(bundleURL)");
    expect(selectOnlyBranch).toContain("selectExistingSource()");
    expect(selectOnlyBranch).not.toContain("TISRegisterInputSource");
    expect(selectOnlyBranch).not.toContain("TISEnableInputSource");
  });

  it("packages a non-destructive installer with rollback and a visible uninstaller", () => {
    const installerPackager = readFileSync(join(root, "scripts/package-macos-imk-test-installer.mjs"), "utf8");

    expect(installerPackager).toContain("Lekh Keyboard Uninstaller.app");
    expect(installerPackager).toContain("rollback()");
    expect(installerPackager).toContain("install.log");
    expect(installerPackager).toContain("uninstall.log");
    expect(installerPackager).toContain("SHA256SUMS.txt");
    expect(installerPackager).toContain("README.txt");
    expect(installerPackager).toContain("compileUniversalHelper");
    expect(installerPackager).toContain("lipo");
    expect(installerPackager).toContain("LEKH_DIALOG_MESSAGE");
    expect(installerPackager).toContain("confirm_uninstall");
    expect(installerPackager).toContain("Also remove my personal dictionary");
    expect(installerPackager).toContain("RELEASE-MANIFEST.json");
    expect(installerPackager).toContain("minisign");
    expect(installerPackager).toContain("checksumEntries");
    expect(installerPackager).toContain("Uninstaller must not embed the full keyboard payload");
    expect(installerPackager).toContain("InstallBackups");
    expect(installerPackager).toContain("rotate_backups");
    expect(installerPackager).toContain("keep_count=3");
    expect(installerPackager).toContain("restore-system-keyboard\" --snapshot");
    expect(installerPackager).toContain("stop_lekh_input_method_for_replacement");
    expect(installerPackager).toContain("stop_lekh_input_method_for_removal");
    expect(installerPackager).toContain("/bin/kill -TERM");
    expect(installerPackager).toContain("/bin/kill -KILL");
    expect(installerPackager).toContain("RUNTIME_HEALTH");
    expect(installerPackager).toContain("INSTALLED_CONNECTION_NAME");
    expect(installerPackager).not.toContain("pkill -x LekhInputMethodApp");
    expect(installerPackager).not.toContain("xattr -cr");
    expect(installerPackager).not.toContain("--noqtn");
    expect(installerPackager).not.toContain("TextInputMenuAgent");
    expect(installerPackager).not.toContain("TextInputSwitcher");
    expect(installerPackager).not.toContain("codesign --force --sign - --timestamp=none \"$DEST\"");
    expect(installerPackager).not.toContain("SystemUIServer");
    expect(installerPackager).not.toContain("defaults delete com.lekh.inputmethod.LekhKeyboard");
  });
});
