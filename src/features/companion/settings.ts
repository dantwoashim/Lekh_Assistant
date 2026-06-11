import type { KeyboardMode } from "../../engine/keyboard";
import type { SuggestionSurface, TypingContext } from "../../engine/keyboard";

export interface CompanionSettings {
  defaultMode: KeyboardMode;
  showRomanizedLabels: boolean;
  enableRomanizedHelpers: boolean;
  preserveEnglishTokens: boolean;
  candidateCount: number;
  spaceCommitBehavior: "commit-primary" | "insert-space";
  enableProofreadHints: boolean;
  proofreadAggressiveness: "conservative" | "balanced";
  enableDictionaryPanel: boolean;
  enableLocalMemory: boolean;
  pauseLearning: boolean;
  excludedMemoryApps: string[];
  enableNextWordPrediction: boolean;
  secureInputPassThrough: boolean;
  traditionalLayoutStatus: "pending-audit" | "verified";
  preetiUtilityEnabled: boolean;
  telemetryEnabled: false;
  releaseChannel: "internal-dev" | "private-pilot" | "public-beta" | "stable";
}

export const defaultCompanionSettings: CompanionSettings = {
  defaultMode: "romanized",
  showRomanizedLabels: false,
  enableRomanizedHelpers: true,
  preserveEnglishTokens: true,
  candidateCount: 8,
  spaceCommitBehavior: "insert-space",
  enableProofreadHints: true,
  proofreadAggressiveness: "conservative",
  enableDictionaryPanel: true,
  enableLocalMemory: true,
  pauseLearning: false,
  excludedMemoryApps: [],
  enableNextWordPrediction: true,
  secureInputPassThrough: true,
  traditionalLayoutStatus: "pending-audit",
  preetiUtilityEnabled: true,
  telemetryEnabled: false,
  releaseChannel: "internal-dev"
};

export type CompanionPageStatus = "usable-dev" | "blocked-human" | "blocked-native" | "blocked-external";

export interface CompanionPageDefinition {
  id: string;
  title: string;
  status: CompanionPageStatus;
  controls: string[];
}

export const companionPages: CompanionPageDefinition[] = [
  {
    id: "home",
    title: "Home/status",
    status: "usable-dev",
    controls: ["daemon health", "input method status", "current mode", "data pack version", "last error"]
  },
  {
    id: "mode",
    title: "Mode settings",
    status: "usable-dev",
    controls: ["Romanized", "Traditional", "default mode", "hotkey docs"]
  },
  {
    id: "romanized",
    title: "Romanized preferences",
    status: "usable-dev",
    controls: ["helper suggestions", "labels", "preserve English", "candidate aggressiveness"]
  },
  {
    id: "traditional",
    title: "Traditional layout settings",
    status: "blocked-human",
    controls: ["LTK-compatible layout", "standard layout", "audit status", "source-of-truth checklist"]
  },
  {
    id: "layout-preview",
    title: "Layout preview",
    status: "blocked-human",
    controls: ["pending preview", "modifier states", "capture template"]
  },
  {
    id: "candidates",
    title: "Candidate behavior",
    status: "usable-dev",
    controls: ["top count", "shortcuts", "space behavior", "expanded list"]
  },
  {
    id: "proofread",
    title: "Proofread settings",
    status: "usable-dev",
    controls: ["categories", "aggressiveness", "name protection"]
  },
  {
    id: "dictionary",
    title: "Dictionary manager",
    status: "usable-dev",
    controls: ["search", "add", "prefer", "never suggest", "import/export"]
  },
  {
    id: "memory",
    title: "Personal memory",
    status: "usable-dev",
    controls: ["view", "pin", "delete", "reset", "export/import"]
  },
  {
    id: "privacy",
    title: "Privacy",
    status: "usable-dev",
    controls: ["telemetry off", "secure input", "consent controls", "redacted diagnostics", "data deletion"]
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    status: "usable-dev",
    controls: ["IPC latency", "daemon health", "logs", "redacted export"]
  },
  {
    id: "preeti",
    title: "Preeti side utility",
    status: "usable-dev",
    controls: ["legacy conversion", "document tool entry", "secondary placement"]
  },
  {
    id: "import-export",
    title: "Import/export",
    status: "usable-dev",
    controls: ["settings export", "dictionary export", "memory export", "reset"]
  },
  {
    id: "updates",
    title: "Updates/about",
    status: "blocked-external",
    controls: ["version", "release channel", "license", "signed update path"]
  }
];

export interface CompanionSettingsExport {
  schemaVersion: 1;
  exportedAt: string;
  settings: CompanionSettings;
}

export function normalizeCompanionSettings(value: Partial<CompanionSettings> = {}): CompanionSettings {
  const candidateCount = Number.isFinite(value.candidateCount)
    ? Math.max(1, Math.min(9, Math.trunc(value.candidateCount ?? defaultCompanionSettings.candidateCount)))
    : defaultCompanionSettings.candidateCount;
  return {
    ...defaultCompanionSettings,
    ...value,
    candidateCount,
    telemetryEnabled: false,
    excludedMemoryApps: Array.isArray(value.excludedMemoryApps)
      ? Array.from(new Set(value.excludedMemoryApps.map((item) => item.trim()).filter(Boolean))).slice(0, 100)
      : defaultCompanionSettings.excludedMemoryApps
  };
}

export function exportCompanionSettings(settings: Partial<CompanionSettings>, exportedAt = new Date().toISOString()): CompanionSettingsExport {
  return {
    schemaVersion: 1,
    exportedAt,
    settings: normalizeCompanionSettings(settings)
  };
}

export function importCompanionSettings(value: unknown): CompanionSettings {
  if (!isRecord(value)) return defaultCompanionSettings;
  const settings = isRecord(value.settings) ? value.settings : value;
  return normalizeCompanionSettings(settings as Partial<CompanionSettings>);
}

export function companionSettingsToTypingContext(
  settings: Partial<CompanionSettings>,
  patch: Partial<TypingContext> = {}
): TypingContext {
  const normalized = normalizeCompanionSettings(settings);
  const enabledSurfaces: SuggestionSurface[] = [
    "romanized-to-unicode",
    ...(normalized.enableRomanizedHelpers ? ["romanized-to-romanized" as const] : []),
    ...(normalized.showRomanizedLabels ? ["romanized-to-unicode-with-labels" as const] : []),
    "traditional-to-unicode",
    "traditional-to-romanized-helper",
    "traditional-to-traditional-proofread"
  ];
  const appName = patch.appName ?? "";
  const appId = patch.appId ?? "";
  const appExcluded = normalized.excludedMemoryApps.some((item) => {
    const needle = item.toLowerCase();
    return appName.toLowerCase().includes(needle) || appId.toLowerCase().includes(needle);
  });
  const secureInput = Boolean(patch.secureInput || patch.fieldType === "password" || patch.fieldType === "code" || !normalized.enableLocalMemory || normalized.pauseLearning || appExcluded);

  return {
    leftTextWindow: "",
    rightTextWindow: "",
    activeDomains: [],
    locale: "ne-NP",
    ...patch,
    mode: patch.mode ?? normalized.defaultMode,
    preserveEnglish: normalized.preserveEnglishTokens,
    secureInput,
    enabledSurfaces,
    showRomanizedLabels: normalized.showRomanizedLabels,
    enableNextWordPrediction: normalized.enableNextWordPrediction,
    layoutId: normalized.traditionalLayoutStatus === "verified" ? "traditional-ltk-compatible" : "traditional-ltk-compatible.pending"
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
