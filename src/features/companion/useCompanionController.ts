import { useCallback, useEffect, useRef, useState } from "react";

import {
  copyByLocale,
  type BooleanPreferenceKey,
  type CompanionLocale,
  type CompanionSection
} from "./companionCopy";
import {
  detectCompanionLocale,
  detectCompanionSection,
  normalizeApplicationIdentifiers,
  persistCompanionLocale,
  persistCompanionSection,
  type CompanionLoadState
} from "./companionModel";

export type CompanionNoticeTone = "success" | "error" | "neutral";

export interface CompanionNotice {
  message: string;
  tone: CompanionNoticeTone;
}

export type WindowsAction = "repair" | "restart" | "startup";

type PreferenceKey = keyof LekhNativePreferences;
type PreferenceValue = LekhNativePreferences[PreferenceKey];

interface PendingPreference {
  revision: number;
  value: PreferenceValue;
}

function clonePreferenceValue(value: PreferenceValue): PreferenceValue {
  return Array.isArray(value) ? [...value] : value;
}

function clonePreferences(preferences: LekhNativePreferences): LekhNativePreferences {
  return {
    ...preferences,
    excludedApplicationBundleIdentifiers: [
      ...preferences.excludedApplicationBundleIdentifiers
    ]
  };
}

function withPreference(
  preferences: LekhNativePreferences,
  key: PreferenceKey,
  value: PreferenceValue
): LekhNativePreferences {
  return {
    ...preferences,
    [key]: clonePreferenceValue(value)
  } as LekhNativePreferences;
}

function mergePendingPreferences(
  preferences: LekhNativePreferences,
  pending: ReadonlyMap<PreferenceKey, PendingPreference>
): LekhNativePreferences {
  let merged = clonePreferences(preferences);
  for (const [key, entry] of pending) {
    merged = withPreference(merged, key, entry.value);
  }
  return merged;
}

