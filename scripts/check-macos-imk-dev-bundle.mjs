#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = process.cwd();
const startedAt = performance.now();
const stagedAppBundle = process.env.LEKH_MACOS_IMK_BUILD_DIR
  ? join(process.env.LEKH_MACOS_IMK_BUILD_DIR, "Lekh Keyboard.imkdevbundle")
  : join(homedir(), "Library", "Caches", "LekhKeyboardBuild", "native", "macos", "Lekh Keyboard.imkdevbundle");
const releaseAppBundle = join(root, "release", "native", "macos", "Lekh Keyboard.imkdevbundle");
const appBundle = existsSync(stagedAppBundle) ? stagedAppBundle : releaseAppBundle;
const plistPath = join(appBundle, "Contents", "Info.plist");
const pkgInfoPath = join(appBundle, "Contents", "PkgInfo");
const executablePath = join(appBundle, "Contents", "MacOS", "LekhInputMethodApp");
const sparkleFrameworkPath = join(appBundle, "Contents", "Frameworks", "Sparkle.framework");
const runtimeBinaryPackPath = join(appBundle, "Contents", "Resources", "runtime-suggestions.lkb");
const engineContractPath = join(appBundle, "Contents", "Resources", "lekh-engine-contract.v1.json");
const tokenCandidateContractPath = join(appBundle, "Contents", "Resources", "lekh-token-candidates.v1.json");
const tokenCompletionIndexPath = join(appBundle, "Contents", "Resources", "lekh-token-completions.v1.json");
const tokenCompletionManifestPath = join(appBundle, "Contents", "Resources", "lekh-token-completions.v1.manifest.json");
const localizedInfoPath = join(appBundle, "Contents", "Resources", "en.lproj", "InfoPlist.strings");
const nepaliLocalizedInfoPath = join(appBundle, "Contents", "Resources", "ne.lproj", "InfoPlist.strings");
const failures = [];
const expectedConnectionName = "com.lekh.inputmethod.LekhKeyboard_Connection";

if (!existsSync(appBundle)) failures.push("IMK dev app bundle is missing.");
if (!existsSync(plistPath)) failures.push("IMK Info.plist is missing.");
if (!existsSync(pkgInfoPath)) failures.push("IMK PkgInfo is missing.");
if (existsSync(pkgInfoPath) && statSync(pkgInfoPath).size !== 8) failures.push("IMK PkgInfo must be exactly 8 bytes.");
if (!existsSync(executablePath)) failures.push("IMK executable is missing.");
if (!existsSync(runtimeBinaryPackPath)) failures.push("IMK runtime binary lexicon pack is missing.");
if (!existsSync(engineContractPath)) failures.push("IMK engine contract is missing.");
if (!existsSync(tokenCandidateContractPath)) failures.push("IMK shared token-candidate contract is missing.");
if (!existsSync(tokenCompletionIndexPath)) failures.push("IMK verified token-completion index is missing.");
if (!existsSync(tokenCompletionManifestPath)) failures.push("IMK token-completion manifest is missing.");
if (!existsSync(localizedInfoPath)) failures.push("IMK localized input-mode name file is missing.");
if (!existsSync(nepaliLocalizedInfoPath)) failures.push("IMK Nepali localized input-mode name file is missing.");
if (existsSync(executablePath) && !(statSync(executablePath).mode & 0o111)) failures.push("IMK executable is not executable.");

if (existsSync(plistPath)) {
  const plist = readFileSync(plistPath, "utf8");
  for (const marker of [
    "com.lekh.inputmethod.LekhKeyboard",
    "InputMethodConnectionName",
    "com.lekh.inputmethod.LekhKeyboard_Connection",
    "InputMethodServerControllerClass",
    "LekhInputController",
    "NSPrincipalClass",
    "NSApplication",
    "tsInputMethodIconFileKey",
    "tsInputMethodCharacterRepertoireKey",
    "ComponentInputModeDict",
    "tsInputModeListKey",
    "com.lekh.inputmethod.LekhKeyboard.Main",
    "tsVisibleInputModeOrderedArrayKey",
    "Latn",
    "Deva"
  ]) {
    if (!plist.includes(marker)) failures.push(`Info.plist missing ${marker}.`);
  }
  const connectionName = spawnSync(
    "/usr/bin/plutil",
    ["-extract", "InputMethodConnectionName", "raw", "-o", "-", plistPath],
    { encoding: "utf8" }
  );
  if (connectionName.status !== 0 || connectionName.stdout.trim() !== expectedConnectionName) {
    failures.push(`Info.plist InputMethodConnectionName must equal ${expectedConnectionName} exactly.`);
  }
}

if (existsSync(runtimeBinaryPackPath)) {
  const binary = readFileSync(runtimeBinaryPackPath);
  if (binary.subarray(0, 8).toString("ascii") !== "LEKHBLX1") {
    failures.push("Runtime binary lexicon has an invalid magic header.");
  }
  if (binary.length < 64) failures.push("Runtime binary lexicon is smaller than its header.");
  if (binary.length > 6 * 1024 * 1024) failures.push("Runtime binary lexicon is too large; expected under 6 MB.");
  if (binary.length >= 64) {
    const entryCount = binary.readUInt32LE(16);
    const prefixCount = binary.readUInt32LE(28);
    const refCount = binary.readUInt32LE(40);
    if (entryCount < 10) failures.push("Runtime binary lexicon has too few entries.");
    if (prefixCount < entryCount) failures.push("Runtime binary lexicon prefix table looks incomplete.");
    if (refCount < entryCount) failures.push("Runtime binary lexicon ref table looks incomplete.");
  }
}

