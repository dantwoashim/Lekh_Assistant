import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const NATIVE_HOST_RISK_MATRIX_POLICY_PATH = "config/native-host-risk-matrix.v1.json";

const REQUIRED_HOST_IDS = Object.freeze([
  "accessibility-client",
  "chromium",
  "electron",
  "native-editor",
  "office-class",
  "remote-virtualized",
  "secure-field"
]);
const REQUIRED_MODE_IDS = Object.freeze([
  "mixed-code-protected",
  "romanized-latin",
  "romanized-nepali",
  "traditional-nepali"
]);
const policyKeys = Object.freeze([
  "evidenceReusePolicy",
  "expectedScenarioCount",
  "hosts",
  "maximumCartesianFraction",
  "maximumOpenDefects",
  "modes",
  "pairingStrategy",
  "productionPassRate",
  "recordType",
  "schemaVersion",
  "targets"
].sort());
const targetKeys = Object.freeze(["architecture", "id", "osFamily", "osVersion"].sort());
const hostKeys = Object.freeze(["applicationByPlatform", "id", "label", "riskCases"].sort());
const modeKeys = Object.freeze(["id", "label"].sort());

function exactKeys(value, expected) {
  return isRecord(value) && Object.keys(value).sort().join("\0") === expected.join("\0");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSlug(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9_]+)*$/u.test(value);
}

function isShortText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 160 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function sortedUniqueStrings(values) {
  return Array.isArray(values) && values.length > 0 && values.every(isShortText) &&
    new Set(values).size === values.length &&
    JSON.stringify(values) === JSON.stringify([...values].sort());
}

function sortedById(values) {
  return Array.isArray(values) && values.length > 0 && values.every((value) => isRecord(value)) &&
    JSON.stringify(values.map((value) => value.id)) ===
      JSON.stringify(values.map((value) => value.id).sort());
}

function pairKey(left, right) {
  return `${left}\0${right}`;
}

function missingPairs(leftValues, rightValues, observed) {
  const missing = [];
  for (const left of leftValues) {
    for (const right of rightValues) {
      const key = pairKey(left, right);
      if (!observed.has(key)) missing.push(key);
    }
  }
  return missing;
}

export function canonicalNativeHostScenarios(policy) {
  if (!policy || !Array.isArray(policy.targets) || !Array.isArray(policy.hosts) ||
      !Array.isArray(policy.modes) || policy.modes.length === 0 ||
      !policy.targets.every(isRecord) || !policy.hosts.every(isRecord) ||
      !policy.modes.every(isRecord)) return [];
  const scenarios = [];
  for (const [targetIndex, target] of policy.targets.entries()) {
    for (const [hostIndex, host] of policy.hosts.entries()) {
      const mode = policy.modes[(targetIndex + hostIndex) % policy.modes.length];
      scenarios.push(Object.freeze({
        id: `${target.id}__${host.id}__${mode.id}`,
        target: Object.freeze({ ...target }),
        host: Object.freeze({
          id: host.id,
          label: host.label,
          application: host.applicationByPlatform[target.osFamily],
          riskCases: Object.freeze([...host.riskCases])
        }),
        mode: Object.freeze({ ...mode })
      }));
    }
  }
  return Object.freeze(scenarios);
}

export function analyzeNativeHostPairwiseCoverage(policy, scenarios = canonicalNativeHostScenarios(policy)) {
  const targetHost = new Set();
  const targetMode = new Set();
  const hostMode = new Set();
  for (const scenario of scenarios) {
    targetHost.add(pairKey(scenario.target.id, scenario.host.id));
    targetMode.add(pairKey(scenario.target.id, scenario.mode.id));
    hostMode.add(pairKey(scenario.host.id, scenario.mode.id));
  }
  const targetIds = policy?.targets?.filter(isRecord).map(({ id }) => id).filter(isShortText) ?? [];
  const hostIds = policy?.hosts?.filter(isRecord).map(({ id }) => id).filter(isShortText) ?? [];
  const modeIds = policy?.modes?.filter(isRecord).map(({ id }) => id).filter(isShortText) ?? [];
  const cartesianCount = targetIds.length * hostIds.length * modeIds.length;
  return Object.freeze({
    targetHostMissing: Object.freeze(missingPairs(targetIds, hostIds, targetHost)),
    targetModeMissing: Object.freeze(missingPairs(targetIds, modeIds, targetMode)),
    hostModeMissing: Object.freeze(missingPairs(hostIds, modeIds, hostMode)),
    cartesianCount,
    scenarioCount: scenarios.length,
    cartesianFraction: cartesianCount === 0 ? 1 : scenarios.length / cartesianCount
  });
}

