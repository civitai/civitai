/**
 * The indexed half of the coverage switch. `GenerationCoverage`'s two columns are indexed as two
 * fields, and the Flipt flag decides which one is live — the server filters the search by it and the
 * client re-checks the same field on the hits it gets back. Both sides read it from here so they
 * cannot end up gating on different rules; `no-divergent-coverage-read` keeps the choice here.
 *
 * Client-safe on purpose: the server resolves the flag, and passes the answer down as a boolean.
 */

export type CoverageIndexField = 'canGenerate' | 'canGenerateNext';

export function coverageIndexField(coverageNext?: boolean): CoverageIndexField {
  return coverageNext ? 'canGenerateNext' : 'canGenerate';
}

export function versionCanGenerate(
  version: { canGenerate?: boolean; canGenerateNext?: boolean },
  coverageNext?: boolean
) {
  return version[coverageIndexField(coverageNext)];
}
