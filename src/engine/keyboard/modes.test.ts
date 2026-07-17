import { describe, expect, it } from "vitest";
import { defaultTypingContext, isLearningAllowedContext, isSecureContext } from "./modes";

describe("keyboard context policy", () => {
  it("declares the default context as a known normal field", () => {
    const context = defaultTypingContext();

    expect(context.fieldType).toBe("normal");
    expect(isSecureContext(context)).toBe(false);
    expect(isLearningAllowedContext(context)).toBe(true);
  });

  it.each(["password", "code", "unknown"] as const)(
    "treats %s fields as secure and ineligible for learning",
    (fieldType) => {
      const context = { ...defaultTypingContext(), fieldType };

      expect(isSecureContext(context)).toBe(true);
      expect(isLearningAllowedContext(context)).toBe(false);
    }
  );
});
