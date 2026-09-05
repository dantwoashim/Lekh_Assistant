/// <reference types="vite/client" />

declare module "*?raw" {
  const content: string;
  export default content;
}

declare module "nspell" {
  export interface NSpell {
    correct(word: string): boolean;
    suggest(word: string): string[];
  }

  export default function nspell(dictionary: { aff: string; dic: string }): NSpell;
}

interface LekhNativeStatus {
  platform: string;
  installed: boolean;
  enabled: boolean;
  selected: boolean;
  version: string | null;
  bundlePath: string | null;
  releaseSigned: boolean | null;
  registered?: boolean;
  registrationPathMatches?: boolean;
  registrationIssues?: string[];
  compatibilityRegistered?: boolean;
  compatibilityPathMatches?: boolean;
  serviceHealthy?: boolean;
  serviceLatencyMs?: number;
  serviceIssue?: string | null;
  serviceProcessRunning?: boolean;
  startupEnabled?: boolean;
  startupCanChange?: boolean;
  repairAvailable?: boolean;
}

interface LekhNativePreferences {
  nativeTypingMode:
    | "romanized-romanized"
    | "romanized-traditional"
    | "traditional-traditional"
    | "traditional-romanized";
  inlinePreviewEnabled: boolean;
  customCandidatePanelEnabled: boolean;
  proofreadAsYouTypeEnabled: boolean;
  smartPunctuationEnabled: boolean;
  personalizationEnabled: boolean;
  nextWordPredictionEnabled: boolean;
  excludedApplicationBundleIdentifiers: string[];
}

interface LekhUpdateStatus {
  status: "disabled" | "available" | "current";
  message: string;
  currentVersion?: string;
  version?: string;
  build?: string;
}

interface LekhExcludedApplication {
  bundleIdentifier: string;
  displayName: string;
}

interface Window {
  lekhDesktop?: {
    kind: "companion";
    platform: string;
    arch: string;
    versions: { app: string };
    productBoundary: string;
    getStatus(): Promise<LekhNativeStatus>;
    readPreferences(): Promise<LekhNativePreferences>;
    updatePreferences(patch: Partial<LekhNativePreferences>): Promise<{ ok: boolean }>;
    openKeyboardSettings(): Promise<{ ok: boolean }>;
    revealInputMethod(): Promise<{ ok: boolean; error: string | null }>;
    chooseExcludedApplications(): Promise<LekhExcludedApplication[]>;
    repairWindowsInstallation(): Promise<{ ok: boolean; status: LekhNativeStatus }>;
    restartWindowsService(): Promise<{ ok: boolean }>;
    setWindowsStartupEnabled(enabled: boolean): Promise<{ ok: boolean; enabled: boolean }>;
    checkForUpdates(): Promise<LekhUpdateStatus>;
    downloadVerifiedUpdate(): Promise<{ ok: boolean; version: string }>;
  };
}
