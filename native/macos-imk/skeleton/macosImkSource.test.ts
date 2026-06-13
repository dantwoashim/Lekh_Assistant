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
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhXpcClient.swift"), "utf8");
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
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhXpcClient.swift"), "utf8");
    const packageScript = readFileSync(join(root, "scripts/package-macos-imk-dev.mjs"), "utf8");

    expect(controller).not.toContain("LEKH_IMK_USE_XPC");
    expect(controller).not.toContain("/tmp/lekh");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhDiagnostics.swift"), "utf8")).toContain("LEKH_IMK_DIAGNOSTICS");
    expect(controller).toContain("LekhDiagnosticsPolicy.diagnosticsEnabled(secureInputActive: IsSecureEventInputEnabled())");
    expect(controller).toContain("menu.dictionaryWarning");
    expect(controller).toContain("LekhStaticProofEngineClient");
    expect(packageScript).toContain("runtime-suggestions.json");
    expect(packageScript).toContain("runtime-suggestions.lkb");
    expect(packageScript).toContain("--configuration");
    expect(packageScript).toContain("release");
    expect(packageScript).toContain("lipo");
    expect(packageScript).toContain("sanitize-runtime-suggestions");
    expect(packageScript).toContain("compile-runtime-lexicon-binary");
    expect(source).toContain("Data(contentsOf: url, options: [.mappedIfSafe])");
    expect(source).toContain("withExtension: \"lkb\"");
    expect(source).toContain("withExtension: \"json\"");
    expect(source).toContain("RuntimeSuggestionPack");
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
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhNeuralTransliterator.swift"), "utf8")).toContain("CoreML");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhMetricReporter.swift"), "utf8")).toContain("LekhMetricKitOptIn");
    expect(source).toContain("lekh-keyboard.sqlite3");
    expect(source).toContain("CREATE TABLE IF NOT EXISTS user_lexicon");
    expect(source).toContain("userLexicon.record");
    expect(source).toContain("userLexicon.candidates");
    expect(source).toContain("composeToken");
    expect(source).toContain("ruleCandidates(for:");
    expect(source).toContain("genericConjunctPairs");
    expect(source).toContain("swasthya");
    expect(source).toContain("स्वास्थ्य");
    expect(source).toContain("nagarikta pr");
    expect(source).toContain("नागरिकता प्रमाणपत्र");
  });

  it("contains native mode switching for all four typing surfaces", () => {
    const controller = readFileSync(join(root, "native/macos-imk/skeleton/LekhInputController.swift"), "utf8");
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhXpcClient.swift"), "utf8");

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
    expect(controller).toContain("engineClient.learnCommit");
    expect(controller).toContain("engineClient.forgetCandidate");
    expect(controller).toContain("modeFromMenuKey");
    expect(controller).toContain("modeHotkey");
    expect(controller).toContain("LekhNativeTypingModeChosen");
    expect(controller).toContain("modifiers.contains(.control), modifiers.contains(.option), keyCode == 49");
    expect(controller).toContain("inputText(_ string: String!, key keyCode: Int, modifiers flags: Int, client sender: Any!)");
    expect(controller).toContain("event.inputTextKey");
    expect(controller).toContain("TISSetInputMethodKeyboardLayoutOverride");
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
    expect(controller).toContain("visiblePreviewText");
    expect(controller).toContain("LekhCandidatePanel");
    expect(controller).toContain("showPreferencesFromInputMenu");
    expect(controller).toContain("traditionalOptionText");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhNativePreferences.swift"), "utf8")).toContain("Keys.inlinePreviewEnabled: false");
    expect(readFileSync(join(root, "native/macos-imk/skeleton/LekhNativePreferences.swift"), "utf8")).toContain("Keys.customCandidatePanelEnabled: false");
    expect(source).toContain("previewText(rawBuffer");
    expect(source).toContain("loadProofreadRows");
    expect(source).toContain("smartPunctuation(for:");
    expect(source).toContain("LekhMixedScriptPolicy.preserveCandidate");
  });

  it("keeps native runtime candidates multi-valued and confidence-ranked", () => {
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhXpcClient.swift"), "utf8");

    expect(source).toContain("private let exactCandidates: [String: [NativeCandidateRow]]");
    expect(source).toContain("exact[row.romanized, default: []].append(row)");
    expect(source).toContain("private static func ranked(_ rows: [NativeCandidateRow]");
    expect(source).toContain("if $0.confidence != $1.confidence { return $0.confidence > $1.confidence }");
    expect(source).not.toContain("private let exactCandidates: [String: [String]]");
  });

  it("keeps Devanagari Traditional input in the native composition buffer", () => {
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhXpcClient.swift"), "utf8");

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
    expect(registerScript).not.toContain("com.apple.HIToolbox.plist");
    expect(registerScript).not.toContain("com.apple.inputsources.plist");
    expect(installScript).not.toContain("restore-system-keyboard.sh");
    expect(installScript).not.toContain("purge-lekh-input-sources.swift");
    expect(installScript).not.toContain("defaults delete");
    expect(installScript).not.toContain("codesign --force");
    expect(installScript).not.toContain("xattr -cr");
    expect(installScript).not.toContain("--noqtn");
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
