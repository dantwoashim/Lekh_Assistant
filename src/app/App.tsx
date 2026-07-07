import { CompanionShell } from "../features/companion/CompanionShell";
import { FocusedKeyboard } from "../features/typing/FocusedKeyboard";

export function App() {
  return window.lekhDesktop?.kind === "companion"
    ? <CompanionShell />
    : <FocusedKeyboard />;
}
