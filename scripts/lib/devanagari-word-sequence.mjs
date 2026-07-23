const devanagariBlockStart = 0x0900;
const devanagariBlockEnd = 0x097F;
const virama = "\u094D";
const nukta = "\u093C";
const joiners = new Set(["\u200C", "\u200D"]);
const syllableModifiers = new Set(["\u0900", "\u0901", "\u0902", "\u0903"]);
const dependentVowelSigns = new Set([
  ...codePointRange(0x093A, 0x093B),
  ...codePointRange(0x093E, 0x094C),
  "\u094E",
  "\u094F",
  ...codePointRange(0x0955, 0x0957),
  "\u0962",
  "\u0963"
]);
const unicodeLetter = /^\p{L}$/u;
const unicodeMark = /^\p{M}$/u;
const unicodeNumber = /^\p{N}$/u;
const unicodePunctuation = /^\p{P}$/u;
const unicodeWhitespace = /^\s$/u;

export const DEVANAGARI_WORD_SEQUENCE_VALIDATOR_ID = "devanagari-word-sequence-v1";

/**
 * Conservatively validates a single NFC Devanagari word for scalar decoding.
 *
 * The validator deliberately does not adjudicate lexical spelling. Adjacent
 * letters and explicit halant boundaries remain legal, including terminal
 * VIRAMA and VIRAMA followed by another Devanagari letter. It rejects only
 * scalar/category violations and mark/joiner orders that are structurally
 * unambiguous.
 */
export function validateDevanagariWordSequence(value) {
  const text = String(value ?? "");
  const issueCodes = [];
  const addIssue = (code) => {
    if (!issueCodes.includes(code)) issueCodes.push(code);
  };

  if (!text) addIssue("empty");
  if (text !== text.normalize("NFC")) addIssue("not-nfc");

  const scalars = [...text];
  let baseKind = null;
  let dependentVowelSeen = false;
  let nuktaSeen = false;
  let afterVirama = false;
  let modifierSeen = false;
  let precedingMark = null;

  for (let index = 0; index < scalars.length; index += 1) {
    const scalar = scalars[index];
    const previous = scalars[index - 1];
    const next = scalars[index + 1];

    if (unicodeWhitespace.test(scalar)) {
      addIssue("whitespace");
      resetUnit();
      continue;
    }
    if (unicodeNumber.test(scalar)) {
      addIssue("digit");
      resetUnit();
      continue;
    }
    if (unicodePunctuation.test(scalar)) {
      addIssue("punctuation");
      resetUnit();
      continue;
    }

    if (joiners.has(scalar)) {
      if (previous !== virama) addIssue("joiner-not-after-virama");
      if (!isDevanagariConsonant(next)) addIssue("joiner-not-before-consonant");
      if (previous !== virama || !isDevanagariConsonant(next)) resetUnit();
      continue;
    }

    if (!isDevanagariBlockScalar(scalar)) {
      addIssue("unsupported-scalar");
      resetUnit();
      continue;
    }

    if (isDevanagariLetter(scalar)) {
      baseKind = isDevanagariConsonant(scalar) ? "consonant" : "other-letter";
      dependentVowelSeen = false;
      nuktaSeen = false;
      afterVirama = false;
      modifierSeen = false;
      precedingMark = null;
      continue;
    }

    if (scalar === nukta) {
      if (baseKind !== "consonant" || afterVirama || dependentVowelSeen || modifierSeen) {
        addIssue("orphan-or-misordered-nukta");
      } else if (nuktaSeen) {
        addIssue("duplicate-nukta");
      }
      nuktaSeen = true;
      precedingMark = scalar;
      continue;
    }

    if (scalar === virama) {
      if (baseKind !== "consonant" || afterVirama) addIssue("virama-without-consonant");
      if (dependentVowelSeen) addIssue("virama-after-dependent-vowel-sign");
      if (modifierSeen) addIssue("virama-after-syllable-modifier");
      afterVirama = true;
      precedingMark = scalar;
      continue;
    }

    if (dependentVowelSigns.has(scalar)) {
      if (afterVirama) addIssue("dependent-vowel-sign-after-virama");
      if (baseKind !== "consonant") addIssue("dependent-vowel-sign-without-consonant");
      if (dependentVowelSeen) addIssue("multiple-dependent-vowel-signs");
      if (modifierSeen) addIssue("dependent-vowel-sign-after-syllable-modifier");
      dependentVowelSeen = true;
      precedingMark = scalar;
      continue;
    }

    if (syllableModifiers.has(scalar) || unicodeMark.test(scalar)) {
      if (afterVirama) addIssue("mark-after-virama");
      else if (baseKind === null) addIssue("mark-without-base");
      if (precedingMark === scalar) addIssue("duplicate-mark");
      modifierSeen = true;
      precedingMark = scalar;
      continue;
    }

    addIssue("unsupported-devanagari-scalar");
    resetUnit();
  }

  return Object.freeze({
    valid: issueCodes.length === 0,
    issueCodes: Object.freeze(issueCodes),
    primaryIssueCode: issueCodes[0] ?? null
  });

  function resetUnit() {
    baseKind = null;
    dependentVowelSeen = false;
    nuktaSeen = false;
    afterVirama = false;
    modifierSeen = false;
    precedingMark = null;
  }
}

export function isValidDevanagariWordSequence(value) {
  return validateDevanagariWordSequence(value).valid;
}

/** Keeps the primary target first even when an explicit alias list omits it. */
export function partitionDevanagariWordTargets(primaryTarget, aliases = []) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const candidate of [primaryTarget, ...(Array.isArray(aliases) ? aliases : [])]) {
    const value = String(candidate ?? "");
    if (seen.has(value)) continue;
    seen.add(value);
    const validation = validateDevanagariWordSequence(value);
    if (validation.valid) accepted.push(value);
    else rejected.push(Object.freeze({ value, issueCodes: validation.issueCodes, primaryIssueCode: validation.primaryIssueCode }));
  }
  return Object.freeze({ accepted: Object.freeze(accepted), rejected: Object.freeze(rejected) });
}

function isDevanagariBlockScalar(value) {
  if (!value) return false;
  const codePoint = value.codePointAt(0);
  return codePoint >= devanagariBlockStart && codePoint <= devanagariBlockEnd;
}

function isDevanagariLetter(value) {
  return isDevanagariBlockScalar(value) && unicodeLetter.test(value);
}

function isDevanagariConsonant(value) {
  if (!value) return false;
  const codePoint = value.codePointAt(0);
  return (codePoint >= 0x0915 && codePoint <= 0x0939) ||
    (codePoint >= 0x0958 && codePoint <= 0x095F) ||
    (codePoint >= 0x0978 && codePoint <= 0x097F);
}

function codePointRange(start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => String.fromCodePoint(start + index));
}
