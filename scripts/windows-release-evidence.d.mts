import type path from "node:path";

export function normalizeSha256Fingerprint(value: unknown): string | null;
export function isStrictDescendant(
  baseDirectory: string,
  candidate: string,
  pathApi?: typeof path,
): boolean;
export function hasSymbolicLinkInPath(
  baseDirectory: string,
  candidate: string,
  pathApi?: typeof path,
): boolean;
export const hasReleaseAliasInPath: typeof hasSymbolicLinkInPath;
export function windowsFileAttributesContainReparsePoint(attributes: unknown): boolean;
export function hasPortableExecutableMagic(file: string): boolean;
export function discoverPortableExecutables(directory: string): string[];
export function releaseTreeContainsAlias(directory: string): boolean;
export function signerInventoryMatches(
  entries: unknown,
  expectedSigner: unknown,
  expectedArtifacts: Iterable<string>,
): boolean;
export function artifactInventoriesMatch(expected: unknown, actual: unknown): boolean;
