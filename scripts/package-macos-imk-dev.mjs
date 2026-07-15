#!/usr/bin/env node
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const skeletonDir = join(root, "native", "macos-imk", "skeleton");
const reportPath = join(root, "reports", "macos-imk-dev-package-report.json");
const releaseDir = join(root, "release", "native", "macos");
const buildReleaseDir = process.env.LEKH_MACOS_IMK_BUILD_DIR ||
  join(homedir(), "Library", "Caches", "LekhKeyboardBuild", "native", "macos");
const buildWorkDir = join(buildReleaseDir, `.lekh-imk-package.${process.pid}`);
const appBundle = join(buildWorkDir, "Lekh Keyboard.imkdevbundle");
const publishedAppBundle = join(buildReleaseDir, "Lekh Keyboard.imkdevbundle");
const exportedAppBundle = join(releaseDir, "Lekh Keyboard.imkdevbundle");
const legacyAppBundle = join(releaseDir, "Lekh Keyboard.app");
const legacyDevBundle = join(releaseDir, "Lekh Keyboard Dev.imkdevbundle");
const executableName = "LekhInputMethodApp";
const expectedConnectionName = "com.lekh.inputmethod.LekhKeyboard_Connection";
const iconSource = join(root, "build", "icon.icns");
const legacyReleaseRuntimeJson = join(releaseDir, "runtime-suggestions.sanitized.json");
const legacyReleaseUniversalExecutable = join(releaseDir, `${executableName}.universal`);
const runtimeJsonOutputPath = join(buildWorkDir, "runtime-suggestions.sanitized.json");
const runtimeBinaryOutputPath = join(appBundle, "Contents", "Resources", "runtime-suggestions.lkb");
const runtimeJsonBundlePath = join(appBundle, "Contents", "Resources", "runtime-suggestions.json");
const engineContractBundlePath = join(appBundle, "Contents", "Resources", "lekh-engine-contract.v1.json");
const tokenCandidateSourcePath = join(root, "data", "engine", "lekh-token-candidates.v1.json");
const tokenCandidateBundlePath = join(appBundle, "Contents", "Resources", "lekh-token-candidates.v1.json");
const tokenCompletionSourcePath = join(root, "data", "completion", "runtime", "v1", "lekh-token-completions.v1.json");
const tokenCompletionManifestSourcePath = join(root, "data", "completion", "runtime", "v1", "lekh-token-completions.v1.manifest.json");
const tokenCompletionBundlePath = join(appBundle, "Contents", "Resources", "lekh-token-completions.v1.json");
const tokenCompletionManifestBundlePath = join(appBundle, "Contents", "Resources", "lekh-token-completions.v1.manifest.json");
const neuralModelSourcePath = join(root, "models", "macos", "LekhNeuralTransliterator.mlmodelc");
const neuralManifestSourcePath = join(root, "models", "macos", "LekhNeuralTransliterator.manifest.json");
const neuralVocabSourcePath = join(root, "models", "macos", "LekhNeuralTransliterator.vocab.json");
const neuralModelBundlePath = join(appBundle, "Contents", "Resources", "LekhNeuralTransliterator.mlmodelc");
const neuralManifestBundlePath = join(appBundle, "Contents", "Resources", "LekhNeuralTransliterator.manifest.json");
const neuralVocabBundlePath = join(appBundle, "Contents", "Resources", "LekhNeuralTransliterator.vocab.json");
const universalExecutable = join(buildWorkDir, `${executableName}.universal`);
const atomicInstallSwap = join(skeletonDir, "atomic-install-swap.swift");
const archs = (process.env.LEKH_MAC_ARCHS ?? "arm64,x86_64")
  .split(",")
  .map((arch) => arch.trim())
  .filter(Boolean);
const signingIdentity = process.env.LEKH_MAC_DEVELOPER_ID || "-";
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const shortVersion = process.env.LEKH_VERSION || packageVersion.match(/^\d+\.\d+\.\d+/)?.[0];
const gitCount = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const buildNumber = process.env.LEKH_BUILD_NUMBER || gitCount;
const toolchainCacheDir = join(root, ".build-cache", "macos-toolchain");
const toolchainEnv = {
  ...process.env,
  CLANG_MODULE_CACHE_PATH: join(toolchainCacheDir, "clang-module-cache"),
  SWIFT_MODULE_CACHE_PATH: join(toolchainCacheDir, "swift-module-cache")
};

