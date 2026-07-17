# Current Production Readiness Status

Updated: 2026-07-17

Evidence basis: the current reviewed source revision and the hardening changes described below. These changes have passed tests but are not present in the previously shared build 176 archive until a new archive is built and verified.

## Current decision

Lekh is a promising experimental macOS preview, not a production keyboard and not yet the complete product Niraj requested.

Canonical release decision: `NOT_READY_BLOCKED_BY_EXTERNAL_NATIVE_REQUIREMENTS`.

Machine-readable product markers retained for automated truth checks:

- `Windows native keyboard | blocked-native-environment`
- `macOS native keyboard | partial native-dev proof`
- `Traditional physical keyboard | blocked-human`

The native completion target remains a production macOS IMK input method with host-app matrix evidence. Under the current no-Developer-ID constraint, the project can ship only a transparently unsigned community preview, not that production-equivalent channel.

- **Community Unsigned macOS Preview:** source is approaching a new QA candidate, but the old build 176 archive must not be represented as containing the latest fixes. Rebuild it, verify it, and perform clean-account install/use/uninstall testing before redistribution.
- **Apple-trusted macOS production channel:** unavailable under the explicit no-Developer-ID constraint. The project will not pretend that ad-hoc signing, Minisign, Homebrew, or manual approval equals Apple notarization.
- **Windows keyboard:** blocked on implementation. The current TSF code is a fail-open feasibility skeleton; it does not begin a real engine session, own a TSF composition, apply marked or committed text, or render candidates.
- **Original product request:** incomplete. Romanized and internal Traditional modes exist on macOS, but authoritative Traditional physical-layout validation, working Windows support, cross-host suggestions/proofreading, and a dictionary with dependable meanings remain unfinished.

## Request-to-product truth

| Requested capability | Current evidence | Honest status |
| --- | --- | --- |
| macOS Romanized keyboard | Native IMK and local candidate engine exist; significant automated Swift coverage exists | experimental; real-host and pilot evidence incomplete |
| macOS Traditional keyboard | Internal Traditional pipelines and fallback mappings exist | blocked on authoritative LTK layout capture and skilled human validation |
| Windows Romanized/Traditional keyboard | C++ TSF and daemon scaffolds exist; default key eating is disabled | not implemented as a usable keyboard |
| auto-suggestions | Local candidate, completion, and ranking code exists | useful prototype; cross-engine conformance and host acceptance incomplete |
| proofreading while typing | Proof-hint code and macOS UI paths exist | not certified across target host applications |
| dictionary while typing | Lookup returns words, aliases, domains, and some metadata | meanings/definitions and product UX are incomplete |
| neural acceleration | Build 176 contains an experimental local Core ML model | `productionEligible` is false; `.all` compute units do not prove Neural Engine execution |
| trusted macOS installation | Project-owned signed manifest and ad-hoc code signature exist | cryptographic integrity is possible; Apple identity/notarization is not |

## Verified on 2026-07-17

| Check | Result |
| --- | --- |
| TypeScript project build | `tsc -b --noEmit` passed |
| Full Vitest run | 57 test files passed, 1 skipped; 411 tests passed, 1 skipped |
| Focused safety/release run | 8 files and 117 tests passed |
| Native IMK privacy/security policy | passed with zero violations |
| Swift helper compilation | registration and self-contained release-verifier helpers compiled for arm64 and x86_64 |
| Swift native behavior probe | candidate, delimiter, four-mode, and neural input-admission contracts passed |
| Neural runtime manifest | `passed-experimental`; production provenance/context-rescorer warnings remain |
| Production dependency audit | zero known npm vulnerabilities reported |
| Generated terminal shell syntax | install and uninstall scripts passed `bash -n` |

This evidence disproves the supplied masterplan's current headline claim that TypeScript typechecking is un-runnable. Large embedded data, overlapping project graphs, and inflated bundles remain architectural debt; a stale OOM observation is not a present stop-ship fact.

## Hardening implemented in the current working tree

