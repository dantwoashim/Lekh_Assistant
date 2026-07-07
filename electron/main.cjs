const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const { existsSync } = require("node:fs");
const { execFile, spawn } = require("node:child_process");
const { createHash, createPublicKey, verify: verifySignature } = require("node:crypto");
const { writeFile } = require("node:fs/promises");
const { promisify } = require("node:util");
const { homedir, tmpdir } = require("node:os");
const path = require("node:path");

const isDevServer = Boolean(process.env.LEKH_COMPANION_DEV_SERVER);
const execFileAsync = promisify(execFile);
const nativePreferenceDomain = "com.lekh.inputmethod.LekhKeyboard";
const nativeBundlePath = path.join(homedir(), "Library", "Input Methods", "Lekh Keyboard.app");
const nativePreferenceKeys = new Map([
  ["inlinePreviewEnabled", ["LekhInlinePreviewEnabled", true]],
  ["customCandidatePanelEnabled", ["LekhCustomCandidatePanelEnabled", true]],
  ["proofreadAsYouTypeEnabled", ["LekhProofreadAsYouTypeEnabled", true]],
  ["smartPunctuationEnabled", ["LekhSmartPunctuationEnabled", true]],
  ["personalizationEnabled", ["LekhPersonalizationEnabled", true]],
  ["nextWordPredictionEnabled", ["LekhNextWordPredictionEnabled", true]]
]);
const nativeModeKey = "LekhNativeTypingMode";
const excludedApplicationsKey = "LekhExcludedApplicationBundleIdentifiers";
const updateFeedUrl = "https://lekh-assistant.pages.dev/updates/macos/appcast.xml";
const updateHost = "lekh-assistant.pages.dev";
const updatePublicKeyBase64 = "iKAPpQHHx7GBhsTDmadt3rilfhhPKo2RdqV2Q0/zN6U=";
const nativeModes = new Set([
  "romanized-romanized",
  "romanized-traditional",
  "traditional-traditional",
  "traditional-romanized"
]);
let daemonProcess = null;
let verifiedUpdate = null;

function createWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    title: "Lekh Keyboard Companion",
    backgroundColor: "#f7f4ef",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const appUrl = isDevServer
      ? process.env.LEKH_COMPANION_DEV_SERVER
      : `file://${path.join(__dirname, "..", "dist", "index.html")}`;
    if (!isAllowedAppNavigation(url, appUrl)) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) shell.openExternal(url);
    }
  });

  if (isDevServer) {
    window.loadURL(process.env.LEKH_COMPANION_DEV_SERVER);
  } else {
    window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

function isAllowedAppNavigation(url, appUrl) {
  try {
    const target = new URL(url);
    const expected = new URL(appUrl);
    if (expected.protocol === "file:") {
      return target.protocol === "file:" && target.pathname === expected.pathname;
    }
    return target.origin === expected.origin;
  } catch {
    return false;
  }
}

function isSafeExternalUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

app.setName("Lekh Keyboard Companion");
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerCompanionIpc();
  startDaemonIfAvailable();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function registerCompanionIpc() {
  ipcMain.handle("lekh:status", async () => {
    const installed = process.platform === "darwin" && existsSync(nativeBundlePath);
    const [version, enabledSources, selectedSource, selectedSources] = await Promise.all([
      installed ? readPlistValue("CFBundleShortVersionString") : Promise.resolve(null),
      readDefaults("com.apple.HIToolbox", "AppleEnabledInputSources"),
      readDefaults("com.apple.HIToolbox", "AppleCurrentKeyboardLayoutInputSourceID"),
      readDefaults("com.apple.HIToolbox", "AppleSelectedInputSources")
    ]);
    const sourceIdentifier = "com.lekh.inputmethod.LekhKeyboard";
    return {
      platform: process.platform,
      installed,
      version,
      enabled: enabledSources.includes(sourceIdentifier),
      selected: `${selectedSource}\n${selectedSources}`.includes(sourceIdentifier),
      bundlePath: installed ? nativeBundlePath : null,
      releaseSigned: app.isPackaged && process.mas === true ? true : null
    };
  });

  ipcMain.handle("lekh:preferences:read", async () => {
    const settings = {};
    await Promise.all(Array.from(nativePreferenceKeys.entries()).map(async ([publicKey, [nativeKey, fallback]]) => {
      const value = await readDefaults(nativePreferenceDomain, nativeKey);
      settings[publicKey] = value === "" ? fallback : value === "1" || value.toLowerCase() === "true";
    }));
    const nativeMode = await readDefaults(nativePreferenceDomain, nativeModeKey);
    settings.nativeTypingMode = nativeModes.has(nativeMode) ? nativeMode : "romanized-traditional";
    settings.excludedApplicationBundleIdentifiers = parseDefaultsArray(
      await readDefaults(nativePreferenceDomain, excludedApplicationsKey)
    );
    return settings;
  });

  ipcMain.handle("lekh:preferences:update", async (_event, patch) => {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("Invalid preference update.");
    }
    for (const [publicKey, value] of Object.entries(patch)) {
      if (publicKey === "nativeTypingMode" && typeof value === "string" && nativeModes.has(value)) {
        await execFileAsync("/usr/bin/defaults", [
          "write",
          nativePreferenceDomain,
          nativeModeKey,
          "-string",
          value
        ], { timeout: 3000 });
        continue;
      }
      if (publicKey === "excludedApplicationBundleIdentifiers" && Array.isArray(value)) {
        const identifiers = Array.from(new Set(value))
          .filter((item) => typeof item === "string" && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(item))
          .slice(0, 100);
        if (identifiers.length !== value.length) {
          throw new Error("Excluded applications must be valid bundle identifiers.");
        }
        await execFileAsync("/usr/bin/defaults", [
          "write",
          nativePreferenceDomain,
          excludedApplicationsKey,
          "-array",
          ...identifiers
        ], { timeout: 3000 });
        continue;
      }
      const definition = nativePreferenceKeys.get(publicKey);
      if (!definition || typeof value !== "boolean") {
        throw new Error(`Unsupported preference: ${publicKey}`);
      }
      await execFileAsync("/usr/bin/defaults", [
        "write",
        nativePreferenceDomain,
        definition[0],
        "-bool",
        value ? "true" : "false"
      ], { timeout: 3000 });
    }
    return { ok: true };
  });

  ipcMain.handle("lekh:open-keyboard-settings", async () => {
    await shell.openExternal("x-apple.systempreferences:com.apple.Keyboard-Settings.extension");
    return { ok: true };
  });

  ipcMain.handle("lekh:reveal-input-method", async () => {
    const target = existsSync(nativeBundlePath)
      ? nativeBundlePath
      : path.join(homedir(), "Library", "Input Methods");
    const error = await shell.openPath(target);
    return { ok: error === "", error: error || null };
  });

  ipcMain.handle("lekh:updates:check", async () => {
    if (process.platform !== "darwin" || !app.isPackaged || !(await isDeveloperIdSigned())) {
      return {
        status: "disabled",
        message: "Updates are enabled only in a Developer ID signed production companion."
      };
    }
    const xml = await fetchBounded(updateFeedUrl, 512 * 1024);
    const details = parseAppcast(xml.toString("utf8"));
    validateUpdateUrl(details.url);
    const currentVersion = app.getVersion();
    const available = compareVersions(details.shortVersion, currentVersion) > 0;
    verifiedUpdate = available ? details : null;
    return {
      status: available ? "available" : "current",
      currentVersion,
      version: details.shortVersion,
      build: details.version,
      message: available ? `Lekh ${details.shortVersion} is available.` : "Lekh is up to date."
    };
  });

  ipcMain.handle("lekh:updates:download", async () => {
    if (!verifiedUpdate || !(await isDeveloperIdSigned())) {
      throw new Error("No verified production update is available.");
    }
    const archive = await fetchBounded(verifiedUpdate.url, 512 * 1024 * 1024);
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest.toLowerCase() !== verifiedUpdate.sha256.toLowerCase()) {
      throw new Error("Update checksum verification failed.");
    }
    const rawKey = Buffer.from(updatePublicKeyBase64, "base64");
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      rawKey
    ]);
    const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    const valid = verifySignature(
      null,
      archive,
      publicKey,
      Buffer.from(verifiedUpdate.signature, "base64")
    );
    if (!valid) throw new Error("Update signature verification failed.");

    const destination = path.join(
      tmpdir(),
      `Lekh-Keyboard-${verifiedUpdate.shortVersion}-${Date.now()}.zip`
    );
    await writeFile(destination, archive, { mode: 0o600 });
    shell.showItemInFolder(destination);
    return { ok: true, version: verifiedUpdate.shortVersion };
  });
}

