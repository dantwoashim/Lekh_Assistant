const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, nativeTheme, session, shell } = require("electron");
const { existsSync } = require("node:fs");
const { execFile, spawn } = require("node:child_process");
const { createHash, createPublicKey, verify: verifySignature } = require("node:crypto");
const { writeFile } = require("node:fs/promises");
const { promisify } = require("node:util");
const { homedir, tmpdir } = require("node:os");
const path = require("node:path");
const {
  BoundedSerialTaskQueue,
  validatePreferencePatch
} = require("./preference-write-queue.cjs");
const {
  inspectWindowsRegistration,
  probeWindowsBroker,
  readWindowsPreferences,
  readWindowsStartupRegistration,
  registerWindowsTsfElevated,
  windowsApplicationIdentifier,
  writeWindowsPreferencePatch,
  writeWindowsStartupRegistration
} = require("./windows-native.cjs");

const isDevServer = Boolean(process.env.LEKH_COMPANION_DEV_SERVER);
const startsInBackground = process.platform === "win32" && process.argv.includes("--background");
const execFileAsync = promisify(execFile);
const nativePreferenceDomain = "com.lekh.inputmethod.LekhKeyboard";
const nativeBundlePath = path.join(homedir(), "Library", "Input Methods", "Lekh Keyboard.app");
const nativePreferenceKeys = new Map([
  ["inlinePreviewEnabled", ["LekhInlinePreviewEnabled", true]],
  ["customCandidatePanelEnabled", ["LekhCustomCandidatePanelEnabled", false]],
  ["proofreadAsYouTypeEnabled", ["LekhProofreadAsYouTypeEnabled", true]],
  ["smartPunctuationEnabled", ["LekhSmartPunctuationEnabled", true]],
  ["personalizationEnabled", ["LekhPersonalizationEnabled", true]],
  ["nextWordPredictionEnabled", ["LekhNextWordPredictionEnabled", true]]
]);
const nativeBooleanPreferenceKeys = new Set(nativePreferenceKeys.keys());
const nativeModeKey = "LekhNativeTypingMode";
const excludedApplicationsKey = "LekhExcludedApplicationBundleIdentifiers";
const maximumExcludedApplications = 100;
const maximumPendingPreferenceWrites = 32;
const preferenceWriteDrainTimeoutMs = 5000;
const updateFeedUrl = "https://lekh-assistant.pages.dev/updates/macos/appcast.xml";
const updateHost = "lekh-assistant.pages.dev";
const updatePublicKeyBase64 = "iKAPpQHHx7GBhsTDmadt3rilfhhPKo2RdqV2Q0/zN6U=";
const nativeModes = new Set([
  "romanized-romanized",
  "romanized-traditional",
  "traditional-traditional",
  "traditional-romanized"
]);
const preferenceWriteQueue = new BoundedSerialTaskQueue({
  maximumPending: maximumPendingPreferenceWrites
});
let pipeBrokerProcess = null;
let pipeBrokerRestartTimer = null;
let pipeBrokerStableTimer = null;
let pipeBrokerRestartAttempts = 0;
let applicationIsQuitting = false;
let verifiedUpdate = null;
let settingsOpenRequestedBeforeReady = false;
let preferenceQuitDrainStarted = false;
let preferenceQuitDrainComplete = false;
let windowsTray = null;
let pipeBrokerGeneration = 0;
let explainedWindowsBackgroundBehavior = false;
let windowsStartupRegistrationEnabled = false;
const windowsAuthenticodeStatusCache = new Map();

function createWindow({ showWhenReady = true } = {}) {
  const window = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 600,
    title: "Lekh Keyboard Companion",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#222224" : "#f3f3f3",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      webSecurity: true
    }
  });

  if (showWhenReady) window.once("ready-to-show", () => window.show());
  window.once("closed", () => {
    if (
      process.platform === "win32"
      && !applicationIsQuitting
      && !explainedWindowsBackgroundBehavior
      && windowsTray
    ) {
      explainedWindowsBackgroundBehavior = true;
      windowsTray.displayBalloon({
        title: "Lekh Keyboard is still running",
        content: "The typing service stays available. Open Settings from the Lekh tray icon.",
        respectQuietTime: true
      });
    }
  });
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
  return window;
}