if (existsSync(tokenCompletionIndexPath) && existsSync(tokenCompletionManifestPath)) {
  try {
    const artifactBytes = readFileSync(tokenCompletionIndexPath);
    const artifact = JSON.parse(artifactBytes.toString("utf8"));
    const manifest = JSON.parse(readFileSync(tokenCompletionManifestPath, "utf8"));
    const digest = createHash("sha256").update(artifactBytes).digest("hex");
    const candidateCount = (artifact.entries ?? []).reduce(
      (sum, entry) => sum + (entry.candidates?.length ?? 0),
      0
    );
    if (manifest.artifact?.path !== "lekh-token-completions.v1.json") {
      failures.push("Token-completion manifest references an unexpected artifact path.");
    }
    if (manifest.artifact?.sha256 !== digest) {
      failures.push("Token-completion artifact does not match its packaged SHA-256 manifest.");
    }
    if (manifest.artifact?.bytes !== artifactBytes.length) {
      failures.push("Token-completion artifact does not match its packaged byte-count manifest.");
    }
    if (manifest.artifact?.entryCount !== artifact.entries?.length ||
        manifest.artifact?.candidateCount !== candidateCount) {
      failures.push("Token-completion artifact does not match its packaged count manifest.");
    }
    if (artifact.runtimePolicy?.explicitAcceptanceOnly !== true ||
        artifact.runtimePolicy?.singleTokenOnly !== true ||
        artifact.runtimePolicy?.namesAllowed !== false ||
        artifact.runtimePolicy?.phrasesAllowed !== false) {
      failures.push("Token-completion runtime policy is not conservative explicit-accept token-only.");
    }
    if (manifest.quality?.explicitSuggestionRuntimeEligible !== true) {
      failures.push("Token-completion manifest is not eligible for explicit runtime suggestions.");
    }
  } catch (error) {
    failures.push(`Packaged token-completion artifacts are invalid JSON: ${error.message}`);
  }
}

if (existsSync(localizedInfoPath)) {
  const localizedInfo = readFileSync(localizedInfoPath, "utf8");
  if (!localizedInfo.includes('"com.lekh.inputmethod.LekhKeyboard.Main" = "Lekh Keyboard";')) {
    failures.push("Localized transport-mode name is missing for Lekh Keyboard.");
  }
}

if (existsSync(nepaliLocalizedInfoPath)) {
  const localizedInfo = readFileSync(nepaliLocalizedInfoPath, "utf8");
  if (!localizedInfo.includes('"com.lekh.inputmethod.LekhKeyboard.Main" = "लेख";')) {
    failures.push("Nepali localized transport-mode name is missing.");
  }
}

if (existsSync(executablePath)) {
  const lipo = spawnSync("lipo", ["-archs", executablePath], { encoding: "utf8" });
  const archs = lipo.stdout.trim().split(/\s+/).filter(Boolean);
  for (const requiredArch of ["arm64", "x86_64"]) {
    if (!archs.includes(requiredArch)) failures.push(`IMK executable is missing ${requiredArch} architecture.`);
  }

  const strings = spawnSync("strings", [executablePath], {
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024
  }).stdout;
  if (strings.includes(".build/debug")) failures.push("IMK executable contains debug build path strings.");
  if (strings.includes(root)) failures.push("IMK executable leaks the local workspace path.");
  if (strings.includes("/tmp/lekh")) failures.push("IMK executable contains a /tmp Lekh logging path.");
  if (strings.includes("LekhXpcEngineClient") || strings.includes("EngineXPC")) {
    failures.push("IMK executable still contains the removed per-keystroke XPC engine path.");
  }

  const linkedLibraries = spawnSync("otool", ["-L", executablePath], { encoding: "utf8" }).stdout;
  if (linkedLibraries.includes("@rpath/Sparkle.framework")) {
    failures.push("IMK executable must not link Sparkle.framework; updater code belongs outside the input-method server.");
  }
  if (existsSync(sparkleFrameworkPath)) {
    failures.push("IMK bundle must not embed Sparkle.framework; updater code belongs outside the input-method server.");
  }

  const entitlements = spawnSync("codesign", ["-d", "--entitlements", ":-", appBundle], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
  const entitlementText = `${entitlements.stdout}\n${entitlements.stderr}`;
  if (entitlementText.includes("com.apple.security.get-task-allow")) {
    failures.push("IMK bundle contains com.apple.security.get-task-allow entitlement.");
  }

  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", appBundle], { encoding: "utf8" });
  if (verify.status !== 0) failures.push(`IMK bundle code signature does not verify: ${verify.stderr || verify.stdout}`);
}

const report = {
  generatedAt: new Date().toISOString(),
  command: "npm run check:macos-imk-bundle",
  suite: "macos-imk-dev-bundle",
  durationMs: Math.round(performance.now() - startedAt),
  status: failures.length === 0 ? "passed" : "failed",
  appBundle,
  failures
};

mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(join(root, "reports", "macos-imk-dev-bundle-check.json"), `${JSON.stringify(report, null, 2)}\n`);

if (failures.length > 0) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: "passed", report: "reports/macos-imk-dev-bundle-check.json", appBundle }, null, 2));
