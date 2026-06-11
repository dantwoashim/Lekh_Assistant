import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const checks = [
  {
    file: "README.md",
    needles: [
      "The Electron/browser demo is **not** the keyboard app.",
      "The companion app is **not** the keyboard app.",
      "Preeti to Unicode is a side utility",
      "Windows: TSF text service.",
      "macOS: InputMethodKit input method."
    ]
  },
  {
    file: "electron-builder.config.cjs",
    needles: [
      'productName: "Lekh Keyboard Companion"',
      'appId: "com.lekh.keyboard.companion"'
    ]
  },
  {
    file: "docs/CURRENT_PRODUCTION_READINESS_STATUS.md",
    needles: [
      "NOT_READY_BLOCKED_BY_EXTERNAL_NATIVE_REQUIREMENTS",
      "Windows native keyboard | blocked-native-environment",
      "macOS native keyboard | partial native-dev proof",
      "Traditional physical keyboard | blocked-human",
      "production macOS IMK input method with host-app matrix evidence"
    ]
  }
];

let failed = false;

for (const check of checks) {
  const text = readFileSync(join(root, check.file), "utf8");
  for (const needle of check.needles) {
    if (!text.includes(needle)) {
      console.error(`[product-truth] ${check.file} is missing required truth marker: ${needle}`);
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log("[product-truth] Product scope markers are honest: browser demo, companion shell, native keyboard, Preeti side utility.");
