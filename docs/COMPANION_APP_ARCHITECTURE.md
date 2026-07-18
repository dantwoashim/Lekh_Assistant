# Companion App Architecture

The companion app is the settings, diagnostics, dictionary, memory, privacy, and document-tools surface. It is not the IME, not a global keyboard hook, and not the per-keystroke hot path.

Scaffold:

- `native/companion/README.md`

No Tauri dependency is added in Prompt 3 because the current repo does not need a large desktop dependency stack to complete the contract and release plan.

## Pages

1. Home/status
2. Typing settings
3. Romanized settings
4. Traditional layout settings
5. Dictionary
6. Personal memory
7. Privacy
8. Document tools and Preeti side utility
9. Diagnostics
10. About/update

## Responsibilities

- Change mode defaults.
- Manage Romanized labels and helper suggestions; report experimental auto-commit as unavailable until its promotion gates pass.
- Show Traditional layout audit status and preview once verified.
- Manage personal dictionary entries.
- Export, import, and reset correction memory.
- Show daemon, IPC, and native shell diagnostics.
- Host Preeti/document tools as side utilities.

## Non-Responsibilities

- It is not the IME.
- It is not a hot keystroke handler.
- It does not run a global keyboard hook as a shortcut around TSF/IMK.
- It does not generate per-keystroke candidates in production; that belongs to the daemon.
## Prompt 2 MVP Shell

Prompt 2 adds a lightweight web companion shell:

- `src/features/companion/CompanionShell.tsx`
- `src/features/companion/settings.ts`
- Companion tab in `src/app/App.tsx`

The shell previews settings, privacy, dictionary, personal memory, diagnostics, document tools, and update/about surfaces. It is not the IME, not a global keyboard hook, and not responsible for per-keystroke candidate generation.

Native desktop packaging and daemon-backed settings persistence remain Prompt 3 work.
