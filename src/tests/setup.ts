import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(String(key)) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(String(key)); },
    setItem: (key, value) => { values.set(String(key), String(value)); }
  };
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  // Node 25 exposes a process-global Storage object that warns or throws when
  // --localstorage-file has no usable path. Tests need a browser-scoped store,
  // so always replace the host implementation with a fresh deterministic one.
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: createMemoryStorage()
  });
}

if (typeof navigator !== "undefined") {
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined)
    }
  });
}
