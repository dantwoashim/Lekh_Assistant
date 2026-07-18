// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCompanionController } from "./useCompanionController";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const preferences: LekhNativePreferences = {
  nativeTypingMode: "romanized-traditional",
  inlinePreviewEnabled: true,
  customCandidatePanelEnabled: true,
  proofreadAsYouTypeEnabled: true,
  smartPunctuationEnabled: true,
  personalizationEnabled: true,
  nextWordPredictionEnabled: true,
  excludedApplicationBundleIdentifiers: []
};

const status: LekhNativeStatus = {
  platform: "darwin",
  installed: true,
  enabled: true,
  selected: true,
  version: "0.1.0",
  bundlePath: "/Users/test/Library/Input Methods/Lekh Keyboard.app",
  releaseSigned: false
};

function copyPreferences(
  source: LekhNativePreferences,
  patch: Partial<LekhNativePreferences> = {}
): LekhNativePreferences {
  return {
    ...source,
    ...patch,
    excludedApplicationBundleIdentifiers: patch.excludedApplicationBundleIdentifiers
      ? [...patch.excludedApplicationBundleIdentifiers]
      : [...source.excludedApplicationBundleIdentifiers]
  };
}

function installBridge() {
  let persistedPreferences = copyPreferences(preferences);
  const bridge: NonNullable<Window["lekhDesktop"]> = {
    kind: "companion",
    platform: "darwin",
    arch: "arm64",
    versions: { app: "0.1.0" },
    productBoundary: "Native IMK handles keystrokes.",
    getStatus: vi.fn().mockResolvedValue(status),
    readPreferences: vi.fn().mockImplementation(async () => (
      copyPreferences(persistedPreferences)
    )),
    updatePreferences: vi.fn().mockImplementation(async (patch) => {
      persistedPreferences = copyPreferences(persistedPreferences, patch);
      return { ok: true };
    }),
    openKeyboardSettings: vi.fn().mockResolvedValue({ ok: true }),
    revealInputMethod: vi.fn().mockResolvedValue({ ok: true, error: null }),
    chooseExcludedApplications: vi.fn().mockResolvedValue([]),
    checkForUpdates: vi.fn().mockResolvedValue({ status: "current", message: "Current" }),
    downloadVerifiedUpdate: vi.fn().mockResolvedValue({ ok: true, version: "0.1.0" })
  };
  window.lekhDesktop = bridge;
  return bridge;
}

async function renderReadyController() {
  const bridge = installBridge();
  const rendered = renderHook(() => useCompanionController());
  await waitFor(() => expect(rendered.result.current.state.kind).toBe("ready"));
  return { bridge, ...rendered };
}

