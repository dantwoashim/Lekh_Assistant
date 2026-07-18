import { createHash } from "node:crypto";

export interface PrecacheEntry {
  url: string;
  content: Uint8Array;
}

export function contentBoundPrecacheVersion(entries: readonly PrecacheEntry[]): string {
  const digest = createHash("sha256");
  for (const entry of entries.slice().sort((left, right) => compareCodeUnits(left.url, right.url))) {
    digest.update(entry.url, "utf8");
    digest.update("\0", "utf8");
    digest.update(entry.content);
    digest.update("\0", "utf8");
  }
  return digest.digest("hex").slice(0, 16);
}

export function renderBoundedServiceWorker(
  cacheName: string,
  precacheUrls: readonly string[]
): string {
  if (!/^lekh-keyboard-[a-f0-9]{16}$/.test(cacheName)) {
    throw new Error("Service-worker cache name must contain a content-bound version.");
  }
  const urls = Array.from(new Set(precacheUrls)).sort(compareCodeUnits);
  if (urls.length === 0 || urls.some((url) => !isSafePrecacheUrl(url))) {
    throw new Error("Service-worker precache URLs must be unique local absolute paths.");
  }

  return `const CACHE_NAME = ${JSON.stringify(cacheName)};
const PRECACHE_URLS = ${JSON.stringify(urls, null, 2)};
const PRECACHE_PATHS = new Set(PRECACHE_URLS);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/index.html")));
    return;
  }

  if (!PRECACHE_PATHS.has(url.pathname)) return;
  event.respondWith(
    caches.match(url.pathname).then((cached) => cached || fetch(event.request))
  );
});
`;
}

function isSafePrecacheUrl(url: string): boolean {
  if (!url.startsWith("/") || url.startsWith("//") || url.includes("\\")) return false;
  try {
    const parsed = new URL(url, "https://lekh.invalid");
    return parsed.origin === "https://lekh.invalid" &&
      parsed.pathname === url &&
      !parsed.pathname.split("/").includes("..");
  } catch {
    return false;
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
