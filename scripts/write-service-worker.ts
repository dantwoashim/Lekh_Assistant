import { createHash } from "node:crypto";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

const root = process.cwd();
const distDir = join(root, "dist");
const publicUrls = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/lekh-icon.svg",
  "/THIRD_PARTY_NOTICES.txt"
];

const assetUrls = listFiles(join(distDir, "assets"))
  .filter((file) => /\.(css|js|woff2?|png|svg|webp|avif)$/.test(file))
  .map((file) => toPublicUrl(file));

const precacheUrls = Array.from(new Set([...publicUrls, ...assetUrls])).sort();
const version = createHash("sha256").update(precacheUrls.join("\n")).digest("hex").slice(0, 12);

const serviceWorker = `const CACHE_NAME = "lekh-keyboard-${version}";
const PRECACHE_URLS = ${JSON.stringify(precacheUrls, null, 2)};

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

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      });
    })
  );
});
`;

writeFileSync(join(distDir, "sw.js"), serviceWorker);
console.log(`Wrote service worker with ${precacheUrls.length} precached URLs.`);

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    const stat = statSync(path);
    return stat.isDirectory() ? listFiles(path) : [path];
  });
}

function toPublicUrl(path: string): string {
  return `/${relative(distDir, path).split(sep).join(posix.sep)}`;
}
