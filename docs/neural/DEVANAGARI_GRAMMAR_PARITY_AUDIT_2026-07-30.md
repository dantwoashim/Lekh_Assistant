# Devanagari neural-output grammar parity audit — 2026-07-30

## Scope

The Transformer-CTC model emits one Unicode scalar per output class. During
prefix-beam search, malformed scalar sequences are removed before they can
become suggestions. This audit verifies that the JavaScript dataset/evaluation
validator, the authenticated Python exporter validator, and the native Swift
runtime make the same decision for every short prefix constructible from the
model's production output alphabet.

This pass does not train a model, alter a checkpoint, change either
authenticated Transformer-CTC source file, or broaden the model vocabulary.

## Authoritative Unicode rules

The validator is a deliberately narrow Nepali word-candidate policy, grounded
in these Unicode 17.0 rules:

- Devanagari text is stored in phonetic order. A dependent vowel sign follows
  its consonant in memory.
- U+094D VIRAMA suppresses a consonant's inherent vowel. A consonant followed
  by VIRAMA is a valid dead consonant.
- U+093C NUKTA follows its consonant and precedes VIRAMA.
- ZWJ and ZWNJ may follow a dead consonant to control half-form or explicit
  halant shaping. A complete conjunct may continue with another consonant.
- Extended grapheme boundaries retain Devanagari combining signs and
  virama-linked consonant sequences as units suitable for text processing.

Primary sources:

- [Unicode 17.0, Chapter 12: Devanagari](https://www.unicode.org/versions/Unicode17.0.0/core-spec/chapter-12/)
- [Unicode 17.0 Indic Syllabic Category data](https://www.unicode.org/Public/17.0.0/ucd/IndicSyllabicCategory.txt)
- [Unicode 17.0 character database](https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt)
- [Unicode Standard Annex #29: Text Segmentation](https://www.unicode.org/reports/tr29/)
- [Unicode Indic scripts FAQ](https://www.unicode.org/faq/indic.html)

The exact versioned files inspected for this audit had these SHA-256 values:

```text
IndicSyllabicCategory.txt  3fc122f4cf58b0c19268d5f810263b04ab4e1e67743386ec0e0ada9c76aec5be
UnicodeData.txt            2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c
```

The validator's consonant ranges exactly match the three Devanagari
`Indic_Syllabic_Category=Consonant` ranges. Its dependent-vowel ranges exactly
match all Devanagari `Vowel_Dependent` entries in the main U+0900–U+097F block.

## Runtime-version risk and closed oracle

At audit time, the repository's JavaScript runtime used Unicode 17.0 while the
bundled Python runtime exposed Unicode 15.0. Swift character properties follow
the deployed macOS runtime. Unicode general-category lookups therefore cannot
be assumed equivalent merely because the source code looks equivalent.

The shared decoder contract now freezes an executable oracle:

```text
oracle id             ctc-output-vocabulary-cartesian-prefixes-v1
alphabet              65 audited Transformer-CTC output scalars
enumeration           every ordered sequence of length 1, 2, and 3
sequences             278,915
valid prefixes        181,035
terminable sequences  181,035
serialized SHA-256    91c9d9f1918a96927b0a0e0c4a31ded1619553efac5ce585117dd9774995632e
```

Each implementation independently serializes the input sequence, valid-prefix
bit, terminable bit, and ordered issue-code list, then verifies the same digest
and counts. The JavaScript and Python tests also prove that the 65 oracle
tokens exactly equal the output vocabulary recorded by the locked CTC
alignment audit. This covers all 65 single-scalar decisions, all 4,225
two-scalar transitions, and all 274,625 three-scalar transitions.

Longer state interactions are covered by explicit shared cases, including
NUKTA before and after VIRAMA, ZWJ and ZWNJ conjuncts, joiners followed by an
independent vowel or another joiner, dependent signs after an independent
vowel, canonical-decomposition rejection, Vedic stress-mark ordering, and the
four rarest production scalars.

## Defect found and fixed

The first native oracle run found a real divergence. Swift checked NFC with:

```swift
value != value.precomposedStringWithCanonicalMapping
```

Swift `String` equality compares canonically equivalent text as equal. It
therefore accepted U+0958 DEVANAGARI LETTER QA (`क़`) even though NFC expands
that composition-exclusion character to U+0915 U+093C (`क़`). It likewise
could not detect canonically misordered combining marks. JavaScript and Python
compare their normalized strings by code point and correctly rejected both
forms as non-NFC.

The native validator now compares the original and normalized
`Unicode.Scalar` arrays. That preserves Swift's user-friendly canonical
equivalence everywhere else while making this security and decoder boundary
byte-stable. The shared fixtures permanently cover both U+0958 and a
misordered Vedic stress-mark pair.

## Intentional policy boundaries

Unicode permits a terminal `<consonant, VIRAMA, ZWJ>` sequence to request an
independent half-form. Lekh treats a trailing joiner as a valid unfinished
prefix but not as a committable word candidate. This prevents an invisible
shaping control from being committed as a standalone neural suggestion.
Complete `<consonant, VIRAMA, ZWJ/ZWNJ, consonant>` sequences remain accepted.

This distinction cannot suppress a current model prediction: neither joiner
is present in the 65-class production output alphabet.

Vedic extensions and stress marks outside that alphabet are likewise not a
Transformer-CTC production surface. The validator may recognize some of them
for defensive completeness, but this audit makes no claim that the neural
model can emit arbitrary Sanskrit or Vedic orthography.

## Result

The frozen 1,048,532-row CTC dataset audit already reports zero invalid target
variants and zero rows without a representable target. The new closed oracle
adds exhaustive cross-runtime prefix parity over the actual neural output
alphabet. After correcting the native NFC comparison, JavaScript, Python, and
Swift produce the same digest and counts. Neither authenticated training source
was changed.

The remaining model-readiness blocker is empirical candidate quality from a
completed authenticated GPU result, not Devanagari scalar-order compatibility.

## Low-heat verification

```text
vitest: shared cases and 278,915-sequence JavaScript oracle
Python trainer contract: shared cases and 278,915-sequence Python oracle
native Swift unit probe: shared cases and 278,915-sequence Swift oracle
runtime-manifest conformance: frozen oracle metadata and inventory
production contract: grammar audit, vocabulary binding, and native test source
```

These checks perform no training or Core ML conversion.
