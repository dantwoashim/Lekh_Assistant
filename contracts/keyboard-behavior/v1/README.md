# Lekh keyboard behavior contract v1

`lekh-keyboard-behavior.v1.jsonl` is the normative, platform-neutral contract
for keyboard behavior that can lose, corrupt, disclose, or unexpectedly rewrite
user text. Each non-empty line is one independent case. Cases are versioned,
deterministic, and ordered by stable `id`.

The contract fixes observable behavior, not implementation structure. A native
adapter may use a different candidate engine or composition API, but it must
produce the same normalized action and state for every case.

## Covered invariants

- offsets and carets at native boundaries use UTF-16 code units;
- edits never split an extended grapheme cluster;
- secure, password, code, and unknown contexts retain no composition,
  surrounding text, candidates, proof hints, or commit history;
- protected spans remain byte-exact;
- passive delimiters preserve raw input unless an explicit, evidence-bounded
  policy authorizes another result;
- explicit candidate acceptance, raw commit, cancellation, and failure actions
  are distinct;
- malformed input and backend failure preserve user text and fail open.

## Running both implementations

From the repository root, run the TypeScript implementation through the Vite
runtime so repository data loaders are available:

```sh
npm run check:behavior-contract
```

Run the independent Swift implementation:

```sh
swift run --package-path native/macos-imk/skeleton \
  LekhBehaviorContractRunner \
  contracts/keyboard-behavior/v1/lekh-keyboard-behavior.v1.jsonl
```

Both commands emit the same canonical JSONL evidence on standard output and a
human summary on standard error. Redirect their standard output and compare it
byte-for-byte to produce the differential report. Any unsupported case,
unrecognized field, duplicate identifier, assertion mismatch, or malformed
line is a hard failure.

## Change discipline

Behavior changes require a new or updated corpus case, review of the privacy and
text-loss implications, and passing reports from every supported runtime. A
breaking semantic change increments the versioned directory and
`contractVersion`; it does not silently rewrite historical evidence.
