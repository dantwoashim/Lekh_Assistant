# Real Document Collection Packet

Synthetic and round-trip fixtures are regression tools. Real legacy-font quality claims require consented documents from actual target workflows.

## Current Status

| Item | Status |
| --- | --- |
| Consented Preeti documents collected | 0 |
| Consented Kantipur documents collected | 0 |
| Consented Sagarmatha documents collected | 0 |
| Raw documents committed | No |
| Intake script available | `npm run ingest:preeti-real -- data/private/preeti-real-manifest.json` |

Do not scrape public PDFs, forums, school notices, government letters, or private-like documents into this repository. A document counts only if the owner or authorized holder explicitly permits validation use.

## Target Quotas

| Domain | Target | Examples |
| --- | ---: | --- |
| Office/government/admin | 10-15 | notices, applications, forms, recommendation letters, registers |
| School/admin | 8-12 | certificates, result notices, fee letters, attendance documents |
| Legal/accounting | 5-10 | letters, statements, case/admin notes, receipt-style documents |
| Mixed tables/forms/letters | 5-10 | spreadsheets, tabular PDFs, copy-pasted forms, mixed English/Nepali text |

## Permission Text

Use plain written consent:

```text
I give permission for Lekh maintainers to use this document only for Nepali legacy-font conversion validation. Private names, phone numbers, IDs, addresses, and institution-specific details may be redacted. Raw documents will not be published or committed. De-identified examples may be converted into test fixtures only after review.
```

Record the signer role, date, document domain, source format, font profile if known, and any required redactions.

## Intake Steps

1. Put raw files and the manifest under ignored `data/private/`.
2. Fill `src/data/validation/preeti-real-manifest.example.json` fields for each document.
3. Run `npm run ingest:preeti-real -- data/private/preeti-real-manifest.json`.
4. Review generated outputs under ignored `data/generated/`.
5. Promote only de-identified, permission-backed cases into benchmark fixtures.
6. Update `docs/ENGINE_QUALITY_SCORECARD.md` and `docs/CURRENT_PRODUCTION_READINESS_STATUS.md` with counts, exact match, warning rate, and top failure categories.

## Review Checklist

- Written permission exists.
- Raw file is not committed.
- Names, IDs, phone numbers, addresses, and institution-specific private details are redacted.
- Font profile is tagged: Preeti, Kantipur, Sagarmatha, Himalb, unknown, or mixed.
- Segments are labeled as sentence, table, form, heading, list, or paragraph.
- Failure type is tagged: matra, reph, conjunct, unknown glyph, English preservation, punctuation, spacing, line break, or layout.
- Expected Unicode output passes `normalizeNepaliText`.

## Release Rule

Until at least 30 consented documents are collected and reported, describe Preeti quality as fixture-validated and controlled-test-ready, not real-document validated.