export function readNativeHostRiskMatrixPolicy(root) {
  const issues = [];
  const resolvedRoot = resolve(root);
  const path = join(resolvedRoot, NATIVE_HOST_RISK_MATRIX_POLICY_PATH);
  let bytes = null;
  let policy = null;
  try {
    const metadata = lstatSync(path);
    const canonicalRoot = realpathSync(resolvedRoot);
    const canonicalPath = realpathSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 ||
        metadata.size > 128 * 1024 || !canonicalPath.startsWith(`${canonicalRoot}${sep}`)) {
      issues.push("native-risk-policy.file-invalid");
    } else {
      bytes = readFileSync(canonicalPath);
      policy = JSON.parse(bytes.toString("utf8"));
    }
  } catch {
    issues.push("native-risk-policy.unreadable-or-malformed");
  }

  if (!exactKeys(policy, policyKeys)) {
    issues.push("native-risk-policy.schema-invalid");
  } else {
    validateIdentity(policy, issues);
    validateTargets(policy.targets, issues);
    validateHosts(policy.hosts, issues);
    validateModes(policy.modes, issues);
    validateThresholds(policy, issues);
    const scenarios = canonicalNativeHostScenarios(policy);
    const coverage = analyzeNativeHostPairwiseCoverage(policy, scenarios);
    if (policy.expectedScenarioCount !== scenarios.length || scenarios.length !== 70) {
      issues.push("native-risk-policy.scenario-count-invalid");
    }
    if (coverage.cartesianFraction > policy.maximumCartesianFraction ||
        coverage.targetHostMissing.length > 0 || coverage.targetModeMissing.length > 0 ||
        coverage.hostModeMissing.length > 0) {
      issues.push("native-risk-policy.pairwise-coverage-invalid");
    }
  }

  const valid = issues.length === 0;
  return Object.freeze({
    valid,
    issueCodes: Object.freeze([...new Set(issues)].sort()),
    policy: valid ? Object.freeze(policy) : null,
    sha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
    path: NATIVE_HOST_RISK_MATRIX_POLICY_PATH
  });
}

function validateIdentity(policy, issues) {
  if (policy.schemaVersion !== 1 || policy.recordType !== "lekh-native-host-risk-matrix-policy") {
    issues.push("native-risk-policy.identity-invalid");
  }
  if (policy.pairingStrategy !== "target-host-balanced-mode-pairwise") {
    issues.push("native-risk-policy.pairing-strategy-invalid");
  }
  if (policy.evidenceReusePolicy !== "one-evidence-artifact-identity-per-scenario") {
    issues.push("native-risk-policy.evidence-reuse-invalid");
  }
}

function validateTargets(targets, issues) {
  if (!sortedById(targets) || targets.length !== 10 || targets.some((target) => {
    if (!exactKeys(target, targetKeys) || !isSlug(target.id)) return true;
    if (!["macOS", "Windows"].includes(target.osFamily)) return true;
    if (!["arm64", "x86_64"].includes(target.architecture)) return true;
    if (!/^\d{1,2}$/u.test(target.osVersion)) return true;
    const family = target.osFamily === "macOS" ? "macos" : "windows";
    return target.id !== `${family}-${target.osVersion}-${target.architecture}`;
  })) {
    issues.push("native-risk-policy.targets-invalid");
    return;
  }
  const identities = targets.map(({ osFamily, osVersion, architecture }) =>
    `${osFamily}\0${osVersion}\0${architecture}`
  );
  if (new Set(identities).size !== identities.length ||
      !targets.some(({ osFamily }) => osFamily === "macOS") ||
      !targets.some(({ osFamily }) => osFamily === "Windows") ||
      !targets.some(({ architecture }) => architecture === "arm64") ||
      !targets.some(({ architecture }) => architecture === "x86_64")) {
    issues.push("native-risk-policy.target-coverage-invalid");
  }
}

function validateHosts(hosts, issues) {
  if (!sortedById(hosts) || hosts.length !== REQUIRED_HOST_IDS.length ||
      JSON.stringify(hosts.map(({ id }) => id)) !== JSON.stringify(REQUIRED_HOST_IDS) ||
      hosts.some((host) => !exactKeys(host, hostKeys) || !isSlug(host.id) ||
        !isShortText(host.label) ||
        !exactKeys(host.applicationByPlatform, ["Windows", "macOS"].sort()) ||
        !isShortText(host.applicationByPlatform.macOS) ||
        !isShortText(host.applicationByPlatform.Windows) ||
        !sortedUniqueStrings(host.riskCases) || host.riskCases.length < 3 ||
        host.riskCases.some((risk) => !isSlug(risk)))) {
    issues.push("native-risk-policy.hosts-invalid");
  }
}

function validateModes(modes, issues) {
  if (!sortedById(modes) || modes.length !== REQUIRED_MODE_IDS.length ||
      JSON.stringify(modes.map(({ id }) => id)) !== JSON.stringify(REQUIRED_MODE_IDS) ||
      modes.some((mode) => !exactKeys(mode, modeKeys) || !isSlug(mode.id) || !isShortText(mode.label))) {
    issues.push("native-risk-policy.modes-invalid");
  }
}

function validateThresholds(policy, issues) {
  if (policy.maximumCartesianFraction !== 0.25 || policy.productionPassRate !== 1 ||
      !exactKeys(policy.maximumOpenDefects, ["P0", "P1"]) ||
      policy.maximumOpenDefects.P0 !== 0 || policy.maximumOpenDefects.P1 !== 0) {
    issues.push("native-risk-policy.thresholds-invalid");
  }
}
