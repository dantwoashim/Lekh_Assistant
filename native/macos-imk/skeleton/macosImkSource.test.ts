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
    expect(source).toContain("casualTailOverrides");
    expect(source).toContain("composePhraseCandidates");
    expect(source).toContain("xaina");
    expect(source).toContain("बाटो");
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
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhInputController.swift"), "utf8")).toContain("requestAsyncNeuralCandidates");
    expect(source).toContain("neural=async-coreml-tail-gated");
    expect(packageScript).toContain("LEKH_PACKAGE_NEURAL_MODEL");
    expect(packageScript).toContain("neuralPackagingRequested");
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
    expect(controller).toContain("modePromptPending");
    expect(controller).not.toContain("modePrompt.activate");
    expect(controller).not.toContain("showTutorialIfNeeded");
    expect(controller).toContain("menu() -> NSMenu!");
    expect(controller).toContain("selectModeFromInputMenu");
    expect(controller).toContain("menu.forgetCandidate");
    expect(controller).toContain("forgetCurrentCandidateFromInputMenu");
    expect(controller).toContain("engineClient.observeCommit");
    expect(controller).toContain("engineClient.forgetCandidate");
    expect(controller).toContain("modeFromMenuKey");
    expect(controller).toContain("modeHotkey");
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

  it("renders target-script marked text and suffix-only same-script ghost candidates", () => {
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
    const modifierPassThroughBlock = controller.slice(
      controller.indexOf("if shouldPassThrough(modifiers: modifiers)"),
      controller.indexOf("if let optionText")
    );
    expect(decisionBlock).toContain("let markedText = previewText(rawBuffer: rawBuffer, candidates: candidates, mode: mode)");
    expect(source).toContain("case .romanizedTraditional, .traditionalRomanized:");
    expect(source).toContain("return candidates.first ?? rawBuffer");
    expect(controller).toContain("inlineGhostText(rawText: markedText, candidates: decision.candidates)");
    expect(controller).toContain("inlinePreviewPanel.show(suffix: ghost");
    expect(controller).toContain("private func markedTextObject(_ rawText: String)");
    expect(controller).toContain("trimmed.hasPrefix(raw)");
    expect(controller).not.toContain("ghostRange");
    expect(controller).not.toContain("NSColor.placeholderTextColor");
    expect(inlinePreviewPanel).toContain("final class LekhInlinePreviewPanel");
    expect(inlinePreviewPanel).toContain("NSPanel(");
    expect(inlinePreviewPanel).toContain("label.textColor = .placeholderTextColor");
    expect(inlinePreviewPanel).toContain("panel.ignoresMouseEvents = true");
    expect(controller).toContain("cursorLocation: rawText.utf16.count");
    expect(selectionChangedBlock).toContain("candidateState.select(index: index)");
    expect(selectionChangedBlock).toContain("refreshCandidatePanel()");
    expect(selectionChangedBlock).not.toContain("setMarkedText");
    expect(selectionChangedBlock).not.toContain("visiblePreviewText");
    expect(modifierPassThroughBlock).not.toContain("commitCurrentComposition");
    expect(controller).toContain("showModePicker()");
    expect(controller).not.toContain("apply(modeMenuDecision()");
    expect(controller).toContain("key == \" \"");
    expect(controller).toContain("key == \"\\n\"");
    expect(controller).toContain("key == \"\\t\", !modifiers.contains(.shift)");
    expect(candidateController).toContain("moveSelection(delta:");
    expect(candidateController).toContain("candidateForShortcut");
    expect(candidatePanel).toContain("selectedIndex:");
    expect(candidatePanel).toContain("private final class LekhCandidateRowView: NSView");
    expect(candidatePanel).toContain("container.translatesAutoresizingMaskIntoConstraints = false");
    expect(candidatePanel).toContain("controlAccentColor.withAlphaComponent");
  });

  it("keeps Space safe and requires explicit candidate acceptance", () => {
    const controller = readFileSync(join(root, "native/macos-imk/skeleton/LekhInputController.swift"), "utf8");
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhEngineCore.swift"), "utf8");

    expect(controller).toContain("if candidateSelectionExplicit {\n        return commitSelectedCandidate(client: client, suffix: \" \")");
    expect(controller).toContain("return commitRawComposition(client: client, suffix: \" \")");
    expect(controller).toContain("if candidateSelectionExplicit, let selected = candidateState.selectedCandidate()");
    expect(source).toContain("committedText: rawBuffer.isEmpty ? \" \" : \"\\(rawBuffer) \"");
    expect(source).toContain("isAllowedActiveTokenCandidate(input: normalized, candidate: $0)");
    expect(source).toContain("if trimmedCandidate.contains(\" \") { return false }");
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
    expect(controller).toContain("configureModeFromDefaults()\n    setKeyboardLayoutOverride()");
  });

  it("ranks runtime dictionary candidates before deterministic fallback candidates", () => {
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhEngineCore.swift"), "utf8");
    const candidatesFor = source.slice(
      source.indexOf("private func candidatesFor"),
      source.indexOf("private func runtimeRows")
    );

    expect(candidatesFor.indexOf("runtimeRows(for: normalized, exactOnly: false")).toBeGreaterThan(-1);
    expect(candidatesFor.indexOf("let deterministicRuleCandidates = ruleCandidates")).toBeGreaterThan(-1);
    expect(candidatesFor.indexOf("runtimeRows(for: normalized, exactOnly: false")).toBeLessThan(
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
    expect(plist).toContain("LekhInputMethodApplication");
    expect(plist).toContain("LekhDictionaryPackEd25519PublicKeyBase64");
    expect(plist).toContain("leXuq4+d5aRli02qEchU+UEo7qRbrzB1kpA21t+5nHY=");
    expect(plist).not.toContain("SUFeedURL");
    expect(plist).not.toContain("SUPublicEDKey");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/Package.swift"), "utf8")).not.toContain("Sparkle");
    expect(plist).toContain("tsInputMethodIconFileKey");
    expect(plist).toContain("tsInputMethodCharacterRepertoireKey");
    expect(plist).toContain("ComponentInputModeDict");
    expect(plist).toContain("tsInputModeListKey");
    expect(plist).toContain("com.lekh.inputmethod.LekhKeyboard.Main");
    expect(plist).not.toContain("com.lekh.inputmethod.LekhKeyboard.Romanized");
    expect(plist).toContain("tsVisibleInputModeOrderedArrayKey");
    expect(plist).toContain("Latn");
    expect(plist).toContain("Deva");
    expect(appMain).toContain("IMKServer");
    expect(appMain).toContain("com.lekh.inputmethod.LekhKeyboard_Connection");
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

    expect(packageJson).toContain("probe:macos-imk-host:textedit");
    expect(packageJson).not.toContain("check:macos-imk-host:textedit");
    expect(probe).toContain("blocked-automation");
    expect(probe).toContain("restoreScript");
  });

  it("does not auto-select the unfinished IMK during normal dev install", () => {
    const installScript = readFileSync(join(root, "native/macos-imk/skeleton/install-dev.sh"), "utf8");
    const registerScript = readFileSync(join(root, "native/macos-imk/skeleton/register-dev.swift"), "utf8");
    const checkScript = readFileSync(join(root, "scripts/check-macos-imk-dev-install.mjs"), "utf8");

    expect(registerScript).toContain("--select");
    expect(registerScript).toContain("--disable");
    expect(registerScript).toContain("shouldSelect");
    expect(registerScript).toContain("CFBundleIdentifier");
    expect(registerScript).toContain("TISRegisterInputSource");
    expect(registerScript).toContain("TISEnableInputSource");
    expect(registerScript).not.toContain("enableSource(parent)");
    expect(registerScript).not.toContain("CFPreferencesSetAppValue");
    expect(registerScript).not.toContain("AppleEnabledInputSources");
    expect(registerScript).not.toContain("AppleSelectedInputSources");
    expect(registerScript).not.toContain('"InputSourceKind": "Keyboard Input Method"');
    expect(registerScript).not.toContain("com.apple.HIToolbox.plist");
    expect(registerScript).not.toContain("com.apple.inputsources.plist");
    expect(installScript).not.toContain("restore-system-keyboard.sh");
    expect(installScript).not.toContain("purge-lekh-input-sources.swift");
    expect(installScript).not.toContain("defaults delete");
    expect(installScript).not.toContain("codesign --force");
    expect(installScript).not.toContain("xattr -cr");
    expect(installScript).not.toContain("--noqtn");
    expect(installScript).toContain("atomic-install-swap.swift");
    expect(installScript).toContain('swift "$(dirname "$0")/register-dev.swift" "$DEST"');
    expect(installScript).not.toContain('swift "$(dirname "$0")/register-dev.swift" "$DEST" --select');
    expect(checkScript).toContain("unsafe until host-app typing is proven");
  });

  it("keeps registration idempotent once the Lekh input source already exists", () => {
    const registerScript = readFileSync(join(root, "native/macos-imk/skeleton/register-dev.swift"), "utf8");
    const existingBranch = registerScript.slice(
      registerScript.indexOf("if let existing = findInputSource"),
      registerScript.indexOf("let status = TISRegisterInputSource")
    );

    expect(existingBranch).toContain("return (existing");
    expect(existingBranch).not.toContain("TISRegisterInputSource");
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
    expect(installerPackager).not.toContain("xattr -cr");
    expect(installerPackager).not.toContain("--noqtn");
    expect(installerPackager).not.toContain("TextInputMenuAgent");
    expect(installerPackager).not.toContain("TextInputSwitcher");
    expect(installerPackager).not.toContain("codesign --force --sign - --timestamp=none \"$DEST\"");
    expect(installerPackager).not.toContain("SystemUIServer");
    expect(installerPackager).not.toContain("defaults delete com.lekh.inputmethod.LekhKeyboard");
  });
});
