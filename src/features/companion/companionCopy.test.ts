import { describe, expect, it } from "vitest";

import {
  advancedPreferenceOrder,
  copyByLocale,
  modeOrder,
  type BooleanPreferenceKey
} from "./companionCopy";

describe("companion copy contract", () => {
  it("keeps both locales structurally complete", () => {
    const english = copyByLocale.en;
    const nepali = copyByLocale.ne;

    expect(Object.keys(nepali)).toEqual(Object.keys(english));
    expect(Object.keys(nepali.sections)).toEqual(Object.keys(english.sections));
    expect(Object.keys(nepali.activation)).toEqual(Object.keys(english.activation));
    expect(Object.keys(nepali.windowsActivation)).toEqual(Object.keys(english.windowsActivation));
    expect(Object.keys(nepali.modes)).toEqual(Object.keys(english.modes));
    expect(Object.keys(nepali.preferences)).toEqual(Object.keys(english.preferences));
    expect(nepali.shortcuts).toHaveLength(english.shortcuts.length);
    expect(nepali.privacyPromises).toHaveLength(english.privacyPromises.length);
    expect(nepali.updateSafety).toHaveLength(english.updateSafety.length);
  });

  it("renders every native mode and every secondary boolean preference exactly once", () => {
    const allBooleanPreferences = Object.keys(copyByLocale.en.preferences) as BooleanPreferenceKey[];

    expect(new Set(modeOrder).size).toBe(4);
    expect(modeOrder).toEqual(Object.keys(copyByLocale.en.modes));
    expect(new Set(advancedPreferenceOrder).size).toBe(advancedPreferenceOrder.length);
    expect(advancedPreferenceOrder).toEqual([
      "customCandidatePanelEnabled",
      "nextWordPredictionEnabled",
      "proofreadAsYouTypeEnabled",
      "smartPunctuationEnabled"
    ]);
    expect(allBooleanPreferences).toEqual(expect.arrayContaining([
      ...advancedPreferenceOrder,
      "inlinePreviewEnabled",
      "personalizationEnabled"
    ]));
  });

  it("keeps dynamic accessible and version copy locale-specific", () => {
    const status: LekhNativeStatus = {
      platform: "darwin",
      installed: true,
      enabled: true,
      selected: true,
      version: "1.2.3",
      bundlePath: "/Library/Input Methods/Lekh Keyboard.app",
      releaseSigned: true
    };

    expect(copyByLocale.en.versionLine(status)).toContain("1.2.3");
    expect(copyByLocale.ne.versionLine(status)).toContain("1.2.3");
    expect(copyByLocale.en.removeApplication("Editor")).toContain("Editor");
    expect(copyByLocale.ne.removeApplication("Editor")).toContain("Editor");
    expect(copyByLocale.en.updateVerified("1.2.3")).toContain("1.2.3");
    expect(copyByLocale.ne.updateVerified("1.2.3")).toContain("1.2.3");
  });
});