function showCompanionWindow() {
  let [window] = BrowserWindow.getAllWindows();
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
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
const ownsPrimaryInstance = app.requestSingleInstanceLock();
if (!ownsPrimaryInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (app.isReady()) {
      showCompanionWindow();
    } else {
      settingsOpenRequestedBeforeReady = true;
    }
  });
  app.whenReady().then(async () => {
    lockDownRendererPermissions();
    installApplicationMenu();
    registerCompanionIpc();
    startWindowsPipeBrokerIfAvailable();
    if (process.platform === "win32" && app.isPackaged) {
      windowsStartupRegistrationEnabled = await readWindowsStartupRegistration(process.execPath);
    }
    createWindowsTray();
    if (!startsInBackground || settingsOpenRequestedBeforeReady) createWindow();
    settingsOpenRequestedBeforeReady = false;
    app.on("activate", showCompanionWindow);
  }).catch((error) => {
    dialog.showErrorBox(
      "Lekh Keyboard could not start",
      error instanceof Error ? error.message : "The companion could not initialize."
    );
    app.quit();
  });
}

function lockDownRendererPermissions() {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setDevicePermissionHandler(() => false);
}

function installApplicationMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => {
            const [window] = BrowserWindow.getAllWindows();
            if (!window) return;
            if (window.isMinimized()) window.restore();
            window.show();
            window.focus();
          }
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    }] : []),
    ...(process.platform === "win32" ? [{
      label: "File",
      submenu: [
        {
          label: "Exit Lekh Keyboard Companion",
          click: () => app.quit()
        }
      ]
    }] : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(process.platform === "darwin" ? [
          { type: "separator" },
          { role: "front" }
        ] : [{ role: "close" }])
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerCompanionIpc() {
  ipcMain.handle("lekh:status", async () => {
    if (process.platform === "win32") return windowsNativeStatus();
    const installed = process.platform === "darwin" && existsSync(nativeBundlePath);
    const [version, enabledSources, selectedSource, selectedSources, releaseSigned] = await Promise.all([
      installed ? readPlistValue("CFBundleShortVersionString") : Promise.resolve(null),
      readDefaults("com.apple.HIToolbox", "AppleEnabledInputSources"),
      readDefaults("com.apple.HIToolbox", "AppleCurrentKeyboardLayoutInputSourceID"),
      readDefaults("com.apple.HIToolbox", "AppleSelectedInputSources"),
      installed ? isDeveloperIdSigned(nativeBundlePath) : Promise.resolve(null)
    ]);
    const sourceIdentifier = "com.lekh.inputmethod.LekhKeyboard";
    return {
      platform: process.platform,
      installed,
      version,
      enabled: enabledSources.includes(sourceIdentifier),
      selected: `${selectedSource}\n${selectedSources}`.includes(sourceIdentifier),
      bundlePath: installed ? nativeBundlePath : null,
      releaseSigned
    };
  });

  ipcMain.handle("lekh:preferences:read", async () => {
    if (process.platform === "win32") return readWindowsPreferences();
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
    const validatedPatch = validatePreferencePatch(patch, {
      booleanKeys: nativeBooleanPreferenceKeys,
      nativeModes,
      maximumExcludedApplications
    });
    return preferenceWriteQueue.enqueue(() => (
      process.platform === "win32"
        ? writeWindowsPreferencePatch(validatedPatch)
        : writeNativePreferencePatch(validatedPatch)
    ));
  });

  ipcMain.handle("lekh:open-keyboard-settings", async () => {
    const settingsUrl = process.platform === "win32"
      ? "ms-settings:regionlanguage"
      : "x-apple.systempreferences:com.apple.Keyboard-Settings.extension";
    await shell.openExternal(settingsUrl);
    return { ok: true };
  });

  ipcMain.handle("lekh:reveal-input-method", async () => {
    if (process.platform === "win32") {
      const tsfPath = windowsTsfBundlePath();
      if (tsfPath) {
        shell.showItemInFolder(tsfPath);
        return { ok: true, error: null };
      }
      const error = await shell.openPath(process.resourcesPath);
      return { ok: error === "", error: error || null };
    }
    const target = existsSync(nativeBundlePath)
      ? nativeBundlePath
      : path.join(homedir(), "Library", "Input Methods");
    const error = await shell.openPath(target);
    return { ok: error === "", error: error || null };
  });

  ipcMain.handle("lekh:privacy:choose-excluded-applications", async () => {
    if (process.platform === "win32") {
      const result = await dialog.showOpenDialog({
        title: "Never personalize in these applications",
        defaultPath: process.env.ProgramFiles || process.env.LOCALAPPDATA,
        buttonLabel: "Exclude applications",
        filters: [{ name: "Windows applications", extensions: ["exe"] }],
        properties: ["openFile", "multiSelections", "dontAddToRecent"]
      });
      if (result.canceled) return [];
      return result.filePaths.slice(0, 25).flatMap((applicationPath) => {
        const identifier = windowsApplicationIdentifier(applicationPath);
        if (!identifier) return [];
        return [{
          bundleIdentifier: identifier,
          displayName: path.basename(applicationPath, path.extname(applicationPath))
        }];
      });
    }
    if (process.platform !== "darwin") return [];
    const result = await dialog.showOpenDialog({
      title: "Never learn in these applications",
      defaultPath: "/Applications",
      buttonLabel: "Exclude Applications",
      properties: ["openFile", "multiSelections", "dontAddToRecent"]
    });
    if (result.canceled) return [];

    const applications = [];
    for (const applicationPath of result.filePaths.slice(0, 25)) {
      if (path.extname(applicationPath).toLowerCase() !== ".app") continue;
      const infoPlist = path.join(applicationPath, "Contents", "Info.plist");
      const [bundleIdentifier, displayName, bundleName] = await Promise.all([
        readPlistAtPath(infoPlist, "CFBundleIdentifier"),
        readPlistAtPath(infoPlist, "CFBundleDisplayName"),
        readPlistAtPath(infoPlist, "CFBundleName")
      ]);
      if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleIdentifier ?? "")) continue;
      applications.push({
        bundleIdentifier,
        displayName: displayName || bundleName || path.basename(applicationPath, ".app")
      });
    }
    return applications;
  });

  ipcMain.handle("lekh:windows:repair", async () => {
    if (process.platform !== "win32") throw new Error("Windows repair is available only on Windows.");
    const tsfPath = windowsTsfBundlePath();
    if (!tsfPath) throw new Error("The packaged Windows text service is missing.");
    const compatibilityDllPath = expectedWindowsX86TsfBundlePath();
    if (compatibilityDllPath && !existsSync(compatibilityDllPath)) {
      throw new Error("The packaged 32-bit Windows text service is missing.");
    }
    await registerWindowsTsfElevated(tsfPath, { compatibilityDllPath });
    await restartWindowsPipeBroker();
    const health = await waitForWindowsBrokerHealth();
    const status = await windowsNativeStatus();
    if (!status.registered) throw new Error("Windows did not retain the repaired text-service registration.");
    if (!health.healthy) throw new Error("The text service was repaired, but its local broker did not become ready.");
    return { ok: true, status };
  });

  ipcMain.handle("lekh:windows:restart-service", async () => {
    if (process.platform !== "win32") throw new Error("The Windows typing service is not available on this platform.");
    await restartWindowsPipeBroker();
    const health = await waitForWindowsBrokerHealth();
    return { ok: health.healthy };
  });

  ipcMain.handle("lekh:windows:set-startup", async (_event, enabled) => {
    if (process.platform !== "win32" || !app.isPackaged || typeof enabled !== "boolean") {
      throw new Error("Run-at-sign-in can be changed only by the installed Windows companion.");
    }
    await setWindowsStartupEnabled(enabled);
    rebuildWindowsTrayMenu();
    return { ok: true, enabled: windowsStartupRegistrationEnabled };
  });

  ipcMain.handle("lekh:updates:check", async () => {
    if (process.platform === "win32") {
      return {
        status: "disabled",
        message: "Windows updates remain disabled until an Authenticode-signed TSF release is validated."
      };
    }
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

async function writeNativePreferencePatch(patch) {
  for (const [publicKey, value] of Object.entries(patch)) {
    if (publicKey === "nativeTypingMode") {
      await execFileAsync("/usr/bin/defaults", [
        "write",
        nativePreferenceDomain,
        nativeModeKey,
        "-string",
        value
      ], { timeout: 3000 });
      continue;
    }
    if (publicKey === "excludedApplicationBundleIdentifiers") {
      await execFileAsync("/usr/bin/defaults", [
        "write",
        nativePreferenceDomain,
        excludedApplicationsKey,
        "-array",
        ...value
      ], { timeout: 3000 });
      continue;
    }
    const definition = nativePreferenceKeys.get(publicKey);
    await execFileAsync("/usr/bin/defaults", [
      "write",
      nativePreferenceDomain,
      definition[0],
      "-bool",
      value ? "true" : "false"
    ], { timeout: 3000 });
  }
  return { ok: true };
}

async function windowsNativeStatus() {
  const tsfPath = windowsTsfBundlePath();
  const compatibilityDllPath = expectedWindowsX86TsfBundlePath();
  const installed = Boolean(tsfPath && (!compatibilityDllPath || existsSync(compatibilityDllPath)));
  const [registration, broker, startupEnabled] = await Promise.all([
    tsfPath
      ? inspectWindowsRegistration(tsfPath, { compatibilityDllPath })
      : Promise.resolve({
        registered: false,
        pathMatches: false,
        valid: false,
        issues: ["missing-native-artifact"]
      }),
    pipeBrokerProcess ? probeWindowsBroker() : Promise.resolve({
      healthy: false,
      latencyMs: 0,
      reason: "service-process-not-running"
    }),
    app.isPackaged ? readWindowsStartupRegistration(process.execPath) : Promise.resolve(false)
  ]);
  windowsStartupRegistrationEnabled = startupEnabled;
  return {
    platform: process.platform,
    installed,
    version: installed ? app.getVersion() : null,
    enabled: registration.valid && broker.healthy,
    // The companion has no reliable cross-process proof of the foreground TSF
    // profile. Never turn registration into a false "active now" claim.
    selected: false,
    bundlePath: tsfPath,
    releaseSigned: tsfPath ? await isWindowsAuthenticodeSigned(tsfPath) : null,
    registered: registration.valid,
    registrationPathMatches: registration.pathMatches,
    registrationIssues: registration.issues,
    compatibilityRegistered: registration.compatibilityRegistered,
    compatibilityPathMatches: registration.compatibilityPathMatches,
    serviceHealthy: broker.healthy,
    serviceLatencyMs: broker.latencyMs,
    serviceIssue: broker.reason,
    serviceProcessRunning: Boolean(pipeBrokerProcess && !pipeBrokerProcess.killed),
    startupEnabled,
    startupCanChange: app.isPackaged,
    repairAvailable: Boolean(installed && !registration.valid)
  };
}

function windowsTsfBundlePath() {
  const candidates = [
    path.join(process.resourcesPath, "native", "windows-tsf", "LekhTextService.dll"),
    path.join(process.resourcesPath, "native", "windows-tsf", "build", "bin", "Release", "LekhTextService.dll")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function expectedWindowsX86TsfBundlePath() {
  if (process.arch === "ia32") return null;
  return app.isPackaged
    ? path.join(process.resourcesPath, "native", "windows-tsf", "build-x86", "bin", "Release", "LekhTextService.dll")
    : path.join(__dirname, "..", "native", "windows-tsf", "skeleton", "build-Win32", "bin", "Release", "LekhTextService.dll");
}

async function isWindowsAuthenticodeSigned(target) {
  if (!windowsAuthenticodeStatusCache.has(target)) {
    const check = execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-AuthenticodeSignature -LiteralPath $args[0]).Status",
      target
    ], { timeout: 5000, windowsHide: true })
      .then(({ stdout }) => stdout.trim() === "Valid")
      .catch(() => false);
    windowsAuthenticodeStatusCache.set(target, check);
  }
  return windowsAuthenticodeStatusCache.get(target);
}

async function isDeveloperIdSigned(target = process.execPath) {
  try {
    const { stderr } = await execFileAsync(
      "/usr/bin/codesign",
      ["-d", "--verbose=4", target],
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

function createWindowsTray() {
  if (process.platform !== "win32" || windowsTray) return;
  const iconPath = path.join(__dirname, "..", "build", "icon.ico");
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    console.error(`Windows tray icon is unavailable: ${iconPath}`);
    return;
  }
  windowsTray = new Tray(icon);
  windowsTray.setToolTip("Lekh Keyboard");
  windowsTray.on("click", showCompanionWindow);
  windowsTray.on("double-click", showCompanionWindow);
  rebuildWindowsTrayMenu();
}

function rebuildWindowsTrayMenu() {
  if (!windowsTray) return;
  windowsTray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "Open Lekh Settings",
      click: showCompanionWindow
    },
    {
      label: "Windows language & keyboard settings",
      click: () => void shell.openExternal("ms-settings:regionlanguage")
    },
    { type: "separator" },
    {
      label: "Run at sign-in",
      type: "checkbox",
      checked: windowsStartupRegistrationEnabled,
      enabled: app.isPackaged,
      click: (item) => {
        void setWindowsStartupEnabled(item.checked).then(() => {
          rebuildWindowsTrayMenu();
        }).catch((error) => {
          console.error("Could not change Lekh run-at-sign-in state.", error);
        });
      }
    },
    {
      label: "Restart typing service",
      click: () => void restartWindowsPipeBroker().catch((error) => {
        console.error("Could not restart the Lekh typing service.", error);
      })
    },
    { type: "separator" },
    {
      label: "Exit Lekh Keyboard",
      click: () => app.quit()
    }
  ]));
}

