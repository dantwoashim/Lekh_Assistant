# Privacy

Lekh is local-first.

## Local Processing

Preeti conversion, Romanized typing, suggestions, spell hints, normalization, and copy output run in the browser. The app does not send typed text, converted text, dictionary queries, raw keystrokes, spell tokens, clipboard content, or output text to a server.

## Feedback

Feedback is explicit. The feedback form prepares a message from fields the user chooses to submit. If no feedback email is configured for deployment, the form copies or exports the report locally instead of sending it anywhere.

## Local Correction Memory

Romanized candidate choices can be stored in browser local storage after the user explicitly selects an alternative. This data stays on the same device, is not synced by the app, and can be cleared from the Romanized editor.

The native macOS input method stores its learned user lexicon locally under `~/Library/Application Support/Lekh Keyboard/`. It is used only to rank local candidates on that Mac. The uninstaller deletes this lexicon, dictionary packs, model files, install backups, caches, and Lekh logs.

## Metrics

The current app does not send analytics. A local guard exists for any future event-only metrics. If metrics are added later, they may include event names such as mode selection or copy clicked, but never text content.

Native diagnostics are opt-in and local-only. Diagnostic logs must not record raw typed text, committed text, candidate text, or physical key codes. Secure-input/password contexts are pass-through and must not be learned.

## Offline

The app registers a service worker and precaches the app shell plus Vite hashed assets after build. Core engines and seed data are bundled with the app, so the main tools continue to work offline after the first successful load.
