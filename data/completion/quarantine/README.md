# Token-completion quarantine

The completion pipeline is intentionally isolated from the general transliteration,
phrase, name, social-text, and context corpora. `source-dispositions.v1.json`
records why each existing source is ineligible for direct token-completion use.

No raw external or private text belongs here. A source may move into the runtime
completion pipeline only after row-level provenance, redistribution rights,
single-token validation, name/PII screening, native-speaker review, and a frozen
holdout have all passed.