function finish(status, details, exitCode) {
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        command: "npm run package:macos:imk:dev",
        suite: "macos-imk-dev-package",
        durationMs: Math.round(performance.now() - startedAt),
        status,
        ...details
      },
      null,
      2
    )}\n`
  );
  console.log(JSON.stringify({ status, report: "reports/macos-imk-dev-package-report.json", ...details }, null, 2));
  // A failed build must never leave a discoverable half-bundle. Successful
  // publication has already moved/swapped the validated bundle out of this
  // private work directory, leaving only the prior artifact (if any).
  rmSync(buildWorkDir, { recursive: true, force: true });
  process.exit(exitCode);
}

function run(step, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: toolchainEnv,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: options.maxBuffer ?? 80 * 1024 * 1024
  });
  if (result.status !== 0) {
    finish("failed", { step, command, args, stdout: result.stdout, stderr: result.stderr }, result.status ?? 1);
  }
  return result;
}

function walkPaths(path) {
  const paths = [path];
  if (!existsSync(path)) return paths;
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return paths;
  for (const entry of readdirSync(path)) {
    paths.push(...walkPaths(join(path, entry)));
  }
  return paths;
}

function stripCodeSignBlockedXattrs(path) {
  spawnSync("/usr/sbin/dot_clean", ["-m", path], {
    cwd: root,
    env: toolchainEnv,
    encoding: "utf8",
    stdio: "ignore"
  });
  spawnSync("/usr/bin/xattr", ["-cr", path], {
    cwd: root,
    env: toolchainEnv,
    encoding: "utf8",
    stdio: "ignore"
  });
  for (const currentPath of walkPaths(path).reverse()) {
    spawnSync("/usr/bin/SetFile", ["-c", "", "-t", "", currentPath], {
      cwd: root,
      env: toolchainEnv,
      encoding: "utf8",
      stdio: "ignore"
    });
    spawnSync("/usr/bin/xattr", ["-c", currentPath], {
      cwd: root,
      env: toolchainEnv,
      encoding: "utf8",
      stdio: "ignore"
    });
    for (const attribute of ["com.apple.FinderInfo", "com.apple.ResourceFork", "com.apple.fileprovider.fpfs#P", "com.apple.provenance"]) {
      spawnSync("/usr/bin/xattr", ["-d", attribute, currentPath], {
        cwd: root,
        env: toolchainEnv,
        encoding: "utf8",
        stdio: "ignore"
      });
    }
  }
}

if (process.platform !== "darwin") {
  finish("blocked-native-environment", {
    reason: "macOS IMK dev bundle must be built on macOS.",
    currentPlatform: `${process.platform}-${process.arch}`
  }, 2);
}

if (archs.length === 0) {
  finish("failed", { step: "arch-config", reason: "LEKH_MAC_ARCHS resolved to an empty architecture list." }, 1);
}

mkdirSync(releaseDir, { recursive: true });
mkdirSync(buildReleaseDir, { recursive: true });
rmSync(buildWorkDir, { recursive: true, force: true });
mkdirSync(buildWorkDir, { recursive: true });
mkdirSync(toolchainEnv.CLANG_MODULE_CACHE_PATH, { recursive: true });
mkdirSync(toolchainEnv.SWIFT_MODULE_CACHE_PATH, { recursive: true });
rmSync(universalExecutable, { force: true });
rmSync(runtimeJsonOutputPath, { force: true });
rmSync(legacyReleaseUniversalExecutable, { force: true });
rmSync(legacyReleaseRuntimeJson, { force: true });

const swiftPrefixMapArgs = [
  "-Xswiftc",
  "-debug-prefix-map",
  "-Xswiftc",
  `${root}=.`
];

run(
  "canonical-token-contract",
  process.execPath,
  [join(root, "scripts", "check-canonical-token-contract.mjs")]
);
run(
  "audit-token-completion-sources",
  process.execPath,
  [join(root, "scripts", "audit-token-completion-sources.mjs")]
);
run(
  "build-token-completion-index",
  process.execPath,
  [join(root, "scripts", "build-token-completion-index.mjs")]
);
run(
  "check-token-completion-index",
  process.execPath,
  [join(root, "scripts", "check-token-completion-index.mjs")]
);

const behaviorProbe = run(
  "native-behavior-performance-probe",
  "swift",
  ["run", "--configuration", "release", "LekhInputMethodBehaviorProbe"],
  { cwd: skeletonDir }
);
const p99Match = behaviorProbe.stdout.match(/native-deterministic-p99-ns=(\d+)/);
if (!p99Match || Number(p99Match[1]) >= 5_000_000) {
  finish("failed", {
    step: "native-behavior-performance-probe",
    reason: "Full deterministic processKey p99 must be below 5 ms.",
    stdout: behaviorProbe.stdout
  }, 1);
}
const deterministicP99Nanoseconds = Number(p99Match[1]);

const archExecutables = [];
for (const arch of archs) {
  run(
    `swift-build-${arch}`,
    "swift",
    [
      "build",
      "--configuration",
      "release",
      "--arch",
      arch,
      "--product",
      executableName,
      ...swiftPrefixMapArgs
    ],
    { cwd: skeletonDir }
  );
  const archExecutable = join(skeletonDir, ".build", `${arch}-apple-macosx`, "release", executableName);
  if (!existsSync(archExecutable)) {
    finish("failed", { step: "artifact", reason: `Missing Swift executable at ${archExecutable}` }, 1);
  }
  archExecutables.push(archExecutable);
}

if (archExecutables.length === 1) {
  copyFileSync(archExecutables[0], universalExecutable);
} else {
  run("lipo-create", "lipo", ["-create", ...archExecutables, "-output", universalExecutable]);
}
run("strip-symbols", "strip", ["-S", universalExecutable]);

rmSync(exportedAppBundle, { recursive: true, force: true });
rmSync(legacyAppBundle, { recursive: true, force: true });
rmSync(legacyDevBundle, { recursive: true, force: true });
mkdirSync(join(appBundle, "Contents", "MacOS"), { recursive: true });
mkdirSync(join(appBundle, "Contents", "Resources", "en.lproj"), { recursive: true });
mkdirSync(join(appBundle, "Contents", "Resources", "ne.lproj"), { recursive: true });
mkdirSync(join(appBundle, "Contents", "Frameworks"), { recursive: true });

copyFileSync(join(skeletonDir, "Info.plist"), join(appBundle, "Contents", "Info.plist"));
if (!shortVersion || !/^\d+\.\d+\.\d+$/.test(shortVersion) || !/^[1-9]\d*$/.test(buildNumber)) {
  finish("failed", {
    step: "version",
    reason: "LEKH_VERSION must be semantic x.y.z and LEKH_BUILD_NUMBER must be a positive integer.",
    shortVersion,
    buildNumber
  }, 1);
}
run("set-short-version", "/usr/libexec/PlistBuddy", [
  "-c",
  `Set :CFBundleShortVersionString ${shortVersion}`,
  join(appBundle, "Contents", "Info.plist")
]);
run("set-build-number", "/usr/libexec/PlistBuddy", [
  "-c",
  `Set :CFBundleVersion ${buildNumber}`,
  join(appBundle, "Contents", "Info.plist")
]);
if (process.env.LEKH_PACK_ED25519_PUBLIC_KEY_BASE64) {
  run("set-pack-public-key", "/usr/libexec/PlistBuddy", [
    "-c",
    `Set :LekhDictionaryPackEd25519PublicKeyBase64 ${process.env.LEKH_PACK_ED25519_PUBLIC_KEY_BASE64}`,
    join(appBundle, "Contents", "Info.plist")
  ]);
  run("enable-pack-updates", "/usr/libexec/PlistBuddy", [
    "-c",
    "Set :LekhDictionaryPackUpdatesEnabled true",
    join(appBundle, "Contents", "Info.plist")
  ]);
}
copyFileSync(join(skeletonDir, "PkgInfo"), join(appBundle, "Contents", "PkgInfo"));
copyFileSync(universalExecutable, join(appBundle, "Contents", "MacOS", executableName));
chmodSync(join(appBundle, "Contents", "MacOS", executableName), 0o755);

const frequencyBuild = run(
  "build-frequency-model",
  process.execPath,
  [join(root, "scripts", "build-nepali-frequency-model.mjs")]
);
const sanitize = run(
  "sanitize-runtime-suggestions",
  process.execPath,
  [
    join(root, "scripts", "sanitize-runtime-suggestions.mjs"),
    "--input",
    join(root, "src", "data", "keyboard-packs", "v0.1", "runtime-suggestions.json"),
    "--output",
    runtimeJsonOutputPath,
    "--report",
    join(root, "reports", "runtime-suggestions-sanitizer-report.json")
  ]
);
const binaryCompile = run(
  "compile-runtime-lexicon-binary",
  process.execPath,
  [
    join(root, "scripts", "compile-runtime-lexicon-binary.mjs"),
    "--input",
    runtimeJsonOutputPath,
    "--output",
    runtimeBinaryOutputPath,
    "--report",
    join(root, "reports", "runtime-lexicon-binary-report.json"),
    "--include-phrases",
    "0"
  ]
);
copyFileSync(runtimeJsonOutputPath, runtimeJsonBundlePath);
copyFileSync(
  join(root, "data", "engine", "lekh-engine-contract.v1.json"),
  engineContractBundlePath
);
copyFileSync(tokenCandidateSourcePath, tokenCandidateBundlePath);
copyFileSync(tokenCompletionSourcePath, tokenCompletionBundlePath);
copyFileSync(tokenCompletionManifestSourcePath, tokenCompletionManifestBundlePath);
// Neural fallback is deliberately absent by default. Benchmark packaging is
// opt-in so the dev bundle cannot silently ship a non-production neural tail.
const neuralPackagingRequested = process.env.LEKH_PACKAGE_NEURAL_MODEL === "1";
const experimentalNeuralTypingRequested = process.env.LEKH_EXPERIMENTAL_NEURAL_TYPING === "1";
let neuralModelPackaged = false;
if (neuralPackagingRequested) {
  const neuralPackagingFailures = [];
  if (!existsSync(neuralModelSourcePath)) neuralPackagingFailures.push("Missing models/macos/LekhNeuralTransliterator.mlmodelc.");
  if (!existsSync(neuralManifestSourcePath)) neuralPackagingFailures.push("Missing models/macos/LekhNeuralTransliterator.manifest.json.");
  if (!existsSync(neuralVocabSourcePath)) neuralPackagingFailures.push("Missing models/macos/LekhNeuralTransliterator.vocab.json.");
  if (neuralPackagingFailures.length > 0) {
    finish("failed", { step: "neural-packaging", failures: neuralPackagingFailures }, 1);
  }
  cpSync(neuralModelSourcePath, neuralModelBundlePath, { recursive: true });
  copyFileSync(neuralManifestSourcePath, neuralManifestBundlePath);
  copyFileSync(neuralVocabSourcePath, neuralVocabBundlePath);
  neuralModelPackaged = true;
}
if (experimentalNeuralTypingRequested && !neuralModelPackaged) {
  finish("failed", {
    step: "experimental-neural-typing",
    reason: "LEKH_EXPERIMENTAL_NEURAL_TYPING=1 requires LEKH_PACKAGE_NEURAL_MODEL=1."
  }, 1);
}
if (experimentalNeuralTypingRequested) {
  run("enable-experimental-neural-typing", "/usr/libexec/PlistBuddy", [
    "-c",
    "Add :LekhExperimentalNeuralTypingEnabled bool true",
    join(appBundle, "Contents", "Info.plist")
  ]);
}

if (existsSync(iconSource)) {
  copyFileSync(iconSource, join(appBundle, "Contents", "Resources", "Lekh.icns"));
}
mkdirSync(join(appBundle, "Contents", "Resources", "en.lproj"), { recursive: true });
mkdirSync(join(appBundle, "Contents", "Resources", "ne.lproj"), { recursive: true });
writeFileSync(
  join(appBundle, "Contents", "Resources", "en.lproj", "InfoPlist.strings"),
  [
    '"CFBundleDisplayName" = "Lekh Keyboard";',
    '"CFBundleName" = "Lekh Keyboard";',
    '"com.lekh.inputmethod.LekhKeyboard.Main" = "Lekh Keyboard";',
    ""
  ].join("\n")
);
for (const language of ["en", "ne"]) {
  copyFileSync(
    join(skeletonDir, "Resources", `${language}.lproj`, "Localizable.strings"),
    join(appBundle, "Contents", "Resources", `${language}.lproj`, "Localizable.strings")
  );
}
writeFileSync(
  join(appBundle, "Contents", "Resources", "ne.lproj", "InfoPlist.strings"),
  [
    '"CFBundleDisplayName" = "लेख";',
    '"CFBundleName" = "लेख";',
    '"com.lekh.inputmethod.LekhKeyboard.Main" = "लेख";',
    ""
  ].join("\n")
);

const signArgs = ["--force", "--options", "runtime", "--sign", signingIdentity];
if (signingIdentity === "-") signArgs.push("--timestamp=none");
else signArgs.push("--timestamp");
signArgs.push(appBundle);
stripCodeSignBlockedXattrs(appBundle);
run("codesign", "codesign", signArgs);
run("codesign-verify", "codesign", ["--verify", "--deep", "--strict", appBundle]);

const lipoInfo = run("lipo-archs", "lipo", ["-archs", join(appBundle, "Contents", "MacOS", executableName)]).stdout.trim();
const fileInfo = run("file-info", "file", [join(appBundle, "Contents", "MacOS", executableName)]).stdout.trim();
const strings = run("string-audit", "strings", [join(appBundle, "Contents", "MacOS", executableName)]).stdout;
const entitlementProbe = spawnSync("codesign", ["-d", "--entitlements", ":-", appBundle], {
  cwd: root,
  encoding: "utf8",
  stdio: "pipe",
  maxBuffer: 20 * 1024 * 1024
});
const entitlements = `${entitlementProbe.stdout}\n${entitlementProbe.stderr}`;

const packagingFailures = [];
const connectionNameProbe = spawnSync(
  "/usr/bin/plutil",
  ["-extract", "InputMethodConnectionName", "raw", "-o", "-", join(appBundle, "Contents", "Info.plist")],
  { cwd: root, encoding: "utf8" }
);
if (connectionNameProbe.status !== 0 || connectionNameProbe.stdout.trim() !== expectedConnectionName) {
  packagingFailures.push(
    `InputMethodConnectionName must be exactly ${expectedConnectionName}; observed ${JSON.stringify(connectionNameProbe.stdout.trim())}.`
  );
}
for (const requiredArch of archs) {
  if (!lipoInfo.split(/\s+/).includes(requiredArch)) {
    packagingFailures.push(`Missing required architecture slice: ${requiredArch}.`);
  }
}
if (strings.includes(".build/debug")) packagingFailures.push("Executable still contains .build/debug path strings.");
if (strings.includes(root)) packagingFailures.push("Executable still contains the local workspace path.");
if (entitlements.includes("com.apple.security.get-task-allow")) {
  packagingFailures.push("Signed bundle contains com.apple.security.get-task-allow entitlement.");
}
if (!existsSync(runtimeBinaryOutputPath) || statSync(runtimeBinaryOutputPath).size > 5 * 1024 * 1024) {
  packagingFailures.push("Packaged runtime binary lexicon must exist and stay under 5 MB.");
}
if (!existsSync(runtimeJsonBundlePath) || statSync(runtimeJsonBundlePath).size === 0) {
  packagingFailures.push("Packaged sanitized JSON is required for proofread rows.");
}
if (!existsSync(engineContractBundlePath) || statSync(engineContractBundlePath).size === 0) {
  packagingFailures.push("Packaged canonical engine contract is required.");
}
if (!existsSync(tokenCandidateBundlePath) || statSync(tokenCandidateBundlePath).size === 0) {
  packagingFailures.push("Packaged canonical token-candidate contract is required.");
}
if (!existsSync(tokenCompletionBundlePath) || statSync(tokenCompletionBundlePath).size === 0) {
  packagingFailures.push("Packaged verified token-completion index is required.");
}
if (!existsSync(tokenCompletionManifestBundlePath) || statSync(tokenCompletionManifestBundlePath).size === 0) {
  packagingFailures.push("Packaged token-completion manifest is required.");
}
if (strings.includes("@rpath/Sparkle.framework")) packagingFailures.push("IMK executable must not link Sparkle.framework.");

if (packagingFailures.length > 0) {
  finish("failed", {
    step: "package-gates",
    archs: lipoInfo,
    fileInfo,
    frequencyStdout: frequencyBuild.stdout,
    sanitizerStdout: sanitize.stdout,
    binaryCompilerStdout: binaryCompile.stdout,
    failures: packagingFailures
  }, 1);
}

// Publish only the fully built, signed, and gated bundle. The prior artifact
// remains continuously available while this private bundle is assembled. A
// same-volume rename swap makes the final transition atomic even when another
// process is reading the published path.
const replacingPublishedBundle = existsSync(publishedAppBundle);
if (replacingPublishedBundle) {
  run(
    "publish-bundle-atomic-swap",
    "swift",
    [atomicInstallSwap, appBundle, publishedAppBundle]
  );
} else {
  renameSync(appBundle, publishedAppBundle);
}
const publishedSignature = spawnSync(
  "codesign",
  ["--verify", "--deep", "--strict", publishedAppBundle],
  { cwd: root, env: toolchainEnv, encoding: "utf8", stdio: "pipe" }
);
if (publishedSignature.status !== 0) {
  if (replacingPublishedBundle && existsSync(appBundle)) {
    spawnSync("swift", [atomicInstallSwap, appBundle, publishedAppBundle], {
      cwd: root,
      env: toolchainEnv,
      encoding: "utf8",
      stdio: "pipe"
    });
  } else {
    rmSync(publishedAppBundle, { recursive: true, force: true });
  }
  finish("failed", {
    step: "published-codesign-verify",
    reason: "The atomically published bundle failed verification and the prior artifact was restored when available.",
    stdout: publishedSignature.stdout,
    stderr: publishedSignature.stderr
  }, publishedSignature.status ?? 1);
}
// After a successful RENAME_SWAP the old published artifact lives at the
// private staging path. Remove it only after the new public path verifies.
rmSync(appBundle, { recursive: true, force: true });
const publishedFileInfo = run(
  "published-file-info",
  "file",
  [join(publishedAppBundle, "Contents", "MacOS", executableName)]
).stdout.trim();
const publishedResources = join(publishedAppBundle, "Contents", "Resources");

finish(signingIdentity === "-" ? "passed-adhoc-release" : "passed-developer-id-ready", {
  artifact: publishedAppBundle,
  exportedArtifact: null,
  installCommand: "native/macos-imk/skeleton/install-dev.sh",
  uninstallCommand: "native/macos-imk/skeleton/uninstall-dev.sh",
  signed: signingIdentity === "-" ? "ad-hoc-hardened-runtime" : signingIdentity,
  archs: lipoInfo,
  fileInfo: publishedFileInfo,
  sanitizedRuntimeJsonBytes: statSync(runtimeJsonOutputPath).size,
  packagedRuntimeJsonBytes: statSync(join(publishedResources, "runtime-suggestions.json")).size,
  engineContractBytes: statSync(join(publishedResources, "lekh-engine-contract.v1.json")).size,
  tokenCandidateContractBytes: statSync(join(publishedResources, "lekh-token-candidates.v1.json")).size,
  tokenCompletionIndexBytes: statSync(join(publishedResources, "lekh-token-completions.v1.json")).size,
  tokenCompletionManifestBytes: statSync(join(publishedResources, "lekh-token-completions.v1.manifest.json")).size,
  packagedNeuralModelBytes: neuralModelPackaged
    ? treeBytes(join(publishedResources, "LekhNeuralTransliterator.mlmodelc"))
    : 0,
  deterministicP99Nanoseconds,
  runtimeBinaryBytes: statSync(join(publishedResources, "runtime-suggestions.lkb")).size,
  frequencyReport: "reports/nepali-frequency-model-report.json",
  sanitizerReport: "reports/runtime-suggestions-sanitizer-report.json",
  binaryLexiconReport: "reports/runtime-lexicon-binary-report.json",
  tokenCompletionAuditReport: "reports/token-completion-source-audit.json",
  tokenCompletionQualityReport: "reports/token-completion-quality-report.json",
  neuralModelPackaged,
  experimentalNeuralTypingEnabled: experimentalNeuralTypingRequested,
  shortVersion,
  buildNumber,
  productionSigningRequired: signingIdentity === "-"
}, 0);

function treeBytes(path) {
  if (!existsSync(path)) return 0;
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, entry) => total + treeBytes(join(path, entry)), 0);
}