async function setWindowsStartupEnabled(enabled) {
  if (process.platform !== "win32" || !app.isPackaged || typeof enabled !== "boolean") {
    throw new Error("Run-at-sign-in can be changed only by the installed Windows companion.");
  }
  const result = await writeWindowsStartupRegistration(enabled, process.execPath);
  windowsStartupRegistrationEnabled = result.enabled;
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

async function readPlistAtPath(plistPath, key) {
  try {
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
  // On Windows the hidden primary process owns the per-user broker. Closing
  // Settings must never stop the keyboard; relaunching the shortcut focuses
  // this single instance. Linux keeps the conventional quit-on-close behavior.
  if (process.platform !== "darwin" && process.platform !== "win32") app.quit();
});

app.on("before-quit", (event) => {
  applicationIsQuitting = true;
  pipeBrokerGeneration += 1;
  if (pipeBrokerRestartTimer) clearTimeout(pipeBrokerRestartTimer);
  if (pipeBrokerStableTimer) clearTimeout(pipeBrokerStableTimer);
  pipeBrokerRestartTimer = null;
  pipeBrokerStableTimer = null;
  if (pipeBrokerProcess && !pipeBrokerProcess.killed) pipeBrokerProcess.kill();
  pipeBrokerProcess = null;
  if (windowsTray) windowsTray.destroy();
  windowsTray = null;

  preferenceWriteQueue.close();
  if (preferenceQuitDrainComplete || preferenceWriteQueue.pendingCount === 0) {
    preferenceQuitDrainComplete = true;
    return;
  }
  event.preventDefault();
  if (preferenceQuitDrainStarted) return;
  preferenceQuitDrainStarted = true;
  void preferenceWriteQueue.drain(preferenceWriteDrainTimeoutMs)
    .then((result) => {
      if (!result.drained) {
        console.error(`Native preference writes did not drain before quit (${result.pending} pending).`);
      }
    })
    .catch((error) => {
      console.error("Native preference write drain failed before quit.", error);
    })
    .finally(() => {
      preferenceQuitDrainComplete = true;
      app.quit();
    });
});

function startWindowsPipeBrokerIfAvailable() {
  if (process.platform !== "win32" || applicationIsQuitting || pipeBrokerProcess) return;
  const generation = pipeBrokerGeneration;
  const nativeBuildDirectory = process.arch === "arm64" ? "build-ARM64" : "build";
  const daemonPath = app.isPackaged
    ? path.join(process.resourcesPath, "native", "daemon", "lekh-keyboard-daemon.mjs")
    : path.join(__dirname, "..", "native", "daemon", "dist", "lekh-keyboard-daemon.mjs");
  const brokerPath = app.isPackaged
    ? path.join(process.resourcesPath, "native", "windows-tsf", "build", "bin", "Release", "LekhPipeBroker.exe")
    : path.join(__dirname, "..", "native", "windows-tsf", "skeleton", nativeBuildDirectory, "bin", "Release", "LekhPipeBroker.exe");
  if (!existsSync(daemonPath) || !existsSync(brokerPath)) return;

  const broker = spawn(brokerPath, [], {
    stdio: "ignore",
    detached: false,
    windowsHide: true
  });
  pipeBrokerProcess = broker;
  pipeBrokerStableTimer = setTimeout(() => {
    pipeBrokerRestartAttempts = 0;
    pipeBrokerStableTimer = null;
  }, 30_000);
  pipeBrokerStableTimer.unref();

  let stopped = false;
  const handleStoppedBroker = () => {
    if (stopped) return;
    stopped = true;
    if (pipeBrokerStableTimer) clearTimeout(pipeBrokerStableTimer);
    pipeBrokerStableTimer = null;
    if (pipeBrokerProcess === broker) pipeBrokerProcess = null;
    if (applicationIsQuitting || generation !== pipeBrokerGeneration) return;
    const retryDelays = [250, 1000, 4000, 15_000, 60_000];
    const retryIndex = Math.min(pipeBrokerRestartAttempts, retryDelays.length - 1);
    const delay = retryDelays[retryIndex];
    pipeBrokerRestartAttempts = Math.min(retryIndex + 1, retryDelays.length - 1);
    pipeBrokerRestartTimer = setTimeout(() => {
      pipeBrokerRestartTimer = null;
      startWindowsPipeBrokerIfAvailable();
    }, delay);
    pipeBrokerRestartTimer.unref();
  };
  broker.once("error", handleStoppedBroker);
  broker.once("exit", handleStoppedBroker);
}

async function restartWindowsPipeBroker() {
  if (process.platform !== "win32" || applicationIsQuitting) {
    throw new Error("The Windows typing service cannot be restarted now.");
  }
  pipeBrokerGeneration += 1;
  if (pipeBrokerRestartTimer) clearTimeout(pipeBrokerRestartTimer);
  if (pipeBrokerStableTimer) clearTimeout(pipeBrokerStableTimer);
  pipeBrokerRestartTimer = null;
  pipeBrokerStableTimer = null;
  const broker = pipeBrokerProcess;
  pipeBrokerProcess = null;
  pipeBrokerRestartAttempts = 0;
  if (broker && !broker.killed) broker.kill();
  await new Promise((resolve) => setTimeout(resolve, 250));
  startWindowsPipeBrokerIfAvailable();
}

async function waitForWindowsBrokerHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastHealth = { healthy: false, latencyMs: 0, reason: "service-process-not-running" };
  do {
    if (pipeBrokerProcess && !pipeBrokerProcess.killed) {
      lastHealth = await probeWindowsBroker({ timeoutMs: 1000 });
      if (lastHealth.healthy) return lastHealth;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return lastHealth;
}
