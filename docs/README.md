# Lekh Docs

Start here when changing the engine.

## Read First

1. `docs/ARCHITECTURE.md`
2. `docs/ENGINE_CONTRACT.md`
3. `docs/PHONOLOGY_CONTRACT.md`
4. `docs/DATA_POLICY.md`
5. `docs/DATA_SOURCES.md`
6. `docs/PRIVACY.md`
7. `docs/PUBLIC_CLAIMS_POLICY.md`

## Engine Areas

- Safety foundation: `docs/ENGINE_SAFETY_FOUNDATION.md`
- Lexical authority: `docs/LEXICAL_AUTHORITY.md`
- Phrase engine: `docs/PHRASE_ENGINE.md`
- Romanized inventory: `docs/ROMANIZED_ENGINE_INVENTORY.md`
- Romanized candidate engine: `docs/ROMANIZED_CANDIDATE_ENGINE.md`
- Romanized alias factory: `docs/ROMANIZED_ALIAS_FACTORY.md`
- Romanized confidence gate: `docs/ROMANIZED_CONFIDENCE_GATE.md`
- Proofread engine: `docs/PROOFREAD_ENGINE.md`
- Correction memory: `docs/CORRECTION_MEMORY.md`
- Legacy fonts: `docs/LEGACY_FONT_PROFILES.md`

## Validation

- Quality scorecard: `docs/ENGINE_QUALITY_SCORECARD.md`
- Current readiness status: `docs/CURRENT_PRODUCTION_READINESS_STATUS.md`
- Failure taxonomy: `docs/FAILURE_TAXONOMY.md`
- Real documents: `docs/REAL_DOCUMENT_COLLECTION_PROTOCOL.md`
- Competitor probes: `docs/COMPETITOR_PROBE_PROTOCOL.md`

## Product Boundary

- Input surface strategy: `docs/INPUT_SURFACE_STRATEGY.md`
- Niraj demo readiness: `docs/NIRAJ_DEMO_READINESS.md`
- Known limitations: `docs/KNOWN_LIMITATIONS.md`
- Roadmap: `docs/ROADMAP.md`

## Commands

```bash
npm run test
npm run build
npm run verify
npm run benchmark
npm run benchmark:romanized:self
npm run alias:romanized
npm run check:alias-collisions
npm run benchmark:proofread
npm run benchmark:competitor
npm run scorecard:engine
```

Do not claim SOTA, best, 99%, government-ready, native keyboard support, or competitor superiority unless the relevant locked evidence exists.
