import { Prisma } from '@prisma/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import type { VersionReadiness } from '~/shared/generation/generator-readiness';
import { isGeneratorReady } from '~/shared/generation/generator-readiness';

/**
 * Which of `GenerationCoverage`'s two rules answers, for this request.
 *
 * Read it ONCE per request and pass the answer down: a value that changed mid-request would have one
 * reader covering a version another refused.
 */
export async function nextCoverageEnabled() {
  return isFlipt(FLIPT_FEATURE_FLAGS.GENERATION_COVERAGE_NEXT);
}

/**
 * The coverage rule AND the audience for it, resolved once per request.
 *
 * `member` reads true while the expansion is off, where it is meaningless: every consumer takes
 * the live rule regardless.
 */
export async function coverageAudience(user?: {
  id?: number;
  tier?: string;
  isModerator?: boolean;
}) {
  const next = await nextCoverageEnabled();
  if (!next) return { next, member: true };
  const openToAll = await isFlipt(
    FLIPT_FEATURE_FLAGS.GENERATION_LOADING_OPEN_TO_ALL,
    String(user?.id ?? 0)
  );
  // Moderators keep it whatever their tier, matching `isGatedFor.members` in gates.ts.
  const member = !!user?.isModerator || (user?.tier ?? 'free') !== 'free';
  return { next, member: openToAll || member };
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

/**
 * Whether THIS user may generate with the row, once the expansion is on.
 *
 * A non-member reads the live rule, plus an expansion CHECKPOINT that is already READY — resident,
 * or externally served. There is no download left for them to start, which is the only thing the
 * expansion costs. The non-checkpoint half is file-format support, not download cost, so it is
 * never gated.
 */
export function coveredForUser(
  row: (CoverageColumns & VersionReadiness) | null | undefined,
  next: boolean,
  audience: { member: boolean; isCheckpoint: boolean }
): boolean | null {
  if (!next || audience.member || !audience.isCheckpoint) return pickCovered(row, next);
  const live = pickCovered(row, false);
  if (live) return true;
  if (row?.coveredNext && isGeneratorReady(row)) return true;
  return live;
}

/**
 * The SQL form of `coveredForUser`, as a predicate over a `GenerationCoverage` row.
 *
 * Self-contained: the residency and type facts live on `ModelVersion`/`Model`, and the callers
 * that need this are filtering `GenerationCoverage` alone, so it carries its own EXISTS rather
 * than making every call site add two joins.
 */
export function coveredForUserSql(
  audience: { next: boolean; member: boolean },
  coverageAlias = '"GenerationCoverage"'
): Prisma.Sql {
  const gc = Prisma.raw(coverageAlias);
  const column = Prisma.raw(`"${coverageColumn(audience.next)}"`);
  if (!audience.next || audience.member) return Prisma.sql`${gc}.${column}`;
  return Prisma.sql`(
    ${gc}."covered"
    OR (
      ${gc}."coveredNext"
      AND EXISTS (
        SELECT 1 FROM "ModelVersion" mv_cov
        JOIN "Model" m_cov ON m_cov.id = mv_cov."modelId"
        WHERE mv_cov.id = ${gc}."modelVersionId"
          AND (
            m_cov.type <> 'Checkpoint'::"ModelType"
            OR mv_cov."generatorLoaded"
            OR mv_cov."usageControl" = 'ExternalGeneration'::"ModelUsageControl"
          )
      )
    )
  )`;
}

type WithCoverage = {
  generationCoverage: { covered: boolean; coveredNext: boolean } | null;
};

export function coveredBy(version: WithCoverage, next: boolean) {
  return pickCovered(version.generationCoverage, next) ?? undefined;
}

/** `coveredForUser` over a version carrying its coverage as a relation. */
export function coveredByForUser(
  /**
   * `generatorLoaded` is required, not `VersionReadiness`-optional: a select that omits it would
   * otherwise compile and read as cold, quietly refusing a non-member a version that IS resident.
   */
  version: WithCoverage & { generatorLoaded: boolean | null; usageControl?: string | null },
  next: boolean,
  audience: { member: boolean; isCheckpoint: boolean }
) {
  return (
    coveredForUser(
      version.generationCoverage
        ? {
            ...version.generationCoverage,
            generatorLoaded: version.generatorLoaded,
            usageControl: version.usageControl,
          }
        : null,
      next,
      audience
    ) ?? undefined
  );
}
