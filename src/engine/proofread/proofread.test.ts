import { describe, expect, it } from "vitest";
import { convert } from "../index";
import { applyProofread } from "./index";

describe("proofread engine", () => {
  it("joins common postpositions when auto-fix is enabled", () => {
    const result = applyProofread("विद्यालय को आदेश लाई कागजात मा", { autoFix: true });
    expect(result.output).toBe("विद्यालयको आदेशलाई कागजातमा");
    expect(result.applied.map((hint) => hint.ruleId)).toContain("postposition-spacing");
  });

  it("normalizes plural हरु forms", () => {
    expect(applyProofread("नामहरु", { autoFix: true }).output).toBe("नामहरू");
    expect(applyProofread("नाम हरु मा", { autoFix: true }).output).toBe("नामहरूमा");
  });

  it("applies curated spelling corrections only when allowed", () => {
    const hintOnly = applyProofread("सवस्थ्य प्रनलि मरित्यु", { autoFix: false });
    expect(hintOnly.output).toBe("सवस्थ्य प्रनलि मरित्यु");
    expect(hintOnly.hints).toHaveLength(3);

    const fixed = applyProofread("सवस्थ्य प्रनलि मरित्यु", { autoFix: true });
    expect(fixed.output).toBe("स्वास्थ्य प्रणाली मृत्यु");
  });

  it("handles halant and punctuation normalization conservatively", () => {
    const result = applyProofread("मन्त्रिपरिषद आयो. ठीक।।", { autoFix: true });
    expect(result.output).toBe("मन्त्रिपरिषद् आयो। ठीक।");
  });

  it("suggests subject agreement and honorific fixes without silent autocorrect", () => {
    const result = applyProofread("हामी आयौ। उहाँ आयो। राम्रो लग्यो।", { autoFix: true });
    expect(result.output).toBe("हामी आयौ। उहाँ आयो। राम्रो लग्यो।");
    expect(result.applied).toHaveLength(0);
    expect(result.hints.map((hint) => hint.suggestion)).toEqual(
      expect.arrayContaining(["हामी आयौं", "उहाँ आउनुभयो", "राम्रो लाग्यो"])
    );
    expect(result.hints.find((hint) => hint.suggestion === "उहाँ आउनुभयो")?.kind).toBe("honorific");
    expect(result.hints.find((hint) => hint.suggestion === "हामी आयौं")?.kind).toBe("agreement");
  });

  it("adds rule-generated anusvara hints without relying only on pair-list auto-fixes", () => {
    const result = applyProofread("सस्कृति र सघीय विषय", { autoFix: true });
    expect(result.output).toBe("सस्कृति र सघीय विषय");
    expect(result.hints.map((hint) => hint.suggestion)).toEqual(expect.arrayContaining(["संस्कृति", "संघीय"]));
    expect(result.hints.every((hint) => hint.action === "hint-only")).toBe(true);
  });

  it("does not modify protected spans", () => {
    const result = applyProofread("email@test.com PDF सवस्थ्य.", { autoFix: true });
    expect(result.output).toBe("email@test.com PDF स्वास्थ्य।");
  });

  it("wires into ConversionResult only when requested", () => {
    const plain = convert("सवस्थ्य", { mode: "unicode-passthrough" });
    expect(plain.normalizedOutput).toBe("सवस्थ्य");
    expect(plain.proofread).toBeUndefined();

    const proofread = convert("सवस्थ्य", { mode: "unicode-passthrough", proofread: { autoFix: true } });
    expect(proofread.normalizedOutput).toBe("स्वास्थ्य");
    expect(proofread.proofread?.applied[0].ruleId).toBe("common-spelling-swasthya");
  });
});
