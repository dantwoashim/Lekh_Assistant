# Keyboard Corpus Quarantine

Raw/public source files are treated as quarantined research inputs. They are not runtime data and should not be bundled into the app.

- Cached parquet files live under `.tmp/keyboard-corpus-cache/` for repeatable local builds.
- `.tmp/` is ignored by git.
- Any copied raw files must go under `data/keyboard-corpus/quarantine/raw/`, which is ignored by the local quarantine `.gitignore`.
- Only redacted, normalized, deduplicated D1-D8 JSONL outputs move into `curated/v0.1/`.
