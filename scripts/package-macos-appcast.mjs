#!/usr/bin/env node
import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = process.cwd();
const startedAt = performance.now();
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const value = process.argv[index + 1]?.startsWith("--") ? "1" : process.argv[index + 1] ?? "1";
  args.set(key, value);
  if (value !== "1") index += 1;
}

const zipPath = args.get("zip") ?? join(ROOT, "release", "native", "macos", "Lekh-Keyboard-Test-Installer.zip");
const appcastPath = args.get("out") ?? join(ROOT, "release", "native", "macos", "appcast.xml");
const version = args.get("version") ?? "4";
const shortVersion = args.get("short-version") ?? "0.1.0";
const channel = args.get("channel") ?? "monthly";
const updateURL = args.get("url") ?? "https://lekh-assistant.pages.dev/updates/macos/Lekh-Keyboard-Test-Installer.zip";
const privateKeyPath = args.get("private-key") ?? join(ROOT, "data", "private", "lekh-sparkle-ed25519-private.pem");
const reportPath = args.get("report") ?? join(ROOT, "reports", "macos-appcast-report.json");

try {
  if (!existsSync(zipPath)) fail("missing-update-archive", { zip: relative(ROOT, zipPath) }, 1);
  if (!existsSync(privateKeyPath)) {
    fail("missing-sparkle-signing-key", {
      privateKey: relative(ROOT, privateKeyPath),
      reason: "Sparkle appcast generation requires an Ed25519 private key outside the repository."
    }, 1);
  }

  const archive = readFileSync(zipPath);
  const signature = sign(null, archive, createPrivateKey(readFileSync(privateKeyPath, "utf8"))).toString("base64");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const length = statSync(zipPath).size;
  const pubDate = new Date().toUTCString();
  mkdirSync(dirname(appcastPath), { recursive: true });
  writeFileSync(appcastPath, appcastXml({
    title: "Lekh Keyboard",
    channel,
    updateURL,
    version,
    shortVersion,
    length,
    signature,
    sha256,
    pubDate
  }));

  finish("passed", {
    appcast: relative(ROOT, appcastPath),
    zip: relative(ROOT, zipPath),
    channel,
    version,
    shortVersion,
    length,
    sha256,
    signatureAlgorithm: "Ed25519"
  }, 0);
} catch (error) {
  fail("macos-appcast-error", { error: error instanceof Error ? error.message : String(error) }, 1);
}

function appcastXml(details) {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"
  xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escapeXml(details.title)} Updates</title>
    <link>https://lekh-assistant.pages.dev/</link>
    <description>Signed ${escapeXml(details.channel)} updates for ${escapeXml(details.title)}</description>
    <language>en</language>
    <item>
      <title>${escapeXml(details.title)} ${escapeXml(details.shortVersion)}</title>
      <sparkle:version>${escapeXml(details.version)}</sparkle:version>
      <sparkle:shortVersionString>${escapeXml(details.shortVersion)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
      <pubDate>${escapeXml(details.pubDate)}</pubDate>
      <description><![CDATA[Local-first Nepali keyboard update.]]></description>
      <enclosure
        url="${escapeXml(details.updateURL)}"
        sparkle:version="${escapeXml(details.version)}"
        sparkle:shortVersionString="${escapeXml(details.shortVersion)}"
        type="application/octet-stream"
        length="${details.length}"
        sparkle:edSignature="${escapeXml(details.signature)}"
        sparkle:sha256="${escapeXml(details.sha256)}" />
    </item>
  </channel>
</rss>
`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fail(status, details, exitCode) {
  finish(status, details, exitCode);
}

function finish(status, details, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/package-macos-appcast.mjs",
    suite: "macos-appcast",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(ROOT, reportPath), ...details }, null, 2));
  process.exit(exitCode);
}
