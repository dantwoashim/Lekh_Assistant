import type { KeyboardMode } from "../../engine/keyboard";

interface ModeSwitcherProps {
  mode: KeyboardMode;
  showLabels: boolean;
  secureInput: boolean;
  onModeChange: (mode: KeyboardMode) => void;
  onToggleLabels: () => void;
  onToggleSecureInput: () => void;
}

export function ModeSwitcher({
  mode,
  showLabels,
  secureInput,
  onModeChange,
  onToggleLabels,
  onToggleSecureInput
}: ModeSwitcherProps) {
  return (
    <div className="keyboard-mode-wrap">
      <div className="keyboard-mode-row" aria-label="Keyboard mode">
        {(["romanized", "traditional", "unicode-proofread", "diagnostic"] as KeyboardMode[]).map((item) => (
          <button
            key={item}
            type="button"
            className={item === mode ? "mode-chip mode-chip--active" : "mode-chip"}
            onClick={() => onModeChange(item)}
          >
            {labelFor(item)}
          </button>
        ))}
      </div>
      <label className="keyboard-toggle">
        <input type="checkbox" checked={showLabels} onChange={onToggleLabels} />
        <span>Romanized labels</span>
      </label>
      <label className="keyboard-toggle">
        <input type="checkbox" checked={secureInput} onChange={onToggleSecureInput} />
        <span>Secure input</span>
      </label>
    </div>
  );
}

function labelFor(mode: KeyboardMode): string {
  if (mode === "romanized") return "Romanized";
  if (mode === "traditional") return "Traditional (Beta)";
  if (mode === "unicode-proofread") return "Proofread";
  return "Diagnostic";
}
