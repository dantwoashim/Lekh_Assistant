import { afterEach, describe, expect, it } from "vitest";

import {
  activationPhase,
  detectCompanionLocale,
  detectCompanionSection,
  friendlyApplicationIdentifier,
  normalizeApplicationIdentifiers,
  persistCompanionLocale,
  persistCompanionSection,
  type CompanionStorage
} from "./companionModel";

const status = (patch: Partial<LekhNativeStatus>): LekhNativeStatus => ({
  platform: "darwin",
  installed: false,
  enabled: false,
  selected: false,
  version: null,
  bundlePath: null,
  releaseSigned: null,
  ...patch
});

describe("companion presentation model", () => {
  afterEach(() => window.localStorage.clear());

  it("derives every activation phase from native truth", () => {
    expect(activationPhase(null)).toBe("missing");
    expect(activationPhase(status({}))).toBe("missing");
    expect(activationPhase(status({ installed: true }))).toBe("installed");
    expect(activationPhase(status({ installed: true, enabled: true }))).toBe("enabled");
    expect(activationPhase(status({ installed: true, enabled: true, selected: true }))).toBe("selected");
  });

  it("normalizes valid application identifiers and rejects the whole invalid set", () => {
    expect(normalizeApplicationIdentifiers([
      " com.microsoft.VSCode ",
      "com.microsoft.VSCode",
      "org.mozilla.firefox",
      " "
    ])).toEqual(["com.microsoft.VSCode", "org.mozilla.firefox"]);
    expect(normalizeApplicationIdentifiers(["com.example.Editor", "not a bundle id"])).toBeNull();
    expect(normalizeApplicationIdentifiers(["com..Editor"])).toBeNull();
  });

  it("turns a bundle identifier into a readable fallback name", () => {
    expect(friendlyApplicationIdentifier("com.microsoft.VSCode")).toBe("VSCode");
    expect(friendlyApplicationIdentifier("org.example.my-editor_app")).toBe("my editor app");
  });

  it("restores only supported locale and section values", () => {
    window.localStorage.setItem("lekh.companion.locale", "ne");
    window.localStorage.setItem("lekh.companion.section", "privacy");
    expect(detectCompanionLocale()).toBe("ne");
    expect(detectCompanionSection()).toBe("privacy");

    window.localStorage.setItem("lekh.companion.locale", "fr");
    window.localStorage.setItem("lekh.companion.section", "unknown");
    expect(detectCompanionLocale()).toBe("en");
    expect(detectCompanionSection()).toBe("typing");
  });

  it("falls back safely when storage reads throw a security error", () => {
    const blockedStorage: CompanionStorage = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => undefined
    };

    expect(() => detectCompanionLocale(blockedStorage)).not.toThrow();
    expect(() => detectCompanionSection(blockedStorage)).not.toThrow();
    expect(detectCompanionLocale(blockedStorage)).toBe("en");
    expect(detectCompanionSection(blockedStorage)).toBe("typing");
  });

  it("returns false instead of claiming persistence when storage writes throw", () => {
    const blockedStorage: CompanionStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      }
    };

    expect(persistCompanionLocale("ne", blockedStorage)).toBe(false);
    expect(persistCompanionSection("privacy", blockedStorage)).toBe(false);
  });
});
