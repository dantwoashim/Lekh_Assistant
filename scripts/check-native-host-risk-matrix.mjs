#!/usr/bin/env node
import {
  analyzeNativeHostPairwiseCoverage,
  canonicalNativeHostScenarios,
  readNativeHostRiskMatrixPolicy
} from "./lib/native-host-risk-matrix.mjs";

const result = readNativeHostRiskMatrixPolicy(process.cwd());
if (!result.valid) {
  console.error(JSON.stringify({
    status: "failed-native-host-risk-policy",
    policy: result.path,
    issueCodes: result.issueCodes
  }, null, 2));
  process.exit(1);
}

const scenarios = canonicalNativeHostScenarios(result.policy);
const coverage = analyzeNativeHostPairwiseCoverage(result.policy, scenarios);
console.log(JSON.stringify({
  status: "passed-native-host-risk-contract",
  policy: result.path,
  policySha256: result.sha256,
  pairingStrategy: result.policy.pairingStrategy,
  scenarioCount: coverage.scenarioCount,
  fullCartesianCount: coverage.cartesianCount,
  cartesianFraction: coverage.cartesianFraction,
  pairwiseCoverage: {
    targetHostMissing: coverage.targetHostMissing.length,
    targetModeMissing: coverage.targetModeMissing.length,
    hostModeMissing: coverage.hostModeMissing.length
  },
  productionEvidence: "required-separately"
}, null, 2));
