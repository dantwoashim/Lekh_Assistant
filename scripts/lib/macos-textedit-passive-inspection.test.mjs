import { describe, expect, it } from "vitest";
import {
  inspectExactTextEditPassively,
  passiveExactTextEditInspectionSource
} from "./macos-textedit-passive-inspection.mjs";

const pid = 4242;
const documentPath = "/private/tmp/lekh-candidate-proof.txt";

function observation(overrides = {}) {
  return {
    appFrontmost: true,
    documents: [documentPath],
    editorFocused: true,
    exactDocumentCount: 1,
    focusedUIElementMatchesEditor: true,
    frontmostPid: pid,
    operationStatus: "passive-inspected",
    targetPid: pid,
    textBase64: Buffer.from("probe पानी", "utf8").toString("base64"),
    windowFocused: true,
    windowMain: true,
    ...overrides
  };
}

function runnerReturning(value, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
  };
}

describe("passive exact TextEdit inspection", () => {
  it("contains no activation, AX mutation, focus repair, or event posting path", () => {
    const source = passiveExactTextEditInspectionSource(pid, documentPath);
    expect(source).not.toContain(".activate(");
    expect(source).not.toContain("activateAllWindows");
    expect(source).not.toContain("AXUIElementSetAttributeValue");
    expect(source).not.toContain("CGEvent(");
    expect(source).not.toContain("postToPid");
    expect(source).not.toContain(".post(");
    expect(source).toContain("AXUIElementCopyAttributeValue");
    expect(source).toContain("kAXFocusedUIElementAttribute");
  });

  it("accepts one exact, frontmost, fully focused document without a second call", () => {
    const calls = [];
    const result = inspectExactTextEditPassively(pid, documentPath, {
      runner: runnerReturning(observation(), calls)
    });
    expect(result.status).toBe(0);
    expect(result.snapshot?.text).toBe("probe पानी");
    expect(calls).toHaveLength(1);
  });

  it("fails lost frontmost focus once and never attempts repair", () => {
    const calls = [];
    const result = inspectExactTextEditPassively(pid, documentPath, {
      runner: runnerReturning(observation({ appFrontmost: false, frontmostPid: 9001 }), calls)
    });
    expect(result.status).toBe(3);
    expect(result.snapshot?.frontmostPid).toBe(9001);
    expect(result.snapshot?.appFrontmost).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[1]).not.toContain("AXUIElementSetAttributeValue");
  });

  it("fails lost editor focus once and never attempts repair", () => {
    const calls = [];
    const result = inspectExactTextEditPassively(pid, documentPath, {
      runner: runnerReturning(observation({
        editorFocused: false,
        focusedUIElementMatchesEditor: false
      }), calls)
    });
    expect(result.status).toBe(3);
    expect(result.snapshot?.editorFocused).toBe(false);
    expect(result.snapshot?.focusedUIElementMatchesEditor).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[1]).not.toContain(".activate(");
  });
});
