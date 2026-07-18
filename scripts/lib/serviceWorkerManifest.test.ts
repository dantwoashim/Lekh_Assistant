import { describe, expect, it } from "vitest";

import {
  contentBoundPrecacheVersion,
  renderBoundedServiceWorker
} from "./serviceWorkerManifest";

const bytes = (value: string) => Buffer.from(value, "utf8");

describe("content-bound service-worker manifest", () => {
  it("changes the cache version when bytes change, not only when URLs change", () => {
    const first = contentBoundPrecacheVersion([
      { url: "/index.html", content: bytes("first") },
      { url: "/assets/app.js", content: bytes("stable") }
    ]);
    const reordered = contentBoundPrecacheVersion([
      { url: "/assets/app.js", content: bytes("stable") },
      { url: "/index.html", content: bytes("first") }
    ]);
    const changed = contentBoundPrecacheVersion([
      { url: "/index.html", content: bytes("second") },
      { url: "/assets/app.js", content: bytes("stable") }
    ]);

    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("emits a closed precache without unbounded runtime writes", () => {
    const source = renderBoundedServiceWorker("lekh-keyboard-0123456789abcdef", [
      "/index.html",
      "/assets/app.js",
      "/index.html"
    ]);

    expect(source).toContain("const PRECACHE_PATHS = new Set(PRECACHE_URLS);");
    expect(source).toContain("if (!PRECACHE_PATHS.has(url.pathname)) return;");
    expect(source).toContain("caches.match(url.pathname)");
    expect(source).toContain("fetch(event.request).catch(() => caches.match(\"/index.html\"))");
    expect(source).not.toContain("cache.put(");
    expect(source.match(/\/index\.html/g)).toHaveLength(2);
  });

  it("rejects remote, ambiguous, traversal, and query-bearing precache URLs", () => {
    const cacheName = "lekh-keyboard-0123456789abcdef";
    for (const url of [
      "https://example.com/app.js",
      "//example.com/app.js",
      "/../private.txt",
      "/assets\\app.js",
      "/app.js?version=1"
    ]) {
      expect(() => renderBoundedServiceWorker(cacheName, [url])).toThrow(/local absolute paths/);
    }
  });
});
