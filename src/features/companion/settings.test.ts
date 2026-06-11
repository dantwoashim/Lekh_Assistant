import { describe, expect, it } from "vitest";
import {
  companionSettingsToTypingContext,
  defaultCompanionSettings,
  exportCompanionSettings,
  importCompanionSettings,
  normalizeCompanionSettings
} from "./settings";

describe("companion settings model", () => {
  it("normalizes unsafe settings patches and keeps telemetry disabled", () => {
    const settings = normalizeCompanionSettings({
      candidateCount: 99,
      telemetryEnabled: true as false,
      excludedMemoryApps: ["Word", "Word", " ", "Passwords"]
    });

    expect(settings.candidateCount).toBe(9);
    expect(settings.telemetryEnabled).toBe(false);
    expect(settings.excludedMemoryApps).toEqual(["Word", "Passwords"]);
  });

  it("round-trips companion settings export/import", () => {
    const exported = exportCompanionSettings(
      {
        ...defaultCompanionSettings,
        showRomanizedLabels: true,
        pauseLearning: true
      },
      "2026-06-10T00:00:00.000Z"
    );

    expect(exported).toEqual(expect.objectContaining({ schemaVersion: 1, exportedAt: "2026-06-10T00:00:00.000Z" }));
    expect(importCompanionSettings(exported)).toEqual(expect.objectContaining({ showRomanizedLabels: true, pauseLearning: true, telemetryEnabled: false }));
  });

  it("maps settings into an engine typing context with secure memory controls", () => {
    const context = companionSettingsToTypingContext(
      {
        ...defaultCompanionSettings,
        showRomanizedLabels: true,
        excludedMemoryApps: ["Chrome"]
      },
      {
        appName: "Google Chrome",
        leftTextWindow: "मेरो ",
        mode: "romanized"
      }
    );

    expect(context.showRomanizedLabels).toBe(true);
    expect(context.enabledSurfaces).toContain("romanized-to-romanized");
    expect(context.enabledSurfaces).toContain("traditional-to-traditional-proofread");
    expect(context.secureInput).toBe(true);
    expect(context.layoutId).toBe("traditional-ltk-compatible.pending");
  });
});
