#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = process.cwd();
const startedAt = performance.now();
const sourceDir = join(ROOT, "native", "macos-imk", "skeleton");
const reportPath = join(ROOT, "reports", "native-imk-privacy-security-report.json");
const swiftFiles = collectFiles(sourceDir).filter((file) => file.endsWith(".swift"));
const violations = [];
const requiredMarkers = [
  ["LekhInputController.swift", "IsSecureEventInputEnabled"],
  ["LekhInputController.swift", "shouldPassThrough(modifiers:"],
  ["LekhXpcClient.swift", "Data(contentsOf: url, options: [.mappedIfSafe])"],
  ["LekhDictionaryPackVerifier.swift", "Ed25519"],
  ["LekhMetricReporter.swift", "LekhMetricKitOptIn"],
  ["LekhDiagnostics.swift", "text and keystroke values are not recorded"]
];

for (const file of swiftFiles) {
  const source = readFileSync(file, "utf8");
  for (const pattern of [
    /\bURLSession\b/,
    /\bNSURLConnection\b/,
    /\bCFNetwork\b/,
    /\bNWConnection\b/,
    /https?:\/\//
  ]) {
    if (pattern.test(source)) {
      violations.push(`${relative(ROOT, file)}: forbidden network primitive or URL marker ${pattern}`);
    }
  }
  if (/lekhNativeLog\([^)]*key=\\\(/s.test(source) || /lekhNativeLog\([^)]*string=\\\(/s.test(source)) {
    violations.push(`${relative(ROOT, file)}: diagnostic log appears to include raw key/string value`);
  }
  for (const forbidden of ["LekhXpcEngineClient", "EngineXPC", "makeProcessKeyStrokeRequest", "session.processKeyStroke"]) {
    if (source.includes(forbidden)) {
      violations.push(`${relative(ROOT, file)}: forbidden per-keystroke XPC marker ${forbidden}`);
    }
  }
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
