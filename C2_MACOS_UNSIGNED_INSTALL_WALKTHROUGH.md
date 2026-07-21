# C2 macOS Unsigned First-Run Walkthrough

Command: `node scripts/check-macos-unsigned-install-ux.mjs --check-receipt`

```text
PASS — a clean extracted folder is not misclassified as quarantined.
PASS — a simulated downloaded-folder quarantine marker is detected.
PASS — a simulated installer-app quarantine marker is detected.
PASS — first run reports the detected quarantine state in plain language.
PASS — Control-click/right-click → Open is the preferred opening path.
PASS — the fallback is one xattr command scoped to the installer app.
PASS — packaged ZIP verification executes the no-install walkthrough path.
RESULT — C2 unsigned first-run walkthrough passed.
```
