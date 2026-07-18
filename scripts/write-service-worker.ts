import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import {
  contentBoundPrecacheVersion,
  renderBoundedServiceWorker
} from "./lib/serviceWorkerManifest";

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
const precacheEntries = precacheUrls.map((url) => ({
  url,
  content: readFileSync(join(distDir, url === "/" ? "index.html" : url.slice(1)))
}));
const version = contentBoundPrecacheVersion(precacheEntries);
const serviceWorker = renderBoundedServiceWorker(`lekh-keyboard-${version}`, precacheUrls);

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
