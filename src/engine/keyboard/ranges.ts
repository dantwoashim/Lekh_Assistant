export type Utf16Range = [number, number];

interface GraphemeSegment {
  index: number;
}

interface GraphemeSegmenter {
  segment(input: string): Iterable<GraphemeSegment>;
}

type GraphemeSegmenterConstructor = new (
  locale: string,
  options: { granularity: "grapheme" }
) => GraphemeSegmenter;

const GraphemeSegmenterClass = (Intl as unknown as { Segmenter?: GraphemeSegmenterConstructor }).Segmenter;
const graphemeSegmenter = GraphemeSegmenterClass
  ? new GraphemeSegmenterClass("ne", { granularity: "grapheme" })
  : undefined;

export function validateRange(input: string, range: Utf16Range): boolean {
  const [start, end] = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > input.length) {
    return false;
  }
  const boundaries = graphemeBoundaries(input);
  return boundaries.includes(start) && boundaries.includes(end);
}

export function clampRange(input: string, range: Utf16Range): Utf16Range {
  const rawStart = clampNumericIndex(input, range[0]);
  const rawEnd = Math.max(rawStart, clampNumericIndex(input, range[1]));
  const boundaries = graphemeBoundaries(input);
  return [boundaryAtOrBefore(boundaries, rawStart), boundaryAtOrAfter(boundaries, rawEnd)];
}

export function sliceByUtf16Range(input: string, range: Utf16Range): string {
  const [start, end] = clampRange(input, range);
  return input.slice(start, end);
}

export function replaceByUtf16Range(input: string, range: Utf16Range, replacement: string): string {
  const [start, end] = clampRange(input, range);
  return `${input.slice(0, start)}${replacement}${input.slice(end)}`;
}

export function clampCaret(input: string, caret: number): number {
  return boundaryAtOrBefore(graphemeBoundaries(input), clampNumericIndex(input, caret));
}

export function deleteBeforeCaret(input: string, caret: number): { text: string; caret: number } {
  const boundaries = graphemeBoundaries(input);
  const safeCaret = boundaryAtOrAfter(boundaries, clampNumericIndex(input, caret));
  if (safeCaret === 0) return { text: input, caret: 0 };
  const start = previousBoundary(boundaries, safeCaret);
  return {
    text: replaceByUtf16Range(input, [start, safeCaret], ""),
    caret: start
  };
}

export function deleteAfterCaret(input: string, caret: number): { text: string; caret: number } {
  const boundaries = graphemeBoundaries(input);
  const safeCaret = boundaryAtOrBefore(boundaries, clampNumericIndex(input, caret));
  if (safeCaret >= input.length) return { text: input, caret: input.length };
  const end = nextBoundary(boundaries, safeCaret);
  return {
    text: replaceByUtf16Range(input, [safeCaret, end], ""),
    caret: safeCaret
  };
}

export function insertAtCaret(input: string, caret: number, value: string): { text: string; caret: number } {
  const safeCaret = clampCaret(input, caret);
  return {
    text: replaceByUtf16Range(input, [safeCaret, safeCaret], value),
    caret: safeCaret + value.length
  };
}

function graphemeBoundaries(input: string): number[] {
  if (graphemeSegmenter) {
    const boundaries = [0];
    for (const segment of graphemeSegmenter.segment(input)) {
      if (segment.index > boundaries[boundaries.length - 1]) boundaries.push(segment.index);
    }
    if (boundaries[boundaries.length - 1] !== input.length) boundaries.push(input.length);
    return boundaries;
  }

  // Supported runtimes provide Intl.Segmenter and that is the UAX #29
  // authority. This best-effort legacy fallback protects the highest-risk
  // combining-mark, Devanagari virama, variation-selector, emoji-modifier, and
  // ZWJ cases; it is deliberately not described as a complete UAX #29 engine.
  const boundaries = [0];
  let offset = 0;
  let previousScalar: number | undefined;
  for (const character of input) {
    const scalar = character.codePointAt(0);
    if (
      offset > 0 &&
      !isCombiningScalar(scalar) &&
      scalar !== 0x200d &&
      previousScalar !== 0x200d &&
      previousScalar !== 0x094d
    ) {
      boundaries.push(offset);
    }
    offset += character.length;
    previousScalar = scalar;
  }
  if (boundaries[boundaries.length - 1] !== input.length) boundaries.push(input.length);
  return boundaries;
}

function isCombiningScalar(scalar: number | undefined): boolean {
  if (scalar === undefined) return false;
  const character = String.fromCodePoint(scalar);
  return /\p{Mark}/u.test(character) ||
    (scalar >= 0xfe00 && scalar <= 0xfe0f) ||
    (scalar >= 0x1f3fb && scalar <= 0x1f3ff);
}

function clampNumericIndex(input: string, value: number): number {
  if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return 0;
  if (value === Number.POSITIVE_INFINITY) return input.length;
  return Math.max(0, Math.min(input.length, Math.trunc(value)));
}

function boundaryAtOrBefore(boundaries: number[], value: number): number {
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    if (boundaries[index] <= value) return boundaries[index];
  }
  return 0;
}

function boundaryAtOrAfter(boundaries: number[], value: number): number {
  for (const boundary of boundaries) {
    if (boundary >= value) return boundary;
  }
  return boundaries[boundaries.length - 1] ?? 0;
}

function previousBoundary(boundaries: number[], value: number): number {
  return boundaryAtOrBefore(boundaries, Math.max(0, value - 1));
}

function nextBoundary(boundaries: number[], value: number): number {
  return boundaryAtOrAfter(boundaries, value + 1);
}