export function useCompanionController() {
  const [locale, setLocale] = useState<CompanionLocale>(() => detectCompanionLocale());
  const [activeSection, setActiveSection] = useState<CompanionSection>(() => detectCompanionSection());
  const [state, setState] = useState<CompanionLoadState>({ kind: "loading" });
  const [pendingPreferences, setPendingPreferences] = useState<Set<BooleanPreferenceKey>>(new Set());
  const [modePending, setModePending] = useState(false);
  const [notice, setNotice] = useState<CompanionNotice | null>(null);
  const [updateStatus, setUpdateStatus] = useState<LekhUpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [windowsActionBusy, setWindowsActionBusy] = useState<WindowsAction | null>(null);
  const [manualIdentifier, setManualIdentifierState] = useState("");
  const [applicationNames, setApplicationNames] = useState<Record<string, string>>({});
  const [demoSequence, setDemoSequence] = useState(0);

  const mountedRef = useRef(false);
  const stateRef = useRef<CompanionLoadState>({ kind: "loading" });
  const authoritativeStatusRef = useRef<LekhNativeStatus | null>(null);
  const authoritativePreferencesRef = useRef<LekhNativePreferences | null>(null);
  const pendingValuesRef = useRef<Map<PreferenceKey, PendingPreference>>(new Map());
  const latestRevisionByKeyRef = useRef<Map<PreferenceKey, number>>(new Map());
  const pendingBooleanRevisionsRef = useRef<Map<BooleanPreferenceKey, number>>(new Map());
  const revisionCounterRef = useRef(0);
  const mutationEpochRef = useRef(0);
  const reconciliationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const modePendingRef = useRef(false);
  const statusGenerationRef = useRef(0);
  const preferencesGenerationRef = useRef(0);
  const updateGenerationRef = useRef(0);
  const windowsActionBusyRef = useRef<WindowsAction | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const copy = copyByLocale[locale];

  const publishState = useCallback((nextState: CompanionLoadState) => {
    if (!mountedRef.current) return;
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  const publishReadyState = useCallback(() => {
    const status = authoritativeStatusRef.current;
    const preferences = authoritativePreferencesRef.current;
    if (!status || !preferences) return;
    publishState({
      kind: "ready",
      status,
      preferences: mergePendingPreferences(preferences, pendingValuesRef.current)
    });
  }, [publishState]);

  const invalidatePreferenceRefreshes = useCallback(() => {
    mutationEpochRef.current += 1;
    preferencesGenerationRef.current += 1;
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    const statusGeneration = ++statusGenerationRef.current;
    const preferencesGeneration = ++preferencesGenerationRef.current;
    const mutationEpoch = mutationEpochRef.current;
    const bridge = window.lekhDesktop;
    if (!bridge) {
      if (
        mountedRef.current
        && statusGeneration === statusGenerationRef.current
        && preferencesGeneration === preferencesGenerationRef.current
        && mutationEpoch === mutationEpochRef.current
      ) {
        authoritativeStatusRef.current = null;
        authoritativePreferencesRef.current = null;
        publishState({ kind: "unavailable", reason: "noBridge" });
      }
      return false;
    }

    type RefreshOutcome = "applied" | "failed" | "stale";
    const statusTask: Promise<RefreshOutcome> = Promise.resolve()
      .then(() => bridge.getStatus())
      .then(
        (status) => {
          if (!mountedRef.current || statusGeneration !== statusGenerationRef.current) {
            return "stale";
          }
          authoritativeStatusRef.current = status;
          publishReadyState();
          return "applied";
        },
        () => {
          if (!mountedRef.current || statusGeneration !== statusGenerationRef.current) {
            return "stale";
          }
          authoritativeStatusRef.current = null;
          publishState({ kind: "unavailable", reason: "readFailure" });
          return "failed";
        }
      );
    const preferencesTask: Promise<RefreshOutcome> = Promise.resolve()
      .then(() => bridge.readPreferences())
      .then(
        (preferences) => {
          if (
            !mountedRef.current
            || preferencesGeneration !== preferencesGenerationRef.current
            || mutationEpoch !== mutationEpochRef.current
          ) {
            return "stale";
          }
          authoritativePreferencesRef.current = clonePreferences(preferences);
          publishReadyState();
          return "applied";
        },
        () => (
          mountedRef.current
          && preferencesGeneration === preferencesGenerationRef.current
          && mutationEpoch === mutationEpochRef.current
            ? "failed"
            : "stale"
        )
      );
    const [statusOutcome, preferencesOutcome] = await Promise.all([
      statusTask,
      preferencesTask
    ]);
    if (!mountedRef.current) return false;

    const currentStatusFailed = (
      statusOutcome === "failed"
      && statusGeneration === statusGenerationRef.current
    );
    const currentPreferencesFailed = (
      preferencesOutcome === "failed"
      && preferencesGeneration === preferencesGenerationRef.current
      && mutationEpoch === mutationEpochRef.current
    );
    if (currentStatusFailed) {
      authoritativeStatusRef.current = null;
      publishState({ kind: "unavailable", reason: "readFailure" });
      return false;
    }
    if (currentPreferencesFailed && pendingValuesRef.current.size === 0) {
      publishState({ kind: "unavailable", reason: "readFailure" });
      return false;
    }
    return statusOutcome === "applied" && preferencesOutcome === "applied";
  }, [publishReadyState, publishState]);

  const showNotice = useCallback((message: string, tone: CompanionNoticeTone = "neutral") => {
    if (!mountedRef.current) return;
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice({ message, tone });
    noticeTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setNotice(null);
    }, 3200);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      mountedRef.current = false;
      statusGenerationRef.current += 1;
      preferencesGenerationRef.current += 1;
      updateGenerationRef.current += 1;
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    const isWindows = window.lekhDesktop?.platform === "win32";
    const needsRefresh = isWindows
      ? !state.status.registered || !state.status.serviceHealthy
      : !state.status.selected;
    if (!needsRefresh) return;
    const interval = window.setInterval(() => void refresh(), isWindows ? 6000 : 4000);
    return () => window.clearInterval(interval);
  }, [refresh, state]);

  function chooseLocale(nextLocale: CompanionLocale): boolean {
    if (!mountedRef.current) return false;
    const persisted = persistCompanionLocale(nextLocale);
    setLocale(nextLocale);
    return persisted;
  }

  function chooseSection(section: CompanionSection): boolean {
    if (!mountedRef.current) return false;
    const persisted = persistCompanionSection(section);
    setActiveSection(section);
    return persisted;
  }

  function enqueueReconciliation(task: () => Promise<void>): Promise<void> {
    const completion = reconciliationQueueRef.current.then(task);
    reconciliationQueueRef.current = completion.catch(() => undefined);
    return completion;
  }

  function syncPendingBooleanPreferences() {
    if (!mountedRef.current) return;
    setPendingPreferences(new Set(pendingBooleanRevisionsRef.current.keys()));
  }

  function schedulePreferenceMutation(
    bridge: NonNullable<Window["lekhDesktop"]>,
    key: PreferenceKey,
    value: PreferenceValue,
    successMessage: string,
    failureMessage: string,
    onScheduled?: (revision: number) => void,
    onSettled?: () => void
  ): Promise<void> {
    const revision = ++revisionCounterRef.current;
    const currentState = stateRef.current;
    if (!authoritativePreferencesRef.current && currentState.kind === "ready") {
      authoritativePreferencesRef.current = clonePreferences(currentState.preferences);
    }
    latestRevisionByKeyRef.current.set(key, revision);
    pendingValuesRef.current.set(key, {
      revision,
      value: clonePreferenceValue(value)
    });
    onScheduled?.(revision);
    invalidatePreferenceRefreshes();
    publishReadyState();

    let dispatchedWrite: Promise<boolean>;
    try {
      dispatchedWrite = bridge.updatePreferences({
        [key]: clonePreferenceValue(value)
      } as Partial<LekhNativePreferences>).then(
        (result) => result.ok === true,
        () => false
      );
    } catch {
      dispatchedWrite = Promise.resolve(false);
    }

    return enqueueReconciliation(async () => {
      const succeeded = await dispatchedWrite;
      if (!mountedRef.current) return;
      invalidatePreferenceRefreshes();

      let rereadPreferences: LekhNativePreferences | null = null;
      try {
        rereadPreferences = await bridge.readPreferences();
      } catch {
        rereadPreferences = null;
      }
      if (!mountedRef.current) return;

      if (rereadPreferences) {
        authoritativePreferencesRef.current = clonePreferences(rereadPreferences);
      } else if (succeeded && authoritativePreferencesRef.current) {
        authoritativePreferencesRef.current = withPreference(
          authoritativePreferencesRef.current,
          key,
          value
        );
      }

      const isCurrentRevision = latestRevisionByKeyRef.current.get(key) === revision;
      if (isCurrentRevision) {
        latestRevisionByKeyRef.current.delete(key);
        pendingValuesRef.current.delete(key);
        onSettled?.();
      }
      invalidatePreferenceRefreshes();
      publishReadyState();

      if (isCurrentRevision) {
        showNotice(
          succeeded ? successMessage : failureMessage,
          succeeded ? "success" : "error"
        );
      }
    });
  }

  function updatePreference(
    key: BooleanPreferenceKey,
    value: boolean
  ): Promise<void> {
    const bridge = window.lekhDesktop;
    if (stateRef.current.kind !== "ready" || !bridge || !mountedRef.current) {
      return Promise.resolve();
    }
    return schedulePreferenceMutation(
      bridge,
      key,
      value,
      copy.saved,
      copy.saveError,
      (revision) => {
        pendingBooleanRevisionsRef.current.set(key, revision);
        syncPendingBooleanPreferences();
      },
      () => {
        pendingBooleanRevisionsRef.current.delete(key);
        syncPendingBooleanPreferences();
      }
    );
  }

  function updateMode(
    nativeTypingMode: LekhNativePreferences["nativeTypingMode"]
  ): Promise<void> {
    const bridge = window.lekhDesktop;
    if (
      stateRef.current.kind !== "ready"
      || !bridge
      || !mountedRef.current
      || modePendingRef.current
    ) {
      return Promise.resolve();
    }
    modePendingRef.current = true;
    setModePending(true);
    return schedulePreferenceMutation(
      bridge,
      "nativeTypingMode",
      nativeTypingMode,
      copy.savedMode,
      copy.saveError,
      undefined,
      () => {
        modePendingRef.current = false;
        if (mountedRef.current) setModePending(false);
      }
    );
  }

  function saveExcludedApplications(identifiers: string[]): Promise<void> {
    const bridge = window.lekhDesktop;
    if (stateRef.current.kind !== "ready" || !bridge || !mountedRef.current) {
      return Promise.resolve();
    }
    const unique = normalizeApplicationIdentifiers(identifiers);
    if (!unique) {
      showNotice(copy.excludedError, "error");
      return Promise.resolve();
    }
    return schedulePreferenceMutation(
      bridge,
      "excludedApplicationBundleIdentifiers",
      unique,
      copy.excludedSaved,
      copy.excludedError
    );
  }

  async function chooseExcludedApplications(): Promise<void> {
    const bridge = window.lekhDesktop;
    if (stateRef.current.kind !== "ready" || !bridge || !mountedRef.current) return;

    let selected: LekhExcludedApplication[];
    try {
      selected = await bridge.chooseExcludedApplications();
    } catch {
      if (mountedRef.current) showNotice(copy.excludedError, "error");
      return;
    }
    if (!mountedRef.current || selected.length === 0) return;

    setApplicationNames((current) => ({
      ...current,
      ...Object.fromEntries(selected.map((application) => [
        application.bundleIdentifier,
        application.displayName
      ]))
    }));
    const currentState = stateRef.current;
    if (currentState.kind !== "ready") return;
    await saveExcludedApplications([
      ...currentState.preferences.excludedApplicationBundleIdentifiers,
      ...selected.map((application) => application.bundleIdentifier)
    ]);
  }

  function addManualIdentifier() {
    const currentState = stateRef.current;
    if (currentState.kind !== "ready" || !mountedRef.current) return;
    const identifier = normalizeApplicationIdentifiers([manualIdentifier])?.[0];
    if (!identifier) {
      showNotice(copy.excludedError, "error");
      return;
    }
    setManualIdentifierState("");
    void saveExcludedApplications([
      ...currentState.preferences.excludedApplicationBundleIdentifiers,
      identifier
    ]);
  }

  async function checkForUpdates() {
    const bridge = window.lekhDesktop;
    if (!bridge || !mountedRef.current) return;
    const generation = ++updateGenerationRef.current;
    setUpdateBusy(true);
    try {
      const nextStatus = await bridge.checkForUpdates();
      if (!mountedRef.current || generation !== updateGenerationRef.current) return;
      setUpdateStatus(nextStatus);
    } catch {
      if (!mountedRef.current || generation !== updateGenerationRef.current) return;
      setUpdateStatus({ status: "disabled", message: copy.signedFeedFailed });
    } finally {
      if (mountedRef.current && generation === updateGenerationRef.current) {
        setUpdateBusy(false);
      }
    }
  }

  async function downloadUpdate() {
    const bridge = window.lekhDesktop;
    if (!bridge || !mountedRef.current) return;
    const generation = ++updateGenerationRef.current;
    setUpdateBusy(true);
    try {
      const result = await bridge.downloadVerifiedUpdate();
      if (!mountedRef.current || generation !== updateGenerationRef.current) return;
      setUpdateStatus({
        status: "current",
        message: copy.updateVerified(result.version)
      });
    } catch {
      if (!mountedRef.current || generation !== updateGenerationRef.current) return;
      setUpdateStatus({ status: "disabled", message: copy.updateArchiveFailed });
    } finally {
      if (mountedRef.current && generation === updateGenerationRef.current) {
        setUpdateBusy(false);
      }
    }
  }

  async function repairWindowsInstallation() {
    const bridge = window.lekhDesktop;
    if (!bridge || !mountedRef.current || windowsActionBusyRef.current) return;
    windowsActionBusyRef.current = "repair";
    setWindowsActionBusy("repair");
    try {
      const result = await bridge.repairWindowsInstallation();
      if (!mountedRef.current) return;
      if (!result.ok) throw new Error("Windows registration repair failed.");
      authoritativeStatusRef.current = result.status;
      publishReadyState();
      showNotice(copy.windows.repairSucceeded, "success");
      await refresh();
    } catch {
      if (mountedRef.current) showNotice(copy.windows.actionFailed, "error");
    } finally {
      windowsActionBusyRef.current = null;
      if (mountedRef.current) setWindowsActionBusy(null);
    }
  }

  async function restartWindowsService() {
    const bridge = window.lekhDesktop;
    if (!bridge || !mountedRef.current || windowsActionBusyRef.current) return;
    windowsActionBusyRef.current = "restart";
    setWindowsActionBusy("restart");
    try {
      const result = await bridge.restartWindowsService();
      if (!result.ok) throw new Error("Windows typing service restart failed.");
      if (!mountedRef.current) return;
      showNotice(copy.windows.restartSucceeded, "success");
      await refresh();
    } catch {
      if (mountedRef.current) showNotice(copy.windows.actionFailed, "error");
    } finally {
      windowsActionBusyRef.current = null;
      if (mountedRef.current) setWindowsActionBusy(null);
    }
  }

  async function setWindowsStartup(enabled: boolean) {
    const bridge = window.lekhDesktop;
    if (!bridge || !mountedRef.current || windowsActionBusyRef.current) return;
    windowsActionBusyRef.current = "startup";
    setWindowsActionBusy("startup");
    try {
      const result = await bridge.setWindowsStartupEnabled(enabled);
      if (!result.ok) throw new Error("Windows run-at-sign-in update failed.");
      if (!mountedRef.current) return;
      showNotice(
        result.enabled ? copy.windows.startupEnabled : copy.windows.startupDisabled,
        "success"
      );
      await refresh();
    } catch {
      if (mountedRef.current) showNotice(copy.windows.actionFailed, "error");
    } finally {
      windowsActionBusyRef.current = null;
      if (mountedRef.current) setWindowsActionBusy(null);
    }
  }

  return {
    activeSection,
    addManualIdentifier,
    applicationNames,
    checkForUpdates,
    chooseExcludedApplications,
    chooseLocale,
    chooseSection,
    copy,
    demoSequence,
    downloadUpdate,
    locale,
    manualIdentifier,
    modePending,
    notice,
    pendingPreferences,
    refresh,
    repairWindowsInstallation,
    replayDemo: () => {
      if (mountedRef.current) setDemoSequence((value) => value + 1);
    },
    saveExcludedApplications,
    restartWindowsService,
    setManualIdentifier: (value: string) => {
      if (mountedRef.current) setManualIdentifierState(value);
    },
    state,
    setWindowsStartup,
    updateBusy,
    updateMode,
    updatePreference,
    updateStatus,
    windowsActionBusy
  };
}
