import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const model = readFileSync("native/macos-companion/LekhCompanionModel.swift", "utf8");
const app = readFileSync("native/macos-companion/LekhCompanionApp.swift", "utf8");
const copy = readFileSync("native/macos-companion/LekhCompanionCopy.swift", "utf8");
const packager = readFileSync("scripts/package-native-macos-companion.mjs", "utf8");
const packageJson = readFileSync("package.json", "utf8");

describe("native macOS companion", () => {
  it("reads real TIS installation and selection state", () => {
    expect(model).toContain("TISCreateInputSourceList");
    expect(model).toContain("inputSources(includeAllInstalled: true)");
    expect(model).toContain("inputSources(includeAllInstalled: false)");
    expect(model).toContain("TISCopyCurrentKeyboardInputSource");
    expect(model).toContain("kTISPropertyInputSourceIsEnabled");
    expect(model).toContain("LekhNeuralTransliterator.manifest.json");
    expect(model).toContain('manifest?["productionEligible"] as? Bool == true');
    expect(app).toContain("experimentalLocalFallback");
  });

  it("uses readiness as the sole lifecycle authority for UI facts and actions", () => {
    expect(model).toContain("var installed: Bool { readiness.installed }");
    expect(model).toContain("var registered: Bool { readiness.registered }");
    expect(model).toContain("var enabled: Bool { readiness.enabled }");
    expect(model).toContain("var selected: Bool { readiness.selected }");
    expect(model).toContain("var running: Bool { readiness.running }");
    expect(model).toContain("var primaryAction: KeyboardPrimaryAction { readiness.primaryAction }");
    expect(model).not.toContain("var installed = false");
    expect(model).not.toContain("var enabled = false");
    expect(model).not.toContain("var selected = false");
    expect(app).toContain("model.performPrimaryAction()");
    expect(app).toContain("model.status.recoveryPlan");
    expect(app).not.toContain("if !model.status.installed");
    expect(app).not.toContain("else if model.status.installed");
  });

  const swiftModelTest = process.platform === "darwin" ? it : it.skip;
  swiftModelTest("passes the authoritative Swift lifecycle truth table", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "lekh-companion-state-tests-"));
    const executable = join(temporaryDirectory, "LekhCompanionStateTests");
    const architecture = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim();
    try {
      execFileSync("xcrun", [
        "swiftc",
        "-parse-as-library",
        "-target", `${architecture}-apple-macos13`,
        "-framework", "AppKit",
        "-framework", "Carbon",
        "-framework", "Security",
        "-framework", "UniformTypeIdentifiers",
        "-lsqlite3",
        "native/macos-companion/LekhCompanionModel.swift",
        "native/macos-companion/LekhCompanionCopy.swift",
        "native/macos-companion/Tests/LekhCompanionStateTests.swift",
        "-o", executable
      ], { cwd: process.cwd(), stdio: "pipe" });
      const output = execFileSync(executable, [], { encoding: "utf8" });
      expect(output).toContain("authoritative lifecycle truth table");
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("serializes HIToolbox input-source reads on the main actor", () => {
    expect(model).toContain("private struct InputSourceSnapshot: Sendable");
    expect(model).toContain("let inputSourceSnapshot = Self.readInputSourceSnapshot()");
    expect(model).toContain("Self.readNativeStatus(inputSources: inputSourceSnapshot)");
    expect(model).toContain("private static func inputSources(includeAllInstalled: Bool)");
    expect(model).not.toContain("nonisolated private static func inputSources()");
    expect(model).not.toContain("nonisolated private static func stringProperty(");
    expect(model).not.toContain("nonisolated private static func boolProperty(");
    expect(model).not.toContain("status: Self.readNativeStatus(),");
  });

  it("shares preferences without entering the typing hot path", () => {
    expect(model).toContain('UserDefaults(suiteName: Self.inputMethodBundleIdentifier)');
    expect(model).toContain("CFNotificationCenterGetDarwinNotifyCenter");
    expect(model).not.toContain("URLSession");
  });

  it("offers application-specific learning exclusions enforced by the IMK preference domain", () => {
    expect(model).toContain("LekhExcludedApplicationBundleIdentifiers");
    expect(model).toContain("NSOpenPanel");
    expect(app).toContain("chooseExcludedApplications");
    expect(app).toContain("ExcludedApplicationRow");
  });

  it("clears personalization off the main thread and reports transaction failure", () => {
    expect(model).toContain("Task.detached(priority: .userInitiated)");
    expect(model).toContain('sqlite3_exec(database, "BEGIN IMMEDIATE"');
    expect(model).toContain('sqlite3_exec(database, "ROLLBACK"');
    expect(model).toContain("learningClearFailed");
  });

  it("uses system-native navigation, controls and accessibility state", () => {
    expect(app).toContain("NavigationSplitView");
    expect(app).toContain(".toggleStyle(.switch)");
    expect(app).toContain("accessibilityReduceTransparency");
    expect(app).toContain("accessibilityReduceMotion");
    expect(app).toContain("ScrollViewReader");
    expect(app).toContain('scrollProxy.scrollTo("lekh-companion-detail-top", anchor: .top)');
    expect(app).toContain("@State private var selectedSection");
    expect(app).toContain("LekhCompanionSection");
    expect(model).not.toContain("@Published var selectedSection");
  });

  it("keeps ghost education truthful across readiness, preference and all four modes", () => {
    expect(app).toContain("guard model.preferences.inlinePreviewEnabled else");
    expect(app).toContain("case .selectedUntested:");
    expect(app).toContain("case .degraded:");
    expect(app).toContain("case .romanizedNepali, .traditionalNepali:");
    expect(app).toContain("case .romanizedRomanized, .traditionalRomanized:");
    expect(app).toContain('accessibilityIdentifier("ghost-preview-status")');
    expect(copy).toContain("Illustration only · verify it in TextEdit");
    expect(copy).toContain("nothing is inserted until you accept it");
  });

  it("shows only assistance controls that affect the selected mode", () => {
    expect(app).toContain("private var showsProofreading: Bool");
    expect(app).toContain("private var showsNepaliPunctuation: Bool");
    expect(app).toContain("if showsProofreading");
    expect(app).toContain("if showsNepaliPunctuation");
    expect(copy).toContain("Nepali punctuation does not change Roman output");
  });

  it("localizes learned-entry plurality and accessible state language", () => {
    expect(copy).toContain('count == 1 ? "1 local entry" : "\\(count) local entries"');
    expect(app).toContain("accessibilityState: setupState(model.status.installed)");
    expect(app).toContain("model.status.buildVerification == .mismatched");
    expect(copy).toContain("setupNeedsAttention");
    expect(app).toContain("shortcutAccessibility(keys:");
    expect(app).not.toContain('accessibilityValue(complete ? "Complete" : "Incomplete")');
  });

  it("shows distinct setup, runtime-build and state-dependent recovery evidence", () => {
    expect(app).toContain('accessibilityIdentifier("authoritative-setup-progress")');
    expect(app).toContain('accessibilityIdentifier("keyboard-primary-action")');
    expect(app).toContain('accessibilityIdentifier("keyboard-recovery-guide")');
    expect(app).toContain("model.status.registered");
    expect(app).toContain("model.status.running");
    expect(app).toContain("buildVerificationLabel");
    expect(copy).toContain("The input source is registered, but macOS reports it disabled.");
    expect(copy).toContain("The live input-method process belongs to a different build");
    expect(copy).toContain("Replace the stale build");
  });

  it("registers safely and verifies the exact installed and running bundle", () => {
    expect(model).toContain("TISRegisterInputSource(Self.installedBundleURL as CFURL)");
    expect(model).toContain("validatedInstalledBundle()");
    expect(model).toContain("bundle.bundleIdentifier == inputMethodBundleIdentifier");
    expect(model).toContain("modeList[inputSourceIdentifier] != nil");
    expect(model).toContain("processExecutablePath(health.processIdentifier)");
    expect(model).toContain("processCodeDirectoryHash(health.processIdentifier) == installedCodeDirectoryHash");
    expect(model).toContain("health.processIdentifier > 0");
    expect(model).toContain("controllerActivatedAt >= controllerInitializedAt");
    expect(copy).toContain("registrationBundleInvalid");
  });

  it("preserves recovery order and settings localization for assistive technology", () => {
    expect(app).toContain("model.copy.recoveryStep(");
    expect(copy).toContain('"Step \\(index) of \\(total). \\(text)"');
    expect(app).toContain("Button(model.copy.settingsCommand)");
    expect(app).not.toContain('Button("Lekh Keyboard Settings…")');
  });

  it("adapts privacy cards and contrast without relying on color alone", () => {
    expect(app).toContain("LazyVGrid(");
    expect(app).toContain("GridItem(.adaptive(minimum: 210)");
    expect(app).toContain("@Environment(\\.colorSchemeContrast)");
    expect(app).toContain('accessibilityIdentifier("privacy-trust-grid")');
  });

  it("packages a universal least-privilege app without Electron", () => {
    expect(packager).toContain('for (const arch of ["arm64", "x86_64"])');
    expect(packager).toContain("public.app-category.utilities");
    expect(packager).not.toContain("electron-builder");
    expect(packager).toContain("presentForbiddenUsageKeys");
    expect(packageJson).toContain('"package:macos": "node scripts/package-native-macos-companion.mjs --signed"');
    expect(packageJson).toContain('"check:macos-companion-package": "node scripts/check-native-macos-companion.mjs"');
  });
});
