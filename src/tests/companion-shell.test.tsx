// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app/App";

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

const readyStatus: LekhNativeStatus = {
  platform: "darwin",
  installed: true,
  enabled: true,
  selected: false,
  version: "0.1.0",
  bundlePath: "/Users/test/Library/Input Methods/Lekh Keyboard.app",
  releaseSigned: false
};

function installBridge({
  status = readyStatus,
  nativePreferences = preferences,
  chosenApplications = [],
  platform = "darwin"
}: {
  status?: LekhNativeStatus;
  nativePreferences?: LekhNativePreferences;
  chosenApplications?: LekhExcludedApplication[];
  platform?: string;
} = {}) {
  let persistedPreferences: LekhNativePreferences = {
    ...nativePreferences,
    excludedApplicationBundleIdentifiers: [
      ...nativePreferences.excludedApplicationBundleIdentifiers
    ]
  };
  const bridge: NonNullable<Window["lekhDesktop"]> = {
    kind: "companion",
    platform,
    arch: "arm64",
    versions: { app: "0.1.0" },
    productBoundary: "Native IMK handles keystrokes.",
    getStatus: vi.fn().mockResolvedValue(status),
    readPreferences: vi.fn().mockImplementation(async () => ({
      ...persistedPreferences,
      excludedApplicationBundleIdentifiers: [
        ...persistedPreferences.excludedApplicationBundleIdentifiers
      ]
    })),
    updatePreferences: vi.fn().mockImplementation(async (patch) => {
      persistedPreferences = {
        ...persistedPreferences,
        ...patch,
        excludedApplicationBundleIdentifiers: patch.excludedApplicationBundleIdentifiers
          ? [...patch.excludedApplicationBundleIdentifiers]
          : persistedPreferences.excludedApplicationBundleIdentifiers
      };
      return { ok: true };
    }),
    openKeyboardSettings: vi.fn().mockResolvedValue({ ok: true }),
    revealInputMethod: vi.fn().mockResolvedValue({ ok: true, error: null }),
    chooseExcludedApplications: vi.fn().mockResolvedValue(chosenApplications),
    repairWindowsInstallation: vi.fn().mockResolvedValue({ ok: true, status }),
    restartWindowsService: vi.fn().mockResolvedValue({ ok: true }),
    setWindowsStartupEnabled: vi.fn().mockResolvedValue({ ok: true, enabled: true }),
    checkForUpdates: vi.fn().mockResolvedValue({ status: "current", message: "Lekh is up to date." }),
    downloadVerifiedUpdate: vi.fn().mockResolvedValue({ ok: true, version: "0.1.0" })
  };
  window.lekhDesktop = bridge;
  return bridge;
}

