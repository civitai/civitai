import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';

/**
 * Which of `GenerationCoverage`'s two rules answers, for this request.
 *
 * Read it ONCE per request and pass the answer down: a value that changed mid-request would have one
 * reader covering a version another refused.
 */
export async function nextCoverageEnabled() {
  return isFlipt(FLIPT_FEATURE_FLAGS.GENERATION_COVERAGE_NEXT);
}

export function coverageColumn(next: boolean) {
  return next ? 'coveredNext' : 'covered';
}

type CoverageColumns = { covered?: boolean | null; coveredNext?: boolean | null };

/**
 * Every read goes through here rather than restating `next ? coveredNext : covered`, so switching
 * the flag cannot leave one surface answering under the other rule; `no-divergent-coverage-read`
 * keeps the ternary out of the rest of `src/`.
 */
export function pickCovered(
  row: CoverageColumns | null | undefined,
  next: boolean
): boolean | null {
  return (next ? row?.coveredNext : row?.covered) ?? null;
}

type WithCoverage = {
  generationCoverage: { covered: boolean; coveredNext: boolean } | null;
};

export function coveredBy(version: WithCoverage, next: boolean) {
  return pickCovered(version.generationCoverage, next) ?? undefined;
}
