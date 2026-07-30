import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectContainedDirectoryTree
} from "./neural-artifact-filesystem.mjs";
import {
  inspectNeuralRuntimeTraceProvenance,
  isNeuralRuntimeTraceProvenance,
  matchNeuralRuntimeTraceProvenance
} from "./neural-runtime-trace-provenance.mjs";

describe("Neural Engine raw-trace provenance", () => {
  it("reopens, hashes, freezes, and brands exact contained artifacts", () => {
    withFixture(({ root }) => {
      const fixture = writeTraceFixture(root);
      const provenance = inspectFixture(root, fixture);

      expect(isNeuralRuntimeTraceProvenance(provenance)).toBe(true);
      expect(Object.isFrozen(provenance)).toBe(true);
      expect(Object.isFrozen(provenance.trace)).toBe(true);
      expect(provenance.trace).toMatchObject({
        relativePath: "evidence/session.trace",
        sha256: fixture.traceSha256
      });
      expect(provenance.traceExport).toMatchObject({
        relativePath: "evidence/session.xml",
        sha256: fixture.traceExportSha256,
        encoding: "UTF-8",
        unsafeDeclarationsRejected: true
      });
      expect(provenance.semanticDerivation).toEqual({
        status: "unavailable",
        requirement:
          "versioned-real-xctrace-coreml-neural-engine-export-fixture"
      });
    });
  });

  it("does not let serialization or hand-authored fields forge the brand", () => {
    withFixture(({ root }) => {
      const fixture = writeTraceFixture(root);
      const provenance = inspectFixture(root, fixture);
      const clone = JSON.parse(JSON.stringify(provenance));

      expect(isNeuralRuntimeTraceProvenance(clone)).toBe(false);
      expect(matchNeuralRuntimeTraceProvenance(clone, fixture)).toEqual({
        valid: false,
        issueCode: "neural-runtime-placement.provenance-unverified"
      });
      clone.semanticDerivation.status = "verified";
      expect(matchNeuralRuntimeTraceProvenance(clone, fixture).valid)
        .toBe(false);
    });
  });

  it("binds the brand to both exact recomputed hashes", () => {
    withFixture(({ root }) => {
      const fixture = writeTraceFixture(root);
      const provenance = inspectFixture(root, fixture);

      expect(matchNeuralRuntimeTraceProvenance(
        provenance,
        fixture
      )).toEqual({
        valid: false,
        issueCode:
          "neural-runtime-placement.semantic-correlation-unverified"
      });
      expect(matchNeuralRuntimeTraceProvenance(provenance, {
        ...fixture,
        traceExportSha256: "f".repeat(64)
      })).toEqual({
        valid: false,
        issueCode: "neural-runtime-placement.provenance-hash-mismatch"
      });
    });
  });

  it("rejects trace or export bytes that drift from the expected hashes", () => {
    withFixture(({ root }) => {
      const fixture = writeTraceFixture(root);
      write(
        join(fixture.traceDirectory, "Metadata", "run.plist"),
        "tampered"
      );
      expect(() => inspectFixture(root, fixture)).toThrow(
        /Raw xctrace directory SHA-256 does not match/u
      );
    });
    withFixture(({ root }) => {
      const fixture = writeTraceFixture(root);
      write(fixture.traceExport, xml("<tampered/>"));
      expect(() => inspectFixture(root, fixture)).toThrow(
        /XML export SHA-256 does not match/u
      );
    });
  });

  it("rejects paths outside the repository and misleading suffixes", () => {
    withFixture(({ root, outside }) => {
      const fixture = writeTraceFixture(root);
      const outsideTrace = join(outside, "outside.trace");
      write(join(outsideTrace, "data.bin"), "outside");
      expect(() => inspectNeuralRuntimeTraceProvenance({
        repoRoot: root,
        traceDirectory: outsideTrace,
        traceExport: fixture.traceExport,
        expectedTraceSha256: fixture.traceSha256,
        expectedTraceExportSha256: fixture.traceExportSha256
      })).toThrow(/escapes the repository root/u);

      expect(() => inspectNeuralRuntimeTraceProvenance({
        repoRoot: root,
        traceDirectory: fixture.traceDirectory.replace(/\.trace$/u, ""),
        traceExport: fixture.traceExport,
        expectedTraceSha256: fixture.traceSha256,
        expectedTraceExportSha256: fixture.traceExportSha256
      })).toThrow(/must be a \.trace directory/u);
    });
  });

  it("rejects symlinked trace leaves, descendants, parents, and exports", () => {
    withFixture(({ root, outside }) => {
      const fixture = writeTraceFixture(root);
      const externalTrace = join(outside, "external.trace");
      write(join(externalTrace, "data.bin"), "outside");
      const linkedTrace = join(root, "evidence", "linked.trace");
      symlinkSync(externalTrace, linkedTrace);
      expect(() => inspectNeuralRuntimeTraceProvenance({
        repoRoot: root,
        traceDirectory: linkedTrace,
        traceExport: fixture.traceExport,
        expectedTraceSha256: fixture.traceSha256,
        expectedTraceExportSha256: fixture.traceExportSha256
      })).toThrow(/symbolic link/u);
    });
    withFixture(({ root, outside }) => {
      const fixture = writeTraceFixture(root);
      const external = join(outside, "external.bin");
      write(external, "outside");
      symlinkSync(
        external,
        join(fixture.traceDirectory, "linked.bin")
      );
      expect(() => inspectFixture(root, fixture)).toThrow(
        /contains a symbolic link/u
      );
    });
    withFixture(({ root }) => {
      const fixture = writeTraceFixture(root);
      const alias = join(root, "trace-alias");
      symlinkSync(dirname(fixture.traceDirectory), alias);
      expect(() => inspectNeuralRuntimeTraceProvenance({
        repoRoot: root,
        traceDirectory: join(alias, "session.trace"),
        traceExport: fixture.traceExport,
        expectedTraceSha256: fixture.traceSha256,
        expectedTraceExportSha256: fixture.traceExportSha256
      })).toThrow(/symbolic-link path component/u);
    });
    withFixture(({ root }) => {
      const fixture = writeTraceFixture(root);
      const realExport = join(root, "evidence", "real-export.xml");
      write(realExport, xml("<trace-query-result/>"));
      const linkedExport = join(root, "evidence", "linked-export.xml");
      symlinkSync(realExport, linkedExport);
      expect(() => inspectNeuralRuntimeTraceProvenance({
        repoRoot: root,
        traceDirectory: fixture.traceDirectory,
        traceExport: linkedExport,
        expectedTraceSha256: fixture.traceSha256,
        expectedTraceExportSha256: sha256(
          Buffer.from(xml("<trace-query-result/>"))
        )
      })).toThrow(/must not be a symbolic link/u);
    });
  });

  for (const [label, contents, message] of [
    [
      "invalid UTF-8",
      Buffer.from([0xff, 0xfe, 0xfd]),
      /not strict UTF-8/u
    ],
    [
      "DOCTYPE",
      Buffer.from(xml(
        "<!DOCTYPE trace SYSTEM \"file:///etc/passwd\">" +
        "<trace-query-result/>"
      )),
      /must not contain DOCTYPE or ENTITY/u
    ],
    [
      "ENTITY",
      Buffer.from(xml(
        "<!ENTITY secret SYSTEM \"file:///etc/passwd\">" +
        "<trace-query-result/>"
      )),
      /must not contain DOCTYPE or ENTITY/u
    ],
    [
      "invalid XML controls",
      Buffer.from(xml("<trace-query-result>\u0000</trace-query-result>")),
      /no invalid XML characters/u
    ],
    [
      "missing XML declaration",
      Buffer.from("<trace-query-result/>"),
      /UTF-8-compatible XML declaration/u
    ],
    [
      "missing document element",
      Buffer.from(xml("<!-- only a comment -->")),
      /no recognizable document element/u
    ]
  ]) {
    it(`rejects ${label}`, () => {
      withFixture(({ root }) => {
        const fixture = writeTraceFixture(root, contents);
        expect(() => inspectFixture(root, fixture)).toThrow(message);
      });
    });
  }

  it("enforces explicit byte and entry bounds", () => {
    withFixture(({ root }) => {
      const fixture = writeTraceFixture(root);
      expect(() => inspectFixture(root, fixture, {
        maxTraceBytes: 1
      })).toThrow(/verification limit/u);
      expect(() => inspectFixture(root, fixture, {
        maxTraceEntries: 1
      })).toThrow(/entry count/u);
      expect(() => inspectFixture(root, fixture, {
        maxExportBytes: 1
      })).toThrow(/verification limit/u);
    });
  });
});

function withFixture(callback) {
  const parent = mkdtempSync(join(tmpdir(), "lekh-neural-trace-"));
  const root = join(parent, "repo");
  const outside = join(parent, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  try {
    callback({ root, outside });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function writeTraceFixture(
  root,
  exportContents = Buffer.from(xml("<trace-query-result/>"))
) {
  const traceDirectory = join(root, "evidence", "session.trace");
  const traceExport = join(root, "evidence", "session.xml");
  write(join(traceDirectory, "Metadata", "run.plist"), "metadata");
  write(join(traceDirectory, "Data", "events.bin"), "events");
  write(traceExport, exportContents);
  const traceSha256 = inspectContainedDirectoryTree(
    root,
    traceDirectory
  ).sha256;
  return {
    traceDirectory,
    traceExport,
    traceSha256,
    traceExportSha256: sha256(exportContents)
  };
}

function inspectFixture(root, fixture, limits) {
  return inspectNeuralRuntimeTraceProvenance({
    repoRoot: root,
    traceDirectory: fixture.traceDirectory,
    traceExport: fixture.traceExport,
    expectedTraceSha256: fixture.traceSha256,
    expectedTraceExportSha256: fixture.traceExportSha256,
    limits
  });
}

function xml(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>${body}`;
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
