import { linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  artifactInventoriesMatch,
  isStrictDescendant,
  hasReleaseAliasInPath,
  discoverPortableExecutables,
  hasPortableExecutableMagic,
  normalizeSha256Fingerprint,
  readPortableExecutableIdentity,
  releaseTreeContainsAlias,
  signerInventoryMatches,
  windowsFileAttributesContainReparsePoint,
} from "./windows-release-evidence.mjs";

describe("Windows release evidence", () => {
  it("detects any final release-inventory mutation or duplicate identity", () => {
    const original = [
      {
        path: "release/Setup.exe",
        bytes: 4,
        sha256: "AA".repeat(32),
        modifiedAt: "2026-07-18T00:00:00.000Z",
        machine: "x64",
      },
      {
        path: "release/win-unpacked/Companion.exe",
        bytes: 8,
        sha256: "BB".repeat(32),
        modifiedAt: "2026-07-18T00:00:01.000Z",
        machine: "x64",
      },
    ];
    expect(artifactInventoriesMatch(original, [...original].reverse())).toBe(true);
    expect(
      artifactInventoriesMatch(original, [
        original[0],
        { ...original[1], sha256: "CC".repeat(32) },
      ]),
    ).toBe(false);
    expect(artifactInventoriesMatch(original, [original[0], original[0]])).toBe(false);
  });

  it("uses separator-independent strict release containment", () => {
    const release = "C:\\repo\\release";
    expect(
      isStrictDescendant(release, `${release}\\Setup.exe`, path.win32),
    ).toBe(true);
    expect(isStrictDescendant(release, release, path.win32)).toBe(false);
    expect(
      isStrictDescendant(release, "C:\\repo\\release-evil\\Setup.exe", path.win32),
    ).toBe(false);
    expect(
      isStrictDescendant(release, `${release}\\..\\outside.exe`, path.win32),
    ).toBe(false);
  });

  it("rejects a trusted signature made by the wrong publisher", () => {
    const expected = "AA".repeat(32);
    const artifact = "release/Lekh-Keyboard-Companion-1.0.0-Setup-x64.exe";
    expect(normalizeSha256Fingerprint(expected.toLowerCase())).toBe(expected);
    expect(
      signerInventoryMatches(
        [
          {
            artifact,
            verified: true,
            signerMatchesExpected: false,
            signerSha256: "BB".repeat(32),
          },
        ],
        expected,
        [artifact],
      ),
    ).toBe(false);
    expect(
      signerInventoryMatches(
        [
          {
            artifact,
            verified: true,
            signerMatchesExpected: true,
            signerSha256: expected,
          },
        ],
        expected,
        [artifact],
      ),
    ).toBe(true);
  });

  it("rejects malformed or ambiguously separated certificate pins", () => {
    const fingerprint = "AB".repeat(32);
    expect(normalizeSha256Fingerprint(`ZZ${fingerprint}`)).toBeNull();
    expect(normalizeSha256Fingerprint(`${fingerprint}ZZ`)).toBeNull();
    expect(normalizeSha256Fingerprint(` ${fingerprint}`)).toBeNull();
    expect(normalizeSha256Fingerprint(`${fingerprint} `)).toBeNull();
    expect(
      normalizeSha256Fingerprint(
        Array.from({ length: 32 }, (_, index) =>
          index === 1 ? "AB " : index < 31 ? "AB:" : "AB",
        ).join(""),
      ),
    ).toBeNull();
    expect(
      normalizeSha256Fingerprint(Array(32).fill("AB").join(":")),
    ).toBe(fingerprint);
  });

  it("recognizes the Windows reparse-point attribute without flagging ordinary files", () => {
    expect(windowsFileAttributesContainReparsePoint(0x400)).toBe(true);
    expect(windowsFileAttributesContainReparsePoint(0x410)).toBe(true);
    expect(windowsFileAttributesContainReparsePoint(0x20)).toBe(false);
    expect(windowsFileAttributesContainReparsePoint("1024")).toBe(false);
  });

  it("discovers structurally valid PE payloads by file magic and records machine identity", () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "lekh-release-evidence-"));
    try {
      const release = path.join(temporary, "win-unpacked");
      const nested = path.join(release, "resources");
      mkdirSync(nested, { recursive: true });
      const executable = path.join(release, "Companion.exe");
      const renamed = path.join(nested, "native.payload");
      const data = path.join(release, "ordinary-data.json");
      writeFileSync(executable, minimalPe("x64"));
      writeFileSync(renamed, minimalPe("x86"));
      writeFileSync(data, "ordinary data");
      expect(hasPortableExecutableMagic(executable)).toBe(true);
      expect(hasPortableExecutableMagic(data)).toBe(false);
      expect(readPortableExecutableIdentity(executable).machineName).toBe("x64");
      expect(readPortableExecutableIdentity(renamed).machineName).toBe("x86");
      expect(discoverPortableExecutables(release)).toEqual(
        [executable, renamed].sort((left, right) => left.localeCompare(right)),
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it.each([
    ["truncated MZ", Buffer.from([0x4d, 0x5a, 0x00])],
    ["missing PE signature", minimalPe("x64", { validSignature: false })],
    ["unsupported machine", minimalPe("x64", { machine: 0x01c4 })],
    ["mismatched optional header", minimalPe("x64", { optionalHeaderMagic: 0x010b })],
  ])("rejects a malformed executable payload: %s", (_label, payload) => {
    const temporary = mkdtempSync(path.join(tmpdir(), "lekh-release-evidence-"));
    try {
      const release = path.join(temporary, "win-unpacked");
      mkdirSync(release, { recursive: true });
      writeFileSync(path.join(release, "payload.exe"), payload);
      expect(() => discoverPortableExecutables(release)).toThrow("Portable executable");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects an artifact reached through a symlinked release node",
    () => {
      const temporary = mkdtempSync(path.join(tmpdir(), "lekh-release-evidence-"));
      try {
        const release = path.join(temporary, "release");
        const outside = path.join(temporary, "outside");
        mkdirSync(release);
        mkdirSync(outside);
        writeFileSync(path.join(outside, "Setup.exe"), "test");
        symlinkSync(outside, path.join(release, "linked"), "dir");
        expect(
          hasReleaseAliasInPath(
            release,
            path.join(release, "linked", "Setup.exe"),
          ),
        ).toBe(true);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects aliases anywhere in the unpacked release tree, including non-executable payloads",
    () => {
      const temporary = mkdtempSync(path.join(tmpdir(), "lekh-release-evidence-"));
      try {
        const release = path.join(temporary, "win-unpacked");
        const outside = path.join(temporary, "outside");
        mkdirSync(path.join(release, "resources"), { recursive: true });
        mkdirSync(outside);
        writeFileSync(path.join(outside, "mutable.json"), "test");
        symlinkSync(outside, path.join(release, "resources", "aliased-data"), "dir");
        expect(releaseTreeContainsAlias(release)).toBe(true);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  );

  it("accepts an ordinary closed release tree", () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "lekh-release-evidence-"));
    try {
      const release = path.join(temporary, "win-unpacked");
      mkdirSync(path.join(release, "resources"), { recursive: true });
      writeFileSync(path.join(release, "resources", "data.json"), "test");
      expect(releaseTreeContainsAlias(release)).toBe(false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("rejects a release artifact with another hard-link name", () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "lekh-release-evidence-"));
    try {
      const release = path.join(temporary, "release");
      mkdirSync(release);
      const artifact = path.join(release, "Setup.exe");
      writeFileSync(artifact, "test");
      linkSync(artifact, path.join(temporary, "mutable-alias.exe"));
      expect(hasReleaseAliasInPath(release, artifact)).toBe(true);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("rejects a hard-linked non-executable anywhere in the unpacked tree", () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "lekh-release-evidence-"));
    try {
      const release = path.join(temporary, "win-unpacked");
      const resources = path.join(release, "resources");
      mkdirSync(resources, { recursive: true });
      const payload = path.join(resources, "runtime.json");
      writeFileSync(payload, "test");
      linkSync(payload, path.join(temporary, "mutable-runtime.json"));
      expect(releaseTreeContainsAlias(release)).toBe(true);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

function minimalPe(
  architecture: "x86" | "x64",
  overrides: {
    machine?: number;
    optionalHeaderMagic?: number;
    validSignature?: boolean;
  } = {},
) {
  const machine = overrides.machine ?? (architecture === "x86" ? 0x014c : 0x8664);
  const optionalHeaderBytes = architecture === "x86" ? 0x00e0 : 0x00f0;
  const image = Buffer.alloc(64 + 24 + optionalHeaderBytes);
  image.write("MZ", 0, "ascii");
  image.writeUInt32LE(64, 0x3c);
  if (overrides.validSignature !== false) image.write("PE\0\0", 64, "binary");
  image.writeUInt16LE(machine, 68);
  image.writeUInt16LE(1, 70);
  image.writeUInt16LE(optionalHeaderBytes, 84);
  image.writeUInt16LE(0x0002, 86);
  image.writeUInt16LE(
    overrides.optionalHeaderMagic ?? (architecture === "x86" ? 0x010b : 0x020b),
    88,
  );
  return image;
}
