import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";

const checker = join(
  process.cwd(),
  "scripts",
  "check-neural-production-promotion.mjs"
);

describe("production promotion receipt guard", () => {
  it("keeps development usable when no promotion has occurred", () => {
    withFixture((root) => {
      const reportPath = join(root, "reports", "dev.json");
      const result = run(root, "--report", reportPath);
      const report = readJson(reportPath);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(report.status, "passed-phase9-promotion-guard");
      assert.equal(report.verification, null);
      assert.ok(report.warnings.some((value) =>
        /No promoted neural directory/u.test(value)
      ));
    });
  });

  it("fails closed when production has no canonical atomic receipt", () => {
    withFixture((root) => {
      const reportPath = join(root, "reports", "production.json");
      const result = run(root, "--production", "--report", reportPath);
      const report = readJson(reportPath);
      assert.equal(result.status, 1);
      assert.equal(report.status, "failed-production-phase9-promotion");
      assert.ok(report.failures.some((value) =>
        /promoted neural directory is missing/u.test(value)
      ));
    });
  });

  it("forbids substituting another directory in production mode", () => {
    withFixture((root) => {
      const alternate = join(root, "models", "macos", "alternate");
      mkdirSync(alternate, { recursive: true });
      const reportPath = join(root, "reports", "override.json");
      const result = run(
        root,
        "--production",
        "--production-dir",
        alternate,
        "--report",
        reportPath
      );
      const report = readJson(reportPath);
      assert.equal(result.status, 1);
      assert.ok(report.failures.some((value) =>
        /forbids --production-dir/u.test(value)
      ));
    });
  });
});

function withFixture(callback) {
  const parent = mkdtempSync(join(tmpdir(), "lekh-promotion-check-"));
  const rootAlias = join(parent, "repo");
  mkdirSync(rootAlias, { recursive: true });
  const root = realpathSync(rootAlias);
  try {
    callback(root);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function run(root, ...args) {
  return spawnSync(process.execPath, [checker, ...args], {
    cwd: root,
    encoding: "utf8"
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
