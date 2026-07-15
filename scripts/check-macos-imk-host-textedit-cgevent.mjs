#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const appBundle = join(homedir(), "Library", "Input Methods", "Lekh Keyboard.app");
const interactionScript = join(root, "scripts", "check-macos-imk-host-interaction-safety.mjs");
const interactionReportPath = join(root, "reports", "macos-imk-host-interaction-safety.json");
const reportPath = join(root, "reports", "macos-imk-host-textedit-cgevent-smoke.json");
const expected = "स्वास्थ्य ";

function finish(status, details, code) {
  mkdirSync(join(root, "reports"), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "npm run probe:macos-imk-host:textedit:cgevent",
    suite: "macos-imk-host-textedit-cgevent",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    appBundle,
    expected,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console[code === 0 ? "log" : code === 2 ? "warn" : "error"](JSON.stringify(report, null, 2));
  process.exit(code);
}

if (process.platform !== "darwin") {
  finish("failed", { failures: ["TextEdit CGEvent proof must run on macOS."] }, 1);
}
if (!existsSync(appBundle) || !existsSync(interactionScript)) {
  finish("failed", { failures: ["Installed IMK or shared TextEdit interaction harness is missing."] }, 1);
}

// Keep one authoritative focus/TIS/CGEvent implementation. The former smoke
// probe had drifted to the retired unsafe `plain 1 commits` contract and could
// report no delivery even while the release interaction harness passed. Run
// that harness fresh, then project its explicit Down+Space case into the legacy
// report consumed by older release tooling.
const child = spawnSync(process.execPath, [interactionScript], {
  cwd: root,
  encoding: "utf8",
  stdio: "pipe"
});
if (child.status !== 0) {
  let sourceReport = null;
  if (existsSync(interactionReportPath)) {
    try {
      sourceReport = JSON.parse(readFileSync(interactionReportPath, "utf8"));
    } catch {
      // Preserve the child streams below when a partial report is unreadable.
    }
  }
  const status = sourceReport?.status ?? (child.status === 2 ? "blocked-automation" : "failed");
  finish(status, {
    failures: sourceReport?.failures ?? [`Shared interaction harness exited ${child.status}.`],
    sourceStdout: child.stdout,
    sourceStderr: child.stderr,
    sourceStatus: sourceReport?.status ?? null,
    note: status === "blocked-automation"
      ? "Accessibility/Input Monitoring or host focus prevented a fresh CGEvent proof."
      : "The fresh shared interaction harness reached TextEdit but did not satisfy its behavior contract."
  }, child.status === 2 ? 2 : 1);
}
if (!existsSync(interactionReportPath)) {
  finish("failed", { failures: ["Shared interaction harness did not write its evidence report."] }, 1);
}

let interaction;
try {
  interaction = JSON.parse(readFileSync(interactionReportPath, "utf8"));
} catch (error) {
  finish("failed", { failures: [`Could not parse shared interaction report: ${error.message}`] }, 1);
}
const explicitCase = interaction.cases?.find((item) => item.id === "explicit-down-space");
if (interaction.status !== "passed" || !explicitCase?.pass || explicitCase.actual !== expected) {
  finish("failed", {
    actual: explicitCase?.actual ?? null,
    failures: ["Fresh shared interaction evidence did not prove explicit Down+Space insertion."],
    sourceStatus: interaction.status
  }, 1);
}

finish("passed", {
  actual: explicitCase.actual,
  selectionSequence: "swasthya → Down → Space",
  sourceSuite: interaction.suite,
  sourceReport: "reports/macos-imk-host-interaction-safety.json",
  note: "Fresh HID-level TextEdit evidence passed using explicit candidate browsing; passive digits remain ordinary text."
}, 0);
