import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("macOS IMK proof target source", () => {
  it("contains a real IMKInputController subclass instead of the old placeholder source", () => {
    const controllerPath = join(root, "native/macos-imk/skeleton/LekhInputController.swift");
    expect(existsSync(controllerPath)).toBe(true);
    expect(existsSync(join(root, "native/macos-imk/skeleton/LekhInputController.placeholder.swift"))).toBe(false);

    const source = readFileSync(controllerPath, "utf8");
    expect(source).toContain("IMKInputController");
    expect(source).toContain("handle(_ event: NSEvent!");
    expect(source).toContain("inputText");
    expect(source).toContain("setMarkedText");
    expect(source).toContain("insertText");
  });

  it("keeps XPC unavailable behavior fail-open by committing raw printable text", () => {
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhXpcClient.swift"), "utf8");
    expect(source).toContain("LekhXpcEngineClient");
    expect(source).toContain("safeFallback");
    expect(source).toContain("committedText: key");
    expect(source).toContain("LekhInputDecision.passThrough");
  });

  it("loads the packaged native runtime suggestion pack for flagship Romanized typing", () => {
    const controller = readFileSync(join(root, "native/macos-imk/skeleton/LekhInputController.swift"), "utf8");
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhXpcClient.swift"), "utf8");
    const packageScript = readFileSync(join(root, "scripts/package-macos-imk-dev.mjs"), "utf8");

    expect(controller).toContain("LEKH_IMK_USE_XPC");
    expect(controller).toContain("LekhStaticProofEngineClient");
    expect(packageScript).toContain("runtime-suggestions.json");
    expect(source).toContain("Bundle.main.url(forResource: \"runtime-suggestions\"");
    expect(source).toContain("RuntimeSuggestionPack");
    expect(source).toContain("swasthya");
    expect(source).toContain("स्वास्थ्य");
    expect(source).toContain("nagarikta pr");
    expect(source).toContain("नागरिकता प्रमाणपत्र");
  });

  it("contains native mode switching for the four typing surfaces", () => {
    const controller = readFileSync(join(root, "native/macos-imk/skeleton/LekhInputController.swift"), "utf8");
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhXpcClient.swift"), "utf8");

    expect(source).toContain("LekhNativeTypingMode");
    expect(source).toContain("romanized-romanized");
    expect(source).toContain("romanized-traditional");
    expect(source).toContain("traditional-traditional");
    expect(source).toContain("traditional-romanized");
    expect(controller).toContain("Control+Option+Space");
    expect(controller).toContain("modeMenuOpen");
    expect(controller).toContain("modeFromMenuKey");
    expect(controller).toContain("modifiers.contains(.control), modifiers.contains(.option), event.keyCode == 49");
  });

  it("keeps Devanagari Traditional input in the native composition buffer", () => {
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhXpcClient.swift"), "utf8");

    expect(source).toContain("shouldAppendToComposition");
    expect(source).toContain("scalar.value >= 0x0900 && scalar.value <= 0x097F");
    expect(source).toContain("traditionalCandidates");
  });

  it("packages as a real macOS input method bundle with install and uninstall scripts", () => {
    const plist = readFileSync(join(root, "native/macos-imk/skeleton/Info.plist"), "utf8");
    const appMain = readFileSync(join(root, "native/macos-imk/skeleton/App/main.swift"), "utf8");

    expect(plist).toContain("com.lekh.inputmethod.keyboard");
    expect(plist).toContain("InputMethodConnectionName");
    expect(plist).toContain("Lekh_Keyboard_Connection");
    expect(plist).toContain("InputMethodServerControllerClass");
    expect(plist).toContain("LekhInputController");
    expect(plist).toContain("tsInputMethodCharacterRepertoireKey");
    expect(plist).toContain("Latn");
    expect(plist).toContain("Deva");
    expect(appMain).toContain("IMKServer");
    expect(appMain).toContain("Lekh_Keyboard_Connection");
    expect(existsSync(join(root, "native/macos-imk/skeleton/install-dev.sh"))).toBe(true);
    expect(existsSync(join(root, "native/macos-imk/skeleton/register-dev.swift"))).toBe(true);
    expect(existsSync(join(root, "native/macos-imk/skeleton/restore-system-keyboard.swift"))).toBe(true);
    expect(existsSync(join(root, "native/macos-imk/skeleton/restore-system-keyboard.sh"))).toBe(true);
    expect(existsSync(join(root, "native/macos-imk/skeleton/uninstall-dev.sh"))).toBe(true);
    expect(existsSync(join(root, "scripts/package-macos-imk-dev.mjs"))).toBe(true);
    expect(existsSync(join(root, "scripts/check-macos-imk-dev-install.mjs"))).toBe(true);
  });

  it("keeps host-app TextEdit typing as a probe instead of a fake release gate", () => {
    const packageJson = readFileSync(join(root, "package.json"), "utf8");
    const probe = readFileSync(join(root, "scripts/check-macos-imk-host-textedit.mjs"), "utf8");

    expect(packageJson).toContain("probe:macos-imk-host:textedit");
    expect(packageJson).not.toContain("check:macos-imk-host:textedit");
    expect(probe).toContain("blocked-automation");
    expect(probe).toContain("restoreScript");
  });

  it("does not auto-select the unfinished IMK during normal dev install", () => {
    const installScript = readFileSync(join(root, "native/macos-imk/skeleton/install-dev.sh"), "utf8");
    const registerScript = readFileSync(join(root, "native/macos-imk/skeleton/register-dev.swift"), "utf8");
    const checkScript = readFileSync(join(root, "scripts/check-macos-imk-dev-install.mjs"), "utf8");

    expect(registerScript).toContain("--select");
    expect(registerScript).toContain("shouldSelect");
    expect(installScript).toContain("restore-system-keyboard.sh");
    expect(installScript).toContain('swift "$(dirname "$0")/register-dev.swift" "$DEST"');
    expect(installScript).not.toContain('swift "$(dirname "$0")/register-dev.swift" "$DEST" --select');
    expect(checkScript).toContain("unsafe until host-app typing is proven");
  });
});