1. TypeScript range operations now respect extended grapheme boundaries for Devanagari combining sequences, virama conjuncts, emoji modifiers, and ZWJ sequences.
2. A transition into a secure or uncertain field atomically clears surrounding text windows, active composition, candidates, proof hints, last committed text, and committed history.
3. Named-pipe work and responses are serialized in arrival order; the five-second idle disconnect was replaced with a substantially longer development policy pending final lifecycle design.
4. The macOS release verifier is self-contained: a bundled, hash-pinned CryptoKit helper verifies the legacy Ed25519 Minisign packet without requiring Homebrew or a tester-installed `minisign` executable.
5. The terminal path creates a private metadata-clean snapshot of the complete release, verifies that exact closed-world snapshot, verifies code-sign integrity, and only then executes it.
6. Installer and helper messages no longer claim that transient TIS enablement proves persistent macOS approval. Instructions explicitly separate installation, registration request, logout/login, and user approval in System Settings.
7. Recursive quarantine removal was removed from current instructions. The canonical release-key fingerprint and the limits of project-owned signing are documented.
8. All 17 daemon request types now pass exact, bounded runtime payload validation before dispatch. No-argument wire payloads use JSON-safe `null`, malformed hot-path requests cannot reach the engine, and correction-memory writes require an explicitly `normal` or `search` session. `memory.learn` accepts only a one-time server-issued `{sessionId, commitEpoch}` receipt and cannot carry client-supplied text or context.
9. The TypeScript SQLite adapter no longer writes JSON fallback bytes into a `.sqlite3` path. Unsupported Node runtimes fail closed with actionable guidance, while tests prove the SQLite header, integrity/reopen behavior, and byte-for-byte preservation of rejected non-SQLite files.
10. The supported development runtime is explicit (`node >=22.5`, `.nvmrc` 24, npm 11.8.0), matching the first Node release that provides `node:sqlite` and the CI matrix.
11. The experimental neural tail now bypasses exact deterministic tokens, fails closed if the deterministic pack is unavailable, reserves an EOS slot, and rejects any input token that the verified vocabulary cannot represent. These are admission-safety fixes, not proof of Neural Engine execution or production quality.

These are source changes, not retroactive repairs to build 176.

## Highest-priority remaining work

1. **One executable behavior contract:** create a versioned JSONL corpus for key events, grapheme deletion, secure transitions, protected spans, candidates, commits, and failure actions; run it against TypeScript and Swift before choosing a shared-engine technology.
2. **One real Windows vertical slice:** implement focus/session lifecycle, `ToUnicodeEx` key translation, typed JSON, `ITfEditSession`, composition update/commit/cancel, protected input scopes, and candidate application. A key must never be eaten unless equivalent text was successfully applied.
3. **Harden the daemon boundary:** validate every payload, bind request order and identity, add a user-only pipe ACL and server-owner verification, isolate real deadlines, persist safely, rate-limit learning, and recover independently of the companion.
4. **Build a real storage migration boundary:** never write JSON to `.sqlite3`; validate before transactional import; use versioned copy-and-promote migrations; retain rollback; and never persist reconstructable surrounding sentences.
5. **Add native CI:** macOS must compile Swift, run behavior probes, and test unsigned packaging; Windows must compile the TSF DLL and daemon, then exercise IPC and at least Notepad plus a dedicated password-field host.
6. **Obtain human language authority:** recruit experienced Traditional/LTK typists and Nepali linguists to approve the physical layout, correction policy, names, dictionary meanings, and ambiguous Romanized behavior.
7. **Prove neural value honestly:** evaluate with production overrides disabled, reconcile conflicting reports, measure both architectures, record actual compute-device evidence where available, and keep the deterministic path authoritative until gates pass.
8. **Reduce accidental complexity:** replace static giant data imports with a validated `PackRepository`, split project graphs, consolidate task orchestration and living documentation, and decompose files by change reason after behavior is characterized.

## No-Developer-ID release policy

| Channel | Permitted claim | Required gates |
| --- | --- | --- |
| Build from source | transparent developer/community build | pinned dependencies, documented commands, reproducible provenance, tests |
| Community Unsigned Preview | manually approved experimental QA binary | project-key signature, dependency-free verification, exact inventory, clean-account install/use/uninstall, explicit Gatekeeper limitations, no auto-update |
| Apple-trusted production | normal consumer distribution | Developer ID, notarization, stapling, native matrices, pilot evidence |

The first two channels remain valid without paying Apple. They are not renamed substitutes for the third.

## Non-negotiable release invariants

- No keystroke is lost, duplicated, or reordered; uncertainty fails open.
- Secure and uncertain fields cause zero suggestions, zero learning, zero retained text, and zero text diagnostics.
- No IPC payload touches engine or storage state before exact runtime validation.
- One behavior corpus defines platform semantics; reimplementations must conform.
- Benchmarks exclude runtime overrides and training/fixture leakage.
- Every shipped archive is bound to a clean source revision and authenticated under the published project key.
- Documentation distinguishes implemented, tested, experimentally packaged, human-validated, and production-eligible states.
- A release gate must be executable and evidence-producing; a source-string assertion is not runtime proof.

## Next release gate

Do not send another archive until all of the following are true:

1. Current source changes are committed to a stable revision.
2. A fresh universal macOS archive is built from that clean revision.
3. The archive passes its bundled verifier after normal Finder extraction.
4. Install, logout/login, System Settings approval, selection, typing, and uninstall are tested from a clean user account.
5. TextEdit and at least one browser/editor host pass Romanized typing, deletion, commit, candidate selection, protected-token, and secure-field smoke tests.
6. The message to the tester states that the build is unsigned, unnotarized, experimental, manually approved, and not the completed Windows/Traditional product.
