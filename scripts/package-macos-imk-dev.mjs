#!/usr/bin/env node
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const skeletonDir = join(root, "native", "macos-imk", "skeleton");
const reportPath = join(root, "reports", "macos-imk-dev-package-report.json");
const releaseDir = join(root, "release", "native", "macos");
const appBundle = join(releaseDir, "Lekh Keyboard.imkdevbundle");
const legacyAppBundle = join(releaseDir, "Lekh Keyboard.app");
const legacyDevBundle = join(releaseDir, "Lekh Keyboard Dev.imkdevbundle");
const executableName = "LekhInputMethodApp";
const iconSource = join(root, "build", "icon.icns");
const runtimeJsonOutputPath = join(releaseDir, "runtime-suggestions.sanitized.json");
const runtimeBinaryOutputPath = join(appBundle, "Contents", "Resources", "runtime-suggestions.lkb");
const universalExecutable = join(releaseDir, `${executableName}.universal`);
const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const archs = (process.env.LEKH_MAC_ARCHS ?? "arm64,x86_64")
  .split(",")
  .map((arch) => arch.trim())
  .filter(Boolean);
const signingIdentity = process.env.LEKH_MAC_DEVELOPER_ID || "-";
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

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
mkdirSync(toolchainEnv.CLANG_MODULE_CACHE_PATH, { recursive: true });
mkdirSync(toolchainEnv.SWIFT_MODULE_CACHE_PATH, { recursive: true });
rmSync(universalExecutable, { force: true });

const swiftPrefixMapArgs = [
  "-Xswiftc",
  "-debug-prefix-map",
  "-Xswiftc",
  `${root}=.`
];

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

rmSync(appBundle, { recursive: true, force: true });
rmSync(legacyAppBundle, { recursive: true, force: true });
rmSync(legacyDevBundle, { recursive: true, force: true });
mkdirSync(join(appBundle, "Contents", "MacOS"), { recursive: true });
mkdirSync(join(appBundle, "Contents", "Resources", "en.lproj"), { recursive: true });
mkdirSync(join(appBundle, "Contents", "Resources", "ne.lproj"), { recursive: true });

copyFileSync(join(skeletonDir, "Info.plist"), join(appBundle, "Contents", "Info.plist"));
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
    join(root, "reports", "runtime-lexicon-binary-report.json")
  ]
);
const neuralModelSource = join(root, "models", "macos", "LekhNeuralTransliterator.mlmodelc");
const neuralModelPackaged = existsSync(neuralModelSource);
if (neuralModelPackaged) {
  run("copy-neural-model", "ditto", [
    "--norsrc",
    "--noextattr",
    "--noacl",
    neuralModelSource,
    join(appBundle, "Contents", "Resources", "LekhNeuralTransliterator.mlmodelc")
  ]);
}

if (existsSync(iconSource)) {
  copyFileSync(iconSource, join(appBundle, "Contents", "Resources", "Lekh.icns"));
}
writeFileSync(
  join(appBundle, "Contents", "Resources", "en.lproj", "InfoPlist.strings"),
  [
    '"CFBundleDisplayName" = "Lekh Keyboard";',
    '"CFBundleName" = "Lekh Keyboard";',
    '"com.lekh.inputmethod.LekhKeyboard.Romanized" = "Lekh Keyboard";',
    ""
  ].join("\n")
);
writeFileSync(
  join(appBundle, "Contents", "Resources", "ne.lproj", "InfoPlist.strings"),
  [
    '"CFBundleDisplayName" = "लेख";',
    '"CFBundleName" = "लेख";',
    '"com.lekh.inputmethod.LekhKeyboard.Romanized" = "लेख";',
    ""
  ].join("\n")
);

const signArgs = ["--force", "--options", "runtime", "--sign", signingIdentity];
if (signingIdentity === "-") signArgs.push("--timestamp=none");
else signArgs.push("--timestamp");
signArgs.push(appBundle);
run("codesign", "codesign", signArgs);
run("codesign-verify", "codesign", ["--verify", "--deep", "--strict", appBundle]);
spawnSync(lsregister, ["-u", "-v", appBundle], { cwd: root, encoding: "utf8", stdio: "ignore" });
sleep(500);
spawnSync(lsregister, ["-u", "-v", appBundle], { cwd: root, encoding: "utf8", stdio: "ignore" });

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
for (const requiredArch of ["arm64", "x86_64"]) {
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

finish(signingIdentity === "-" ? "passed-adhoc-release" : "passed-developer-id-ready", {
  artifact: appBundle,
  installCommand: "native/macos-imk/skeleton/install-dev.sh",
  uninstallCommand: "native/macos-imk/skeleton/uninstall-dev.sh",
  signed: signingIdentity === "-" ? "ad-hoc-hardened-runtime" : signingIdentity,
  archs: lipoInfo,
  fileInfo,
  sanitizedRuntimeJsonBytes: statSync(runtimeJsonOutputPath).size,
  runtimeBinaryBytes: statSync(runtimeBinaryOutputPath).size,
  frequencyReport: "reports/nepali-frequency-model-report.json",
  sanitizerReport: "reports/runtime-suggestions-sanitizer-report.json",
  binaryLexiconReport: "reports/runtime-lexicon-binary-report.json",
  neuralModelPackaged,
  productionSigningRequired: signingIdentity === "-"
}, 0);
