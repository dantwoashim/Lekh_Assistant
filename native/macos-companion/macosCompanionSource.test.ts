import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const model = readFileSync("native/macos-companion/LekhCompanionModel.swift", "utf8");
const app = readFileSync("native/macos-companion/LekhCompanionApp.swift", "utf8");
const copy = readFileSync("native/macos-companion/LekhCompanionCopy.swift", "utf8");
const packager = readFileSync("scripts/package-native-macos-companion.mjs", "utf8");
const packageJson = readFileSync("package.json", "utf8");

describe("native macOS companion", () => {
  it("reads real TIS installation and selection state", () => {
    expect(model).toContain("TISCreateInputSourceList");
    expect(model).toContain("TISCopyCurrentKeyboardInputSource");
    expect(model).toContain("kTISPropertyInputSourceIsEnabled");
    expect(model).toContain("LekhNeuralTransliterator.manifest.json");
    expect(model).toContain('manifest?["productionEligible"] as? Bool == true');
    expect(app).toContain("experimentalLocalFallback");
  });

  it("serializes HIToolbox input-source reads on the main actor", () => {
    expect(model).toContain("private struct InputSourceSnapshot: Sendable");
    expect(model).toContain("let inputSourceSnapshot = Self.readInputSourceSnapshot()");
    expect(model).toContain("Self.readNativeStatus(inputSources: inputSourceSnapshot)");
    expect(model).toContain("private static func inputSources()");
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
    expect(model).toContain("LekhCompanionSection");
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
    expect(app).toContain("accessibilityState: model.status.installed ? model.copy.setupComplete : model.copy.setupIncomplete");
    expect(app).toContain("shortcutAccessibility(keys:");
    expect(app).not.toContain('accessibilityValue(complete ? "Complete" : "Incomplete")');
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
