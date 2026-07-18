import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

if (typeof navigator !== "undefined") {
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined)
    }
  });
}