async function isDeveloperIdSigned() {
  try {
    const { stderr } = await execFileAsync(
      "/usr/bin/codesign",
      ["-d", "--verbose=4", process.execPath],
      { timeout: 3000 }
    );
    return /Authority=Developer ID Application:/.test(stderr);
  } catch {
    return false;
  }
}

async function fetchBounded(url, maximumBytes) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": `Lekh-Keyboard/${app.getVersion()}` },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Update server returned HTTP ${response.status}.`);
  validateUpdateUrl(response.url);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maximumBytes) throw new Error("Update response exceeds the size limit.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) throw new Error("Update response exceeds the size limit.");
  return bytes;
}

function parseAppcast(xml) {
  const enclosure = xml.match(/<enclosure\b([^>]+?)\/?>/i)?.[1] ?? "";
  const attributes = {};
  for (const match of enclosure.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
    attributes[match[1]] = decodeXml(match[2]);
  }
  const shortVersion = xml.match(/<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/i)?.[1];
  const version = attributes["sparkle:version"];
  const details = {
    url: attributes.url,
    version,
    shortVersion: shortVersion ? decodeXml(shortVersion) : undefined,
    sha256: attributes["sparkle:sha256"],
    signature: attributes["sparkle:edSignature"]
  };
  if (
    !details.url ||
    !/^\d+$/.test(details.version ?? "") ||
    !/^\d+\.\d+\.\d+$/.test(details.shortVersion ?? "") ||
    !/^[a-f0-9]{64}$/i.test(details.sha256 ?? "") ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(details.signature ?? "")
  ) {
    throw new Error("The update appcast is malformed or unsigned.");
  }
  return details;
}

function validateUpdateUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== updateHost) {
    throw new Error("Update URL is outside the pinned HTTPS host.");
  }
}

function decodeXml(value) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function readDefaults(domain, key) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/defaults", ["read", domain, key], { timeout: 3000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

function parseDefaultsArray(value) {
  if (!value.startsWith("(")) return [];
  return value
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/,$/, "").replace(/^"|"$/g, ""))
    .filter((line) => /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(line));
}

async function readPlistValue(key) {
  try {
    const plistPath = path.join(nativeBundlePath, "Contents", "Info.plist");
    const { stdout } = await execFileAsync(
      "/usr/libexec/PlistBuddy",
      ["-c", `Print :${key}`, plistPath],
      { timeout: 3000 }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (daemonProcess && !daemonProcess.killed) {
    daemonProcess.kill();
    daemonProcess = null;
  }
});

function startDaemonIfAvailable() {
  if (process.platform !== "win32") return;
  const daemonPath = app.isPackaged
    ? path.join(process.resourcesPath, "native", "daemon", "lekh-keyboard-daemon.mjs")
    : path.join(__dirname, "..", "native", "daemon", "dist", "lekh-keyboard-daemon.mjs");

  if (!existsSync(daemonPath)) return;

  daemonProcess = spawn(process.execPath, [daemonPath, "--named-pipe"], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1"
    },
    stdio: "ignore",
    detached: false,
    windowsHide: true
  });
  daemonProcess.once("exit", () => {
    daemonProcess = null;
  });
}
