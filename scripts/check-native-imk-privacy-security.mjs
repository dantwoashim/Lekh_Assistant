#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = process.cwd();
const startedAt = performance.now();
const sourceDir = join(ROOT, "native", "macos-imk", "skeleton");
const reportPath = join(ROOT, "reports", "native-imk-privacy-security-report.json");
const swiftFiles = collectFiles(sourceDir).filter((file) => file.endsWith(".swift"));
const generatedProtocolFile = join(sourceDir, "LekhIPCProtocol.generated.swift");
const violations = [];
const requiredMarkers = [
  ["LekhInputController.swift", "IsSecureEventInputEnabled"],
  ["LekhInputController.swift", "LekhDiagnosticsPolicy.diagnosticsEnabled(secureInputActive: IsSecureEventInputEnabled())"],
  ["LekhInputController.swift", "menu.dictionaryWarning"],
  ["LekhInputController.swift", "shouldPassThrough(modifiers:"],
  ["LekhInputController.swift", "LekhCandidatePanel"],
  ["LekhInputController.swift", "showPreferencesFromInputMenu"],
  ["LekhEngineCore.swift", "Data(contentsOf: url, options: [.mappedIfSafe])"],
  ["LekhEngineCore.swift", "securityWarning()"],
  ["LekhEngineCore.swift", "loadProofreadRows"],
  ["LekhEngineCore.swift", "smartPunctuation(for:"],
  ["LekhCandidatePanel.swift", "NSPanel"],
  ["LekhPreferencesWindow.swift", "LekhPersonalDictionaryMaintenance"],
  ["LekhPreferencesWindow.swift", "diagnostics.privacy"],
  ["LekhNativePreferences.swift", "LekhMixedScriptPolicy"],
  ["LekhDictionaryPackVerifier.swift", "Ed25519"],
  ["LekhDictionaryPackVerifier.swift", "LEKH_PACK_V2"],
  ["LekhDictionaryPackVerifier.swift", "installedPackStatus"],
  ["LekhMetricReporter.swift", "LekhMetricKitOptIn"],
  ["LekhDiagnostics.swift", "text and keystroke values are not recorded"],
  ["LekhDiagnostics.swift", "ttlSeconds: TimeInterval = 24 * 60 * 60"]
];

for (const file of swiftFiles) {
  const source = readFileSync(file, "utf8");
  const relativeFile = relative(ROOT, file);
  for (const pattern of [
    /\bURLSession\b/,
    /\bNSURLConnection\b/,
    /\bCFNetwork\b/,
    /\bNWConnection\b/,
    /https?:\/\//
  ]) {
    if (relativeFile.endsWith("Package.swift") && pattern.source === "https?:\\/\\/") continue;
    if (pattern.test(source)) {
      violations.push(`${relative(ROOT, file)}: forbidden network primitive or URL marker ${pattern}`);
    }
  }
  if (/lekhNativeLog\([^)]*key=\\\(/s.test(source) || /lekhNativeLog\([^)]*string=\\\(/s.test(source)) {
    violations.push(`${relative(ROOT, file)}: diagnostic log appears to include raw key/string value`);
  }
  if (/lekhNativeLog\([^)]*keyCode=/s.test(source) || source.includes("keyCode=")) {
    violations.push(`${relative(ROOT, file)}: diagnostic log must not include physical key codes`);
  }
  for (const forbidden of ["LekhXpcEngineClient", "EngineXPC", "makeProcessKeyStrokeRequest", "session.processKeyStroke"]) {
    // The generated cross-platform protocol inventory names every wire method.
    // A method identifier is data, not evidence that the IMK transports keys
    // over XPC; every other Swift occurrence remains forbidden.
    if (forbidden === "session.processKeyStroke" && file === generatedProtocolFile) continue;
    if (source.includes(forbidden)) {
      violations.push(`${relative(ROOT, file)}: forbidden per-keystroke XPC marker ${forbidden}`);
    }
  }
  if (file.endsWith("LekhNeuralTransliterator.swift") && source.includes("fileExists(atPath: activeModelURL.path)")) {
    violations.push(`${relative(ROOT, file)}: unsigned user-writable Core ML model loading is forbidden`);
  }
}

for (const policyFile of [
  join(sourceDir, "register-dev.swift"),
  join(sourceDir, "purge-lekh-input-sources.swift"),
  join(sourceDir, "restore-system-keyboard.swift"),
  join(sourceDir, "install-dev.sh"),
  join(ROOT, "scripts", "package-macos-imk-test-installer.mjs")
]) {
  if (!existsSync(policyFile)) continue;
  const source = readFileSync(policyFile, "utf8");
  for (const forbidden of [
    "--noqtn",
    "TextInputMenuAgent",
    "TextInputSwitcher",
    "com.apple.HIToolbox",
    "com.apple.inputsources",
    "CFPreferencesSetAppValue",
    "AppleEnabledInputSources",
    "AppleSelectedInputSources",
    "AppleEnabledThirdPartyInputSources",
    "AppleInputSourceHistory"
  ]) {
    if (source.includes(forbidden)) {
      violations.push(`${relative(ROOT, policyFile)}: forbidden installer/input-source marker ${forbidden}`);
    }
  }
}

const purgeSource = readFileSync(join(sourceDir, "purge-lekh-input-sources.swift"), "utf8");
if (purgeSource.includes("kTISPropertyLocalizedName") || purgeSource.includes("localizedCaseInsensitiveContains")) {
  violations.push("native/macos-imk/skeleton/purge-lekh-input-sources.swift: cleanup must match the owned input-source identifier namespace, never a localized display name");
}

for (const [fileName, marker] of requiredMarkers) {
  const path = join(sourceDir, fileName);
  const source = readFileSync(path, "utf8");
  if (!source.includes(marker)) {
    violations.push(`${relative(ROOT, path)}: missing required marker ${marker}`);
  }
}

const report = {
  status: violations.length === 0 ? "passed" : "failed",
  checkedFiles: swiftFiles.map((file) => relative(ROOT, file)),
  violations,
  policy: {
    noNetworkInIMK: true,
    noRawTextDiagnostics: true,
    secureInputPassThrough: true,
    signedDictionaryPacks: true,
    noPerKeystrokeXpc: true
  }
};

finish(report.status, report, violations.length === 0 ? 0 : 1);

function collectFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    if ([".build", ".swiftpm"].includes(entry)) return [];
    const path = join(directory, entry);
    const stat = statSync(path);
    return stat.isDirectory() ? collectFiles(path) : [path];
  });
}

function finish(status, details, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-native-imk-privacy-security.mjs",
    suite: "native-imk-privacy-security",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(ROOT, reportPath), violations }, null, 2));
  process.exit(exitCode);
}
