# C3 Traditional / Preeti Corpus Results

Measured on 2026-07-21 at revision
`f76993ce23d295705636fd9eef034813cb8c4a43`. No Traditional mapping or Preeti
conversion behavior was changed for this checklist item.

## Traditional physical-layout corpus

Commands:

```sh
npm run audit:traditional-layout
npm run audit:traditional-layout:final
```

| Measurement | Result |
|---|---|
| Pending-scaffold audit | Passed 1/1 structural fixture |
| Scorable physical key mappings | 0 |
| Physical-layout output pass rate | Not measurable; the sole fixture intentionally has `expectedOutput: null` |
| Verified final layout files present | 0/2 (0%) |
| Existing final-layout threshold | Failed; `implementationAllowed: false` |

The normal audit passed because it correctly kept both placeholder layouts
pending, empty, and unavailable for production mapping. The repository's
existing final audit failed because neither
`data/layouts/traditional-ltk-compatible.json` nor
`data/layouts/traditional-standard.json` exists. C3 therefore applies a
**Beta** label to every user-visible Traditional mode. Experienced-typist
validation remains outside the v1.0 release scope.

Focused deterministic tests were also run:

```sh
npx vitest run src/engine/traditional/traditional.test.ts \
  src/engine/keyboard/keyboardEngine.test.ts \
  src/core/preeti/convertPreetiToUnicode.test.ts \
  --pool=forks --maxWorkers=1
```

Result: 3 files / 90 tests passed.

## Preeti conversion corpus

Commands:

```sh
npm run benchmark:preeti
npm run report:preeti
```

| Corpus slice | Exact matches | Exact-match rate |
|---|---:|---:|
| Manual benchmark | 200/200 | 100% |
| Generated dictionary round trips | 9,920/9,920 | 100% |
| Held out | 55/55 | 100% |
| Competitor-probe expected outputs | 50/50 | 100% |
| Full benchmark | 10,225/10,225 | 100% |

The full benchmark reported 0 character errors, 0 word errors, 100% English
preservation, 100% line-break preservation, no remaining failures, 26/26 fuzz
cases passing their exact/safety rule, and 15/15 generated atom-decoder round
trips exact. The separate quality report passed 10,005/10,005 locked fixtures.

These are repository fixtures, not a real-document claim: 9,920 rows are
generated dictionary round trips and the user-submitted bucket contains 0
rows. Preeti remains an as-is side utility with that limitation documented.

## Beta-label verification

Implemented at revision `5f6b58109a97f6e0237d08cd1170f138fe2073ec`.

```text
npx vitest run src/tests/app-smoke.test.tsx --pool=forks --maxWorkers=1
Test Files  1 passed (1)
Tests       17 passed (17)

npx vitest run native/macos-imk/skeleton/macosImkSource.test.ts --pool=forks --maxWorkers=1
Test Files  1 passed (1)
Tests       25 passed (25)

npm run format:check
Format check passed.
```

The label implementation passed all four jobs in
[CI run 29845558182](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29845558182),
including macOS ARM64 job
[88685226829](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29845558182/job/88685226829)
and macOS Intel x64 job
[88685226810](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29845558182/job/88685226810).
