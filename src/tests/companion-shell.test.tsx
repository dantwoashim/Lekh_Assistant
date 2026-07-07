import { render, screen, waitFor } from "@testing-library/react";
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

describe("macOS companion shell", () => {
  afterEach(() => {
    delete window.lekhDesktop;
  });

  it("shows real native status and persists an allowlisted preference", async () => {
    const updatePreferences = vi.fn().mockResolvedValue({ ok: true });
    window.lekhDesktop = {
      kind: "companion",
      platform: "darwin",
      arch: "arm64",
      versions: { app: "0.1.0" },
      productBoundary: "Native IMK handles keystrokes.",
      getStatus: vi.fn().mockResolvedValue({
        platform: "darwin",
        installed: true,
        enabled: true,
        selected: false,
        version: "0.1.0",
        bundlePath: "/Users/test/Library/Input Methods/Lekh Keyboard.app",
        releaseSigned: null
      }),
      readPreferences: vi.fn().mockResolvedValue(preferences),
      updatePreferences,
      openKeyboardSettings: vi.fn().mockResolvedValue({ ok: true }),
      revealInputMethod: vi.fn().mockResolvedValue({ ok: true, error: null }),
      checkForUpdates: vi.fn().mockResolvedValue({ status: "current", message: "Lekh is up to date." }),
      downloadVerifiedUpdate: vi.fn().mockResolvedValue({ ok: true, version: "0.1.0" })
    };

    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Native keyboard installed" })).toBeInTheDocument();
    const learning = screen.getByRole("checkbox", { name: /Personal learning/ });
    expect(learning).toBeChecked();
    await user.click(learning);
    await waitFor(() => {
      expect(updatePreferences).toHaveBeenCalledWith({ personalizationEnabled: false });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Saved locally.");
  });

  it("can switch the companion shell to Nepali without changing keyboard state", async () => {
    window.lekhDesktop = {
      kind: "companion",
      platform: "darwin",
      arch: "arm64",
      versions: { app: "0.1.0" },
      productBoundary: "Native IMK handles keystrokes.",
      getStatus: vi.fn().mockResolvedValue({
        platform: "darwin",
        installed: true,
        enabled: true,
        selected: false,
        version: "0.1.0",
        bundlePath: "/Users/test/Library/Input Methods/Lekh Keyboard.app",
        releaseSigned: null
      }),
      readPreferences: vi.fn().mockResolvedValue(preferences),
      updatePreferences: vi.fn().mockResolvedValue({ ok: true }),
      openKeyboardSettings: vi.fn().mockResolvedValue({ ok: true }),
      revealInputMethod: vi.fn().mockResolvedValue({ ok: true, error: null }),
      checkForUpdates: vi.fn().mockResolvedValue({ status: "current", message: "Lekh is up to date." }),
      downloadVerifiedUpdate: vi.fn().mockResolvedValue({ ok: true, version: "0.1.0" })
    };

    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Native keyboard installed" });
    await user.selectOptions(screen.getByLabelText("Language"), "ne");
    expect(screen.getByRole("heading", { name: "नेटिभ किबोर्ड इन्स्टल छ" })).toBeInTheDocument();
    expect(screen.getByText("टाइपिङ")).toBeInTheDocument();
    expect(window.lekhDesktop.updatePreferences).not.toHaveBeenCalled();
  });
});