describe("companion settings shell", () => {
  afterEach(() => {
    delete window.lekhDesktop;
    window.localStorage.clear();
  });

  it("shows an honest enabled-but-not-selected activation journey", async () => {
    installBridge();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Lekh is ready" })).toBeInTheDocument();
    expect(screen.getAllByText("Ready to select")).toHaveLength(2);
    expect(screen.getByText(/menu bar input menu/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check Again" })).toBeInTheDocument();
    expect(screen.queryByText("Active now")).not.toBeInTheDocument();
    const progress = screen.getByRole("list", { name: "Activation progress" });
    expect(within(progress).getByText("Installed").closest("li")).toHaveClass("is-complete");
    expect(within(progress).getByText("Added").closest("li")).toHaveClass("is-complete");
    expect(within(progress).getByText("Active").closest("li")).toHaveClass("is-current");
  });

  it("refreshes stale activation state when the window regains focus", async () => {
    const bridge = installBridge();
    vi.mocked(bridge.getStatus)
      .mockResolvedValueOnce(readyStatus)
      .mockResolvedValue({ ...readyStatus, selected: true });
    render(<App />);

    await screen.findByRole("heading", { name: "Lekh is ready" });
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByRole("heading", { name: "Lekh is active" })).toBeInTheDocument();
    expect(screen.getAllByText("Active now")).toHaveLength(2);
  });

  it("persists the primary ghost control and exposes real acceptance semantics", async () => {
    const bridge = installBridge();
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Finish words without losing your flow" });
    const ghostSwitch = screen.getByRole("switch", { name: "Ghost suggestions" });
    expect(ghostSwitch).toBeChecked();
    expect(
      screen.getByText(
        "Space accepts the visible suggestion. Shift+Space keeps exactly what you typed."
      )
    ).toBeInTheDocument();
    await user.click(ghostSwitch);
    await waitFor(() => expect(bridge.updatePreferences).toHaveBeenCalledWith({ inlinePreviewEnabled: false }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved on this device");
  });

  it("presents all four modes as an accessible radio group and saves explicit selection", async () => {
    const bridge = installBridge();
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Choose how you write" });
    const modes = screen.getByRole("radiogroup", { name: "Choose how you write" });
    expect(within(modes).getAllByRole("radio")).toHaveLength(4);
    await user.click(within(modes).getByRole("radio", { name: /नेपाली spelling help/ }));
    await waitFor(() => expect(bridge.updatePreferences).toHaveBeenCalledWith({ nativeTypingMode: "traditional-traditional" }));
  });

  it("switches locale locally without changing keyboard preferences", async () => {
    const bridge = installBridge();
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Lekh is ready" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Language" }), "ne");
    expect(screen.getByRole("heading", { name: "Lekh तयार छ" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "टाइपिङ" })).toBeInTheDocument();
    expect(window.localStorage.getItem("lekh.companion.locale")).toBe("ne");
    expect(bridge.updatePreferences).not.toHaveBeenCalled();
  });

  it("lets people exclude applications without knowing bundle identifiers", async () => {
    const bridge = installBridge({
      chosenApplications: [{ bundleIdentifier: "com.microsoft.VSCode", displayName: "Visual Studio Code" }]
    });
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Lekh is ready" });
    await user.click(screen.getByRole("button", { name: "Privacy" }));
    await user.click(screen.getByRole("button", { name: "Choose Applications…" }));
    await waitFor(() => expect(bridge.updatePreferences).toHaveBeenCalledWith({
      excludedApplicationBundleIdentifiers: ["com.microsoft.VSCode"]
    }));
    expect(screen.getByText("Visual Studio Code")).toBeInTheDocument();
    expect(screen.getByText("com.microsoft.VSCode")).toBeInTheDocument();
  });

  it("labels an unsigned local artifact as a development build", async () => {
    installBridge();
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Lekh is ready" });
    await user.click(screen.getByRole("button", { name: "Updates & diagnostics" }));
    expect(screen.getByText("Development build")).toBeInTheDocument();
    expect(screen.queryByText("Release signature verified")).not.toBeInTheDocument();
    expect(screen.getByText(/never include typed text/)).toBeInTheDocument();
  });

  it("exposes connected Windows preferences, verified modes, and privacy exclusions", async () => {
    const bridge = installBridge({
      platform: "win32",
      chosenApplications: [{ bundleIdentifier: "win32.exe:notepad.exe", displayName: "Notepad" }],
      status: {
        platform: "win32",
        installed: true,
        enabled: true,
        selected: false,
        version: "0.1.0",
        bundlePath: "C:\\Program Files\\Lekh Keyboard\\LekhTextService.dll",
        releaseSigned: false,
        registered: true,
        registrationPathMatches: true,
        registrationIssues: [],
        serviceHealthy: true,
        serviceLatencyMs: 4,
        serviceIssue: null,
        serviceProcessRunning: true,
        startupEnabled: true,
        startupCanChange: true,
        repairAvailable: false
      }
    });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Lekh is ready on Windows" })).toBeInTheDocument();
    expect(screen.getByText("Built to stay out of your way")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Ghost suggestions" })).toBeEnabled();
    expect(within(screen.getByRole("radiogroup", { name: "Choose how you write" })).getAllByRole("radio")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Open Keyboard Settings" }));
    expect(bridge.openKeyboardSettings).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Privacy" }));
    await user.click(screen.getByRole("button", { name: "Choose Applications…" }));
    await waitFor(() => expect(bridge.updatePreferences).toHaveBeenCalledWith({
      excludedApplicationBundleIdentifiers: ["win32.exe:notepad.exe"]
    }));
    expect(screen.getByText("Notepad")).toBeInTheDocument();
  });

  it("offers an explicit UAC repair when Windows registration is missing", async () => {
    const registrationStatus: LekhNativeStatus = {
      platform: "win32",
      installed: true,
      enabled: false,
      selected: false,
      version: "0.1.0",
      bundlePath: "C:\\Program Files\\Lekh Keyboard\\LekhTextService.dll",
      releaseSigned: false,
      registered: false,
      registrationPathMatches: false,
      registrationIssues: ["com-registration-missing"],
      serviceHealthy: true,
      serviceLatencyMs: 3,
      serviceIssue: null,
      serviceProcessRunning: true,
      startupEnabled: true,
      startupCanChange: true,
      repairAvailable: true
    };
    const bridge = installBridge({ platform: "win32", status: registrationStatus });
    vi.mocked(bridge.repairWindowsInstallation).mockResolvedValue({
      ok: true,
      status: { ...registrationStatus, enabled: true, registered: true, registrationPathMatches: true, registrationIssues: [] }
    });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Finish Windows keyboard setup" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Repair keyboard" }));
    await waitFor(() => expect(bridge.repairWindowsInstallation).toHaveBeenCalledOnce());
    expect(await screen.findByRole("status")).toHaveTextContent("Windows keyboard registration repaired");
  });
});
