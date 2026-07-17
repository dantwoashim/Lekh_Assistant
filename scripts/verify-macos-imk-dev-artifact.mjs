#!/usr/bin/env node
import { resolve } from "node:path";
import { verifyMacOSIMKDevArtifact } from "./lib/macos-imk-dev-release-integrity.mjs";

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!flag?.startsWith("--") || value === undefined) {
    console.error("Usage: verify-macos-imk-dev-artifact.mjs --root PATH --bundle PATH --package-report PATH --report-artifact PATH");
    process.exit(2);
  }
  values.set(flag, value);
}

const required = ["--root", "--bundle", "--package-report", "--report-artifact"];
if (values.size !== required.length || required.some((flag) => !values.has(flag))) {
  console.error("Usage: verify-macos-imk-dev-artifact.mjs --root PATH --bundle PATH --package-report PATH --report-artifact PATH");
  process.exit(2);
}

const result = verifyMacOSIMKDevArtifact({
  root: resolve(values.get("--root")),
  appBundle: resolve(values.get("--bundle")),
  packageReportPath: resolve(values.get("--package-report")),
  expectedReportArtifact: resolve(values.get("--report-artifact"))
});
const output = JSON.stringify(result, null, 2);
if (result.status !== "passed") {
  console.error(output);
  process.exit(1);
}
console.log(output);
