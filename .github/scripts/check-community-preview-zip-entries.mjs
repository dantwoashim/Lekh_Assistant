#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { validateArchiveEntryNames } from "./community-preview-integrity.mjs";

function parseExpectedRoot(argv) {
  if (argv.length !== 2 || argv[0] !== "--expected-root" || !argv[1]) {
    throw new Error(
      "Usage: unzip -Z1 ARTIFACT.zip | check-community-preview-zip-entries.mjs --expected-root NAME"
    );
  }
  return argv[1];
}

try {
  const expectedRoot = parseExpectedRoot(process.argv.slice(2));
  const input = await readFile(0, "utf8");
  const entries = input.endsWith("\n") ? input.slice(0, -1).split("\n") : input.split("\n");
  const result = validateArchiveEntryNames(entries, expectedRoot);
  process.stdout.write(`${JSON.stringify({ status: "passed", expectedRoot, ...result })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