describe("companion controller", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete window.lekhDesktop;
    window.localStorage.clear();
  });

  it("loads native status and preferences as one ready snapshot", async () => {
    const { bridge, result } = await renderReadyController();

    expect(bridge.getStatus).toHaveBeenCalledOnce();
    expect(bridge.readPreferences).toHaveBeenCalledOnce();
    expect(result.current.state).toEqual({ kind: "ready", status, preferences });
  });

  it("survives blocked storage and reports failed persistence without blanking", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const bridge = installBridge();
    const { result } = renderHook(() => useCompanionController());
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));

    expect(result.current.locale).toBe("en");
    expect(result.current.activeSection).toBe("typing");
    expect(bridge.getStatus).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    let persisted = true;
    act(() => {
      persisted = result.current.chooseLocale("ne");
    });
    expect(persisted).toBe(false);
    expect(result.current.locale).toBe("ne");
  });

  it("lets only the newest overlapping refresh publish native truth", async () => {
    const { bridge, result } = await renderReadyController();
    const oldStatus = deferred<LekhNativeStatus>();
    const oldPreferences = deferred<LekhNativePreferences>();
    const newStatus = deferred<LekhNativeStatus>();
    const newPreferences = deferred<LekhNativePreferences>();
    vi.mocked(bridge.getStatus)
      .mockReset()
      .mockReturnValueOnce(oldStatus.promise)
      .mockReturnValueOnce(newStatus.promise);
    vi.mocked(bridge.readPreferences)
      .mockReset()
      .mockReturnValueOnce(oldPreferences.promise)
      .mockReturnValueOnce(newPreferences.promise);

    let older!: Promise<boolean>;
    let newer!: Promise<boolean>;
    act(() => {
      older = result.current.refresh();
      newer = result.current.refresh();
    });

    await act(async () => {
      newStatus.resolve({ ...status, version: "new" });
      newPreferences.resolve(copyPreferences(preferences, {
        inlinePreviewEnabled: false
      }));
      await newer;
    });
    expect(result.current.state.kind === "ready" && result.current.state.status.version).toBe("new");
    expect(
      result.current.state.kind === "ready"
      && result.current.state.preferences.inlinePreviewEnabled
    ).toBe(false);

    await act(async () => {
      oldStatus.resolve({ ...status, version: "old" });
      oldPreferences.resolve(copyPreferences(preferences, {
        inlinePreviewEnabled: true
      }));
      await older;
    });
    expect(result.current.state.kind === "ready" && result.current.state.status.version).toBe("new");
    expect(
      result.current.state.kind === "ready"
      && result.current.state.preferences.inlinePreviewEnabled
    ).toBe(false);
  });

  it("keeps concurrent status truth while invalidating stale preferences", async () => {
    const { bridge, result } = await renderReadyController();
    const staleStatus = deferred<LekhNativeStatus>();
    const stalePreferences = deferred<LekhNativePreferences>();
    const write = deferred<{ ok: boolean }>();
    const reconciledPreferences = deferred<LekhNativePreferences>();
    vi.mocked(bridge.getStatus).mockReset().mockReturnValueOnce(staleStatus.promise);
    vi.mocked(bridge.readPreferences)
      .mockReset()
      .mockReturnValueOnce(stalePreferences.promise)
      .mockReturnValueOnce(reconciledPreferences.promise);
    vi.mocked(bridge.updatePreferences).mockReset().mockReturnValueOnce(write.promise);

    let refreshPromise!: Promise<boolean>;
    let writePromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
      writePromise = result.current.updatePreference("inlinePreviewEnabled", false);
    });
    expect(
      result.current.state.kind === "ready"
      && result.current.state.preferences.inlinePreviewEnabled
    ).toBe(false);

    await act(async () => {
      staleStatus.resolve({ ...status, version: "stale" });
      stalePreferences.resolve(copyPreferences(preferences));
      await refreshPromise;
    });
    expect(result.current.state.kind === "ready" && result.current.state.status.version).toBe("stale");
    expect(
      result.current.state.kind === "ready"
      && result.current.state.preferences.inlinePreviewEnabled
    ).toBe(false);

    await waitFor(() => expect(bridge.updatePreferences).toHaveBeenCalledOnce());
    write.resolve({ ok: true });
    await waitFor(() => expect(bridge.readPreferences).toHaveBeenCalledTimes(2));
    reconciledPreferences.resolve(copyPreferences(preferences, {
      inlinePreviewEnabled: false
    }));
    await act(async () => writePromise);
    expect(
      result.current.state.kind === "ready"
      && result.current.state.preferences.inlinePreviewEnabled
    ).toBe(false);
  });

  it("retains a native selected-state change from a refresh started during a write", async () => {
    const { bridge, result } = await renderReadyController();
    const write = deferred<{ ok: boolean }>();
    const changedStatus = deferred<LekhNativeStatus>();
    const staleRefreshPreferences = deferred<LekhNativePreferences>();
    const reconciledPreferences = deferred<LekhNativePreferences>();
    vi.mocked(bridge.updatePreferences).mockReset().mockReturnValueOnce(write.promise);
    vi.mocked(bridge.getStatus).mockReset().mockReturnValueOnce(changedStatus.promise);
    vi.mocked(bridge.readPreferences)
      .mockReset()
      .mockReturnValueOnce(staleRefreshPreferences.promise)
      .mockReturnValueOnce(reconciledPreferences.promise);

    let writePromise!: Promise<void>;
    act(() => {
      writePromise = result.current.updatePreference("inlinePreviewEnabled", false);
    });
    await waitFor(() => expect(bridge.updatePreferences).toHaveBeenCalledOnce());

    let refreshPromise!: Promise<boolean>;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    await waitFor(() => expect(bridge.getStatus).toHaveBeenCalledOnce());

    changedStatus.resolve({ ...status, selected: false });
    await waitFor(() => {
      expect(result.current.state.kind === "ready" && result.current.state.status.selected).toBe(false);
    });

    write.resolve({ ok: true });
    await waitFor(() => expect(bridge.readPreferences).toHaveBeenCalledTimes(2));
    await act(async () => {
      staleRefreshPreferences.resolve(copyPreferences(preferences));
      await refreshPromise;
    });
    expect(result.current.state.kind === "ready" && result.current.state.status.selected).toBe(false);

    reconciledPreferences.resolve(copyPreferences(preferences, {
      inlinePreviewEnabled: false
    }));
    await act(async () => writePromise);

    expect(result.current.state.kind === "ready" && result.current.state.status.selected).toBe(false);
    expect(
      result.current.state.kind === "ready"
      && result.current.state.preferences.inlinePreviewEnabled
    ).toBe(false);
  });

  it("clears a stale active claim when status refresh fails during a write", async () => {
    const { bridge, result } = await renderReadyController();
    const write = deferred<{ ok: boolean }>();
    const failedStatus = deferred<LekhNativeStatus>();
    const refreshPreferences = deferred<LekhNativePreferences>();
    const reconciledPreferences = deferred<LekhNativePreferences>();
    vi.mocked(bridge.updatePreferences).mockReset().mockReturnValueOnce(write.promise);
    vi.mocked(bridge.getStatus).mockReset().mockReturnValueOnce(failedStatus.promise);
    vi.mocked(bridge.readPreferences)
      .mockReset()
      .mockReturnValueOnce(refreshPreferences.promise)
      .mockReturnValueOnce(reconciledPreferences.promise);

    let writePromise!: Promise<void>;
    act(() => {
      writePromise = result.current.updatePreference("inlinePreviewEnabled", false);
    });
    await waitFor(() => expect(bridge.updatePreferences).toHaveBeenCalledOnce());

    let refreshPromise!: Promise<boolean>;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    await waitFor(() => expect(bridge.getStatus).toHaveBeenCalledOnce());
    failedStatus.reject(new Error("native status unavailable"));

    await waitFor(() => {
      expect(result.current.state).toEqual({
        kind: "unavailable",
        reason: "readFailure"
      });
    });
    refreshPreferences.resolve(copyPreferences(preferences));
    await refreshPromise;

    write.resolve({ ok: true });
    await waitFor(() => expect(bridge.readPreferences).toHaveBeenCalledTimes(2));
    reconciledPreferences.resolve(copyPreferences(preferences, {
      inlinePreviewEnabled: false
    }));
    await act(async () => writePromise);

    expect(result.current.state).toEqual({
      kind: "unavailable",
      reason: "readFailure"
    });
  });

  it("reconciles same-field writes in order and prevents an older completion from winning", async () => {
    const { bridge, result } = await renderReadyController();
    const firstWrite = deferred<{ ok: boolean }>();
    const secondWrite = deferred<{ ok: boolean }>();
    const firstRead = deferred<LekhNativePreferences>();
    const secondRead = deferred<LekhNativePreferences>();
    vi.mocked(bridge.updatePreferences)
      .mockReset()
      .mockReturnValueOnce(firstWrite.promise)
      .mockReturnValueOnce(secondWrite.promise);
    vi.mocked(bridge.readPreferences)
      .mockReset()
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise);

    let firstPromise!: Promise<void>;
    let secondPromise!: Promise<void>;
    act(() => {
      firstPromise = result.current.updatePreference("inlinePreviewEnabled", false);
      secondPromise = result.current.updatePreference("inlinePreviewEnabled", true);
    });
    expect(result.current.pendingPreferences.has("inlinePreviewEnabled")).toBe(true);
    expect(
      result.current.state.kind === "ready"
      && result.current.state.preferences.inlinePreviewEnabled
    ).toBe(true);

    expect(bridge.updatePreferences).toHaveBeenCalledTimes(2);
    firstWrite.resolve({ ok: true });
    await waitFor(() => expect(bridge.readPreferences).toHaveBeenCalledTimes(1));
    firstRead.resolve(copyPreferences(preferences, { inlinePreviewEnabled: false }));
    await waitFor(() => expect(bridge.updatePreferences).toHaveBeenCalledTimes(2));
    expect(
      result.current.state.kind === "ready"
      && result.current.state.preferences.inlinePreviewEnabled
    ).toBe(true);

    secondWrite.reject(new Error("later write failed"));
    await waitFor(() => expect(bridge.readPreferences).toHaveBeenCalledTimes(2));
    secondRead.resolve(copyPreferences(preferences, { inlinePreviewEnabled: false }));
    await act(async () => Promise.all([firstPromise, secondPromise]));

    expect(result.current.pendingPreferences.has("inlinePreviewEnabled")).toBe(false);
    expect(
      result.current.state.kind === "ready"
      && result.current.state.preferences.inlinePreviewEnabled
    ).toBe(false);
    expect(result.current.notice?.tone).toBe("error");
  });

  it("reconciles exclusion writes in order while keeping the latest list visible", async () => {
    const { bridge, result } = await renderReadyController();
    const firstWrite = deferred<{ ok: boolean }>();
    const secondWrite = deferred<{ ok: boolean }>();
    const firstRead = deferred<LekhNativePreferences>();
    const secondRead = deferred<LekhNativePreferences>();
    vi.mocked(bridge.updatePreferences)
      .mockReset()
      .mockReturnValueOnce(firstWrite.promise)
      .mockReturnValueOnce(secondWrite.promise);
    vi.mocked(bridge.readPreferences)
      .mockReset()
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise);

    let firstPromise!: Promise<void>;
    let secondPromise!: Promise<void>;
    act(() => {
      firstPromise = result.current.saveExcludedApplications(["com.example.Editor"]);
      secondPromise = result.current.saveExcludedApplications(["org.example.Writer"]);
    });
    expect(
      result.current.state.kind === "ready"
      && result.current.state.preferences.excludedApplicationBundleIdentifiers
    ).toEqual(["org.example.Writer"]);

    expect(bridge.updatePreferences).toHaveBeenCalledTimes(2);
    firstWrite.resolve({ ok: true });
    await waitFor(() => expect(bridge.readPreferences).toHaveBeenCalledTimes(1));
    firstRead.resolve(copyPreferences(preferences, {
      excludedApplicationBundleIdentifiers: ["com.example.Editor"]
    }));
    await waitFor(() => expect(bridge.updatePreferences).toHaveBeenCalledTimes(2));
    expect(
      result.current.state.kind === "ready"
      && result.current.state.preferences.excludedApplicationBundleIdentifiers
    ).toEqual(["org.example.Writer"]);

    secondWrite.resolve({ ok: true });
    await waitFor(() => expect(bridge.readPreferences).toHaveBeenCalledTimes(2));
    secondRead.resolve(copyPreferences(preferences, {
      excludedApplicationBundleIdentifiers: ["org.example.Writer"]
    }));
    await act(async () => Promise.all([firstPromise, secondPromise]));

    expect(
      result.current.state.kind === "ready"
      && result.current.state.preferences.excludedApplicationBundleIdentifiers
    ).toEqual(["org.example.Writer"]);
    expect(bridge.updatePreferences).toHaveBeenNthCalledWith(1, {
      excludedApplicationBundleIdentifiers: ["com.example.Editor"]
    });
    expect(bridge.updatePreferences).toHaveBeenNthCalledWith(2, {
      excludedApplicationBundleIdentifiers: ["org.example.Writer"]
    });
  });

  it("blocks same-render double mode writes with the synchronous pending guard", async () => {
    const { bridge, result } = await renderReadyController();
    const write = deferred<{ ok: boolean }>();
    const reread = deferred<LekhNativePreferences>();
    vi.mocked(bridge.updatePreferences).mockReset().mockReturnValueOnce(write.promise);
    vi.mocked(bridge.readPreferences).mockReset().mockReturnValueOnce(reread.promise);

    let accepted!: Promise<void>;
    let blocked!: Promise<void>;
    act(() => {
      accepted = result.current.updateMode("traditional-traditional");
      blocked = result.current.updateMode("traditional-romanized");
    });

    expect(result.current.modePending).toBe(true);
    await waitFor(() => expect(bridge.updatePreferences).toHaveBeenCalledOnce());
    expect(bridge.updatePreferences).toHaveBeenCalledWith({
      nativeTypingMode: "traditional-traditional"
    });
    write.resolve({ ok: true });
    await waitFor(() => expect(bridge.readPreferences).toHaveBeenCalledOnce());
    reread.resolve(copyPreferences(preferences, {
      nativeTypingMode: "traditional-traditional"
    }));
    await act(async () => Promise.all([accepted, blocked]));

    expect(bridge.updatePreferences).toHaveBeenCalledOnce();
    expect(result.current.modePending).toBe(false);
    expect(
      result.current.state.kind === "ready"
      && result.current.state.preferences.nativeTypingMode
    ).toBe("traditional-traditional");
  });

  it("merges a delayed application dialog with exclusions current at completion", async () => {
    const { bridge, result } = await renderReadyController();
    const dialog = deferred<LekhExcludedApplication[]>();
    vi.mocked(bridge.chooseExcludedApplications).mockReset().mockReturnValueOnce(dialog.promise);

    let dialogPromise!: Promise<void>;
    act(() => {
      dialogPromise = result.current.chooseExcludedApplications();
    });
    await act(async () => {
      await result.current.saveExcludedApplications(["com.latest.Editor"]);
    });

    dialog.resolve([{
      bundleIdentifier: "org.example.Writer",
      displayName: "Writer"
    }]);
    await act(async () => dialogPromise);

    expect(bridge.updatePreferences).toHaveBeenLastCalledWith({
      excludedApplicationBundleIdentifiers: [
        "com.latest.Editor",
        "org.example.Writer"
      ]
    });
    expect(
      result.current.state.kind === "ready"
      && result.current.state.preferences.excludedApplicationBundleIdentifiers
    ).toEqual(["com.latest.Editor", "org.example.Writer"]);
    expect(result.current.applicationNames["org.example.Writer"]).toBe("Writer");
  });

  it("never publishes a refresh completion after unmount", async () => {
    const pendingStatus = deferred<LekhNativeStatus>();
    const pendingPreferences = deferred<LekhNativePreferences>();
    const bridge = installBridge();
    vi.mocked(bridge.getStatus).mockReset().mockReturnValueOnce(pendingStatus.promise);
    vi.mocked(bridge.readPreferences).mockReset().mockReturnValueOnce(pendingPreferences.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result, unmount } = renderHook(() => useCompanionController());

    expect(result.current.state.kind).toBe("loading");
    unmount();
    await act(async () => {
      pendingStatus.resolve(status);
      pendingPreferences.resolve(preferences);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state.kind).toBe("loading");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not reconcile or publish an in-flight write after unmount", async () => {
    const { bridge, result, unmount } = await renderReadyController();
    const write = deferred<{ ok: boolean }>();
    vi.mocked(bridge.updatePreferences).mockReset().mockReturnValueOnce(write.promise);
    vi.mocked(bridge.readPreferences).mockClear();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    let writePromise!: Promise<void>;
    act(() => {
      writePromise = result.current.updatePreference("inlinePreviewEnabled", false);
    });
    await waitFor(() => expect(bridge.updatePreferences).toHaveBeenCalledOnce());
    unmount();
    write.resolve({ ok: true });
    await writePromise;

    expect(bridge.readPreferences).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("dispatches every accepted queued write in order after unmount", async () => {
    const { bridge, result, unmount } = await renderReadyController();
    const firstWrite = deferred<{ ok: boolean }>();
    const secondWrite = deferred<{ ok: boolean }>();
    vi.mocked(bridge.updatePreferences)
      .mockReset()
      .mockReturnValueOnce(firstWrite.promise)
      .mockReturnValueOnce(secondWrite.promise);
    vi.mocked(bridge.readPreferences).mockClear();

    let firstPromise!: Promise<void>;
    let secondPromise!: Promise<void>;
    act(() => {
      firstPromise = result.current.updatePreference("inlinePreviewEnabled", false);
      secondPromise = result.current.updatePreference("customCandidatePanelEnabled", false);
    });
    expect(bridge.updatePreferences).toHaveBeenCalledTimes(2);
    expect(bridge.updatePreferences).toHaveBeenNthCalledWith(1, {
      inlinePreviewEnabled: false
    });
    expect(bridge.updatePreferences).toHaveBeenNthCalledWith(2, {
      customCandidatePanelEnabled: false
    });
    unmount();

    firstWrite.resolve({ ok: true });
    secondWrite.resolve({ ok: true });
    await Promise.all([firstPromise, secondPromise]);
    expect(bridge.readPreferences).not.toHaveBeenCalled();
  });

  it("deduplicates valid exclusions and never sends a partially invalid list", async () => {
    const { bridge, result } = await renderReadyController();

    await act(async () => result.current.saveExcludedApplications([
      " com.example.Editor ",
      "com.example.Editor",
      "org.example.Writer"
    ]));
    expect(bridge.updatePreferences).toHaveBeenLastCalledWith({
      excludedApplicationBundleIdentifiers: ["com.example.Editor", "org.example.Writer"]
    });

    vi.mocked(bridge.updatePreferences).mockClear();
    await act(async () => result.current.saveExcludedApplications([
      "com.example.Editor",
      "invalid identifier"
    ]));
    expect(bridge.updatePreferences).not.toHaveBeenCalled();
    expect(result.current.notice?.tone).toBe("error");
  });
});
