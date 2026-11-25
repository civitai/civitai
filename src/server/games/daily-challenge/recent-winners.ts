import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import type { ChallengeJudgingCategory } from '~/server/schema/challenge.schema';

// Categories whose score reflects originality, so a repeat of a recent winner can cost points.
export const FRESHNESS_CATEGORY_KEYS = new Set(['creativity', 'wordplay']);
export const FRESHNESS_CRITERIA_SUFFIX = ' Ideas that repeat a recent winner score lower.';

const RECENT_WINNER_LIMIT = 10;
const RECENT_WINNER_IDEA_MAX_LENGTH = 200;

/** True only for a stored rubric whose page tells entrants that repeats score lower. */
export function hasFreshnessCategory(categories: { key: string; criteria: string }[] | undefined) {
  return !!categories?.some(
    (c) => FRESHNESS_CATEGORY_KEYS.has(c.key) && c.criteria.endsWith(FRESHNESS_CRITERIA_SUFFIX)
  );
}

/** The rubric a System daily stores and shows: freshness categories say that repeats score lower. */
export function withFreshnessCriteria(categories: ChallengeJudgingCategory[]) {
  return categories.map((c) =>
    FRESHNESS_CATEGORY_KEYS.has(c.key) && !c.criteria.endsWith(FRESHNESS_CRITERIA_SUFFIX)
      ? { ...c, criteria: c.criteria + FRESHNESS_CRITERIA_SUFFIX }
      : c
  );
}

/**
 * Why the latest System daily winners won, as one-line data for the review prompt. The reasons
 * were written by the judge from entrants' images, so they are capped and flattened here and
 * presented under the untrusted-fields preamble. An SFW challenge reads only winners of SFW
 * challenges whose image is still scanned SFW today (it may have been re-rated since it won), since
 * the description would reach an SFW prompt; a winner whose image is gone, blocked or held for
 * review is always skipped.
 */
export async function getRecentWinnerIdeas(
  excludeChallengeId: number,
  { sfwOnly }: { sfwOnly: boolean }
): Promise<string[]> {
  const sfwFilter = sfwOnly
    ? Prisma.sql`AND c."allowedNsfwLevel" <> 0 AND (c."allowedNsfwLevel" & ${nsfwBrowsingLevelsFlag}) = 0
      AND i."nsfwLevel" <> 0 AND (i."nsfwLevel" & ${nsfwBrowsingLevelsFlag}) = 0
      AND i.ingestion = 'Scanned'`
    : Prisma.empty;
  const rows = await dbRead.$queryRaw<{ reason: string }[]>`
    SELECT cw.reason
    FROM "ChallengeWinner" cw
    JOIN "Challenge" c ON c.id = cw."challengeId"
    JOIN "Image" i ON i.id = cw."imageId"
    WHERE c.source = 'System'
      AND c.id <> ${excludeChallengeId}
      AND cw.reason IS NOT NULL
      AND i."blockedFor" IS NULL
      AND i."needsReview" IS NULL
      ${sfwFilter}
    ORDER BY cw."createdAt" DESC
    LIMIT ${RECENT_WINNER_LIMIT}
  `;
  return rows
    .map((r) => r.reason.replace(/\s+/g, ' ').trim().slice(0, RECENT_WINNER_IDEA_MAX_LENGTH))
    .filter(Boolean);
}
