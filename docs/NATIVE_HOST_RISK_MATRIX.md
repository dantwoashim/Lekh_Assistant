# Native Host Risk Matrix

Lekh uses a deterministic pairwise matrix for cross-platform host testing. The canonical policy is `config/native-host-risk-matrix.v1.json`.

The 70 scenarios cover every supported OS/architecture target with every host class, every target with every mode, and every host class with every mode. A full Cartesian product would require 280 scenarios. The existing macOS application matrix remains useful as supplemental depth; it does not replace this cross-platform risk contract.

Required host classes are native editors, Chromium, Electron, Office-class editors, accessibility clients, secure fields, and remote or virtualized input. Each host class declares the failures it is specifically meant to expose.

## Commands

```sh
npm run check:native-host-risk-matrix
npm run check:native-host-risk-matrix:production
```

The development command validates the immutable policy and any evidence already present. Missing manual evidence is reported without pretending that it exists. The production command requires all 70 scenarios to pass on the exact source revision and tree under release, with a clean tracked worktree.

## Evidence location and contract

Each scenario has one evidence file:

```text
reports/qa/native-host-risk/<scenario-id>.json
```

Evidence records bind all of the following:

- Git source revision and source tree;
- installed build revision, tree, version, and artifact SHA-256;
- exact operating-system family, major version, architecture, application, mode, hardware, locale, and input-source version;
- at least three reproducible steps with expected and actual results;
- one result for every risk case declared by the host profile;
- retained screenshot, video, log, or accessibility transcript with a verified SHA-256;
- named operator and named internal review owner;
- defects and their P0-P3 status.

One retained artifact identity cannot be reused to satisfy multiple scenarios. Production requires a 100% pass rate and zero open P0/P1 defects. Secure-field artifacts should be privacy-safe logs; never record entered secrets.

Traditional-mode evidence cannot substitute for the separate Traditional-layout and Nepali-language human-authority gate.
