import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const mainSource = readFileSync(join(root, "electron", "main.cjs"), "utf8");
const preloadSource = readFileSync(join(root, "electron", "preload.cjs"), "utf8");
const controllerSource = readFileSync(
  join(root, "src", "features", "companion", "useCompanionController.ts"),
  "utf8"
);

describe("companion preference persistence integration contract", () => {
  it("dispatches preference IPC before renderer reconciliation can be queued", () => {
    const scheduleStart = controllerSource.indexOf("function schedulePreferenceMutation(");
    const scheduleEnd = controllerSource.indexOf("\n  function updatePreference(", scheduleStart);
    const scheduleSource = controllerSource.slice(scheduleStart, scheduleEnd);
    const dispatchIndex = scheduleSource.indexOf("bridge.updatePreferences({");
    const reconciliationIndex = scheduleSource.indexOf("return enqueueReconciliation(");

    expect(scheduleStart).toBeGreaterThanOrEqual(0);
    expect(dispatchIndex).toBeGreaterThanOrEqual(0);
    expect(reconciliationIndex).toBeGreaterThan(dispatchIndex);
    expect(preloadSource).toContain(
      "updatePreferences: (patch) => ipcRenderer.invoke(\"lekh:preferences:update\", patch)"
    );
  });

  it("validates and accepts updates into the bounded main-process queue", () => {
    const handlerStart = mainSource.indexOf(
      "ipcMain.handle(\"lekh:preferences:update\""
    );
    const handlerEnd = mainSource.indexOf(
      "ipcMain.handle(\"lekh:open-keyboard-settings\"",
      handlerStart
    );
    const handlerSource = mainSource.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerSource.indexOf("validatePreferencePatch(")).toBeGreaterThanOrEqual(0);
    expect(handlerSource.indexOf("preferenceWriteQueue.enqueue(")).toBeGreaterThan(
      handlerSource.indexOf("validatePreferencePatch(")
    );
    expect(mainSource).toContain("maximumPendingPreferenceWrites = 32");
  });

  it("keeps the Windows main process alive on window close and drains on full quit", () => {
    expect(mainSource).toContain(
      "if (process.platform !== \"darwin\" && process.platform !== \"win32\") app.quit();"
    );
    expect(mainSource).toContain("app.on(\"before-quit\", (event) => {");
    expect(mainSource).toContain("preferenceWriteQueue.close();");
    expect(mainSource).toContain("event.preventDefault();");
    expect(mainSource).toContain(
      "preferenceWriteQueue.drain(preferenceWriteDrainTimeoutMs)"
    );
    expect(mainSource).toContain("preferenceWriteDrainTimeoutMs = 5000");
    expect(mainSource).toContain("preferenceQuitDrainComplete = true;");
    expect(mainSource).toContain("app.quit();");
  });
});
