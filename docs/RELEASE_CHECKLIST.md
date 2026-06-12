# Release Checklist

Use this checklist before publishing a public web/PWA build or making quality claims.

## Required Gates

```bash
npm install
npm run verify
npm audit --audit-level=moderate
npm run report:quality
```

Required results:

- tests pass
- production build passes
- privacy guard passes
- offline service worker gate passes
- npm audit has no moderate-or-higher vulnerabilities, or the exception is documented
- quality report metrics are recorded in `docs/ENGINE_QUALITY_SCORECARD.md` and current launch status is recorded in `docs/CURRENT_PRODUCTION_READINESS_STATUS.md`

## Native macOS Release Gates

Do not ship the macOS keyboard publicly until all of these pass:

- `npm run package:macos:imk:test-installer` for the local test artifact.
- `npm run check:macos-imk-bundle`.
- `npm run check:native-imk-privacy-security`.
- `npm run check:macos-update-security:production` with Developer ID, notarization, Sparkle, and dictionary-pack signing keys configured.
- `npm run corpus:keyboard:package-check:production`.
- Fresh-machine install, switch from menu bar, type in TextEdit, Safari, Chrome, VS Code, Notes, Mail, Messages, Word, Google Docs, Spotlight, and password fields.
- Uninstall confirms first, restores the previous input source when possible, and deletes local learned words, packs, models, backups, caches, and logs.

## Privacy Review

- No typed text, converted text, queries, keystrokes, clipboard content, spell tokens, or output text leaves the browser automatically.
- Feedback is explicit and user-triggered.
- Local correction memory stays in browser storage.
- Any metrics are event-only and contain no text content.
- Native diagnostics do not record raw text, committed text, candidate text, clipboard content, physical key codes, or secure-field content.

## Data Review

- New bundled data has source, license, import date, and usage decision in `docs/DATA_SOURCES.md`.
- No unclear-licensed mapping, dictionary, or document data is included.
- Real Preeti examples are consented, de-identified, and tracked through `docs/REAL_PREETI_VALIDATION.md`.
- Third-party notices are updated when dependencies or data sources change.

## Product Claims

Do not claim:

- official language authority
- government endorsement
- perfect Preeti conversion
- perfect transliteration
- official spellchecking
- native keyboard support
- adoption or real-document validation that has not been measured
- best-in-class quality without named baselines and comparable test inputs

## Manual Smoke Pass

- Keyboard/companion status is first; Preeti remains a clearly labeled side utility.
- Romanized tab shows candidates and full-output alternatives.
- Traditional tab remains reference-only.
- Feedback flow does not submit anything without explicit user action.
- Offline behavior works after a successful production load.
