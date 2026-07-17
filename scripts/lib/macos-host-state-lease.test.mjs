import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireMacOSHostStateLease,
  assertMacOSHostStateLeaseDescriptor,
  macOSHostStateLeasePath,
  releaseMacOSHostStateLease
} from "./macos-host-state-lease.mjs";

const roots = [];
const leases = [];
const lockHelperPath = resolve("scripts/macos-companion-publication-lock.swift");

afterEach(() => {
  for (const lease of leases.splice(0)) {
    try { releaseMacOSHostStateLease(lease); } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin")("macOS host-state mutation lease", () => {
  it("serializes unrelated probes on one inherited user-scoped flock", () => {
    const homeDirectory = mkdtempSync(join(tmpdir(), "lekh-host-state-lease-"));
    roots.push(homeDirectory);
    const first = acquireMacOSHostStateLease({
      homeDirectory,
      lockHelperPath,
      waitMilliseconds: 0
    });
    leases.push(first);
    expect(assertMacOSHostStateLeaseDescriptor(first.descriptor, first.path)).toBe(true);
    expect(first.path).toBe(macOSHostStateLeasePath({ homeDirectory }));
    expect(statSync(first.path).mode & 0o777).toBe(0o600);

    let contention = null;
    try {
      acquireMacOSHostStateLease({
        homeDirectory,
        lockHelperPath,
        waitMilliseconds: 100
      });
    } catch (error) {
      contention = error;
    }
    expect(contention?.code).toBe("macos-host-state-lease-busy");

    expect(releaseMacOSHostStateLease(first)).toBe(true);
    leases.splice(leases.indexOf(first), 1);
    const successor = acquireMacOSHostStateLease({
      homeDirectory,
      lockHelperPath,
      waitMilliseconds: 100
    });
    leases.push(successor);
    expect(assertMacOSHostStateLeaseDescriptor(successor.descriptor, successor.path)).toBe(true);
  });
});
