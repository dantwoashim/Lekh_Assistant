const SHORT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PACKAGE_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const BUILD_VERSION_PATTERN = /^[1-9]\d{0,17}$/;

export const CODE_SIGN_BLOCKED_EXTENDED_ATTRIBUTES = Object.freeze([
  "com.apple.FinderInfo",
  "com.apple.ResourceFork",
  "com.apple.fileprovider.fpfs#P"
]);

export function isValidCompanionShortVersion(value) {
  return typeof value === "string" && SHORT_VERSION_PATTERN.test(value);
}

export function isValidCompanionBuildVersion(value) {
  return typeof value === "string" && BUILD_VERSION_PATTERN.test(value);
}

export function packageShortVersion(packageVersion) {
  if (typeof packageVersion !== "string") {
    throw new Error("package.json version must be a semantic-version string.");
  }
  const match = PACKAGE_SEMVER_PATTERN.exec(packageVersion);
  const invalidNumericPrerelease = match?.[4]
    ?.split(".")
    .some((identifier) => /^\d+$/.test(identifier) && !/^(0|[1-9]\d*)$/.test(identifier));
  if (!match || invalidNumericPrerelease) {
    throw new Error(`package.json version must be valid semantic version metadata; received ${JSON.stringify(packageVersion)}.`);
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function resolveCompanionBundleVersions({ environment, packageVersion, gitCount }) {
  const hasShortVersionOverride = Object.prototype.hasOwnProperty.call(environment, "LEKH_APP_SHORT_VERSION");
  const hasBuildVersionOverride = Object.prototype.hasOwnProperty.call(environment, "LEKH_APP_BUILD");
  const shortVersion = hasShortVersionOverride
    ? environment.LEKH_APP_SHORT_VERSION
    : packageShortVersion(packageVersion);
  const buildVersion = hasBuildVersionOverride ? environment.LEKH_APP_BUILD : gitCount;

  if (!isValidCompanionShortVersion(shortVersion)) {
    throw new Error(
      "LEKH_APP_SHORT_VERSION/CFBundleShortVersionString must be exactly three dot-separated, non-negative base-10 integers without leading zeroes (x.y.z)."
    );
  }
  if (!isValidCompanionBuildVersion(buildVersion)) {
    throw new Error(
      "LEKH_APP_BUILD/CFBundleVersion must be a positive base-10 integer without leading zeroes and at most 18 digits."
    );
  }

  return {
    shortVersion,
    buildVersion,
    shortVersionSource: hasShortVersionOverride ? "LEKH_APP_SHORT_VERSION" : "package.json",
    buildVersionSource: hasBuildVersionOverride ? "LEKH_APP_BUILD" : "git-rev-list-count"
  };
}

export function findCodeSignBlockedExtendedAttributes(xattrOutput) {
  const blocked = new Set(CODE_SIGN_BLOCKED_EXTENDED_ATTRIBUTES);
  const findings = [];
  const seen = new Set();

  for (const line of String(xattrOutput).split(/\r?\n/)) {
    const separator = line.lastIndexOf(": ");
    if (separator < 1) continue;
    const path = line.slice(0, separator);
    const attribute = line.slice(separator + 2).trim();
    if (!blocked.has(attribute)) continue;
    const key = `${path}\0${attribute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ path, attribute });
  }

  return findings;
}

export function parseCodeSignInspection(output) {
  const text = String(output);
  const values = new Map();
  const authorities = [];
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "Authority") authorities.push(value);
    else if (!values.has(key)) values.set(key, value);
  }
  const designatedRequirement = text.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("designated =>"))
    ?.slice("designated =>".length).trim() ?? null;
  const teamValue = values.get("TeamIdentifier") ?? null;
  const signature = values.get("Signature") ?? null;
  const timestamp = values.get("Timestamp") ?? values.get("Signed Time") ?? null;
  const codeDirectoryFlags = /flags=0x[0-9a-f]+\(([^)]+)\)/i.exec(text)?.[1]
    ?.split(",")
    .map((flag) => flag.trim()) ?? [];
  const signingKind = authorities.some((authority) => authority.startsWith("Developer ID Application:"))
    ? "developer-id"
    : signature === "adhoc"
      ? "ad-hoc"
      : "other";
  return {
    identifier: values.get("Identifier") ?? null,
    codeDirectoryHash: values.get("CDHash") ?? null,
    teamIdentifier: teamValue && teamValue !== "not set" ? teamValue : null,
    authorities,
    signature,
    signingKind,
    designatedRequirement,
    hardenedRuntime: codeDirectoryFlags.includes("runtime"),
    secureTimestamp: typeof timestamp === "string" && timestamp.length > 0 && timestamp !== "none",
    timestamp
  };
}
