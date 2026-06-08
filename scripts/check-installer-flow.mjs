#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();

const checks = [
  {
    id: "macos-release-build",
    path: "docs/MACOS_RELEASE_BUILD.md",
    required: [
      "~/Library/Input Methods/",
      "XPC",
      "Developer ID",
      "notarization",
      "hardened runtime",
      "Uninstall",
      "privacy"
    ]
  },
  {
    id: "windows-release-build",
    path: "docs/WINDOWS_RELEASE_BUILD.md",
    required: ["MSI", "TSF", "daemon", "companion", "uninstall", "code-signing", "privacy"]
  },
  {
    id: "installer-uninstaller-checklist",
    path: "docs/INSTALLER_UNINSTALLER_CHECKLIST.md",
    required: ["Install", "Update", "Uninstall", "Required Evidence Before Release", "data preserved", "data deleted"]
  },
  {
    id: "signing-notarization",
    path: "docs/SIGNING_AND_NOTARIZATION_CHECKLIST.md",
    required: ["Windows", "macOS", "code-signing certificate", "Apple Developer ID", "notarize", "staple"]
  },
  {
    id: "release-artifacts-manifest",
    path: "docs/RELEASE_ARTIFACTS_MANIFEST.md",
    required: ["Internal Dev Build", "Windows Release Artifacts", "macOS Release Artifacts", "privacy policy", "checksum"]
  }
];

const results = checks.map((check) => {
  let text = "";
  try {
    text = readFileSync(join(root, check.path), "utf8");
  } catch (error) {
    return {
      ...check,
      ok: false,
      missing: check.required,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const lower = text.toLowerCase();
  const missing = check.required.filter((marker) => !lower.includes(marker.toLowerCase()));
  return {
    ...check,
    ok: missing.length === 0,
    missing
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  command: "npm run check:installer-flow",
  suite: "installer-flow",
  durationMs: Math.round(performance.now() - startedAt),
  status: results.every((result) => result.ok) ? "passed" : "failed",
  results,
  note:
    "This verifies the repo-executable installer/release flow. Signed Windows/macOS installer execution remains blocked until native platform environments and signing assets are available."
};

mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(join(root, "reports", "installer-flow-check.json"), `${JSON.stringify(report, null, 2)}\n`);

if (report.status !== "passed") {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: report.status,
      generatedAt: report.generatedAt,
      checked: results.length,
      report: "reports/installer-flow-check.json"
    },
    null,
    2
  )
);
