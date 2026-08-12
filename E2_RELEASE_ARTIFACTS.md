# E2 — v1.0.0 Release Artifact Receipt

Checklist item E2 is complete at source revision
`e342d1f269222eee4a04c83a5ae7099e01d000c5`.

## CI receipt

- Workflow: [run 29850032455](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29850032455) — passed.
- macOS Apple Silicon: [job 88700348901](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29850032455/job/88700348901) — passed and built the universal artifact.
- macOS Intel x64: [job 88700348777](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29850032455/job/88700348777) — passed.
- Windows x64: [job 88700348878](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29850032455/job/88700348878) — passed, including silent install, daemon/service negotiation, uninstall, and cleanup.
- Windows ARM64: [job 88700348899](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29850032455/job/88700348899) — native build and tests passed; packaging was intentionally skipped because the ARM64 lifecycle is not verified.
- Release bundle: [job 88701524632](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29850032455/job/88701524632) — passed.

The combined CI artifact is
[`lekh-assistant-v1.0.0-release-candidate`](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29850032455/artifacts/8503091019)
(artifact ID `8503091019`, 112,305,235 bytes). It contains:

- `Lekh-Keyboard-Test-Installer.zip` — universal macOS installer for Apple
  Silicon and Intel;
- `Lekh-Keyboard-Companion-1.0.0-Setup-x64.exe` — verified Windows x64
  installer;
- `SHA256SUMS.txt`;
- `RELEASE_NOTES_v1.0.md`, rendered from the two installers in that same job.

The workflow forces `LEKH_EXPERIMENTAL_NEURAL_TYPING=0`. The macOS packaging
self-test also verifies both executable architectures, ad-hoc code-signature
integrity, and zero packaged neural-model bytes.

## Independent bundle verification

The published artifact was downloaded into a new temporary directory and
checked without modifying it:

```sh
gh run download 29850032455 \
  -n lekh-assistant-v1.0.0-release-candidate \
  -D "$release_tmp"
(cd "$release_tmp" && shasum -a 256 -c SHA256SUMS.txt)
```

Result:

```text
Lekh-Keyboard-Test-Installer.zip: OK
Lekh-Keyboard-Companion-1.0.0-Setup-x64.exe: OK
```

Published installer hashes:

```text
222827ebfca9d529a3b427d6aa35ace5bf1a8077c57c43ee9cea4352b2074c30  Lekh-Keyboard-Test-Installer.zip
02702fbc72c6b7e06f3fb2ab80722eb12e26c0719222bb100ea68e56cf4e38e2  Lekh-Keyboard-Companion-1.0.0-Setup-x64.exe
```

No Windows ARM64 installer is represented as shippable. Its native build and
tests pass in CI, while the installer lifecycle limitation is documented in
`KNOWN_LIMITATIONS.md` and deferred beyond v1.0.
