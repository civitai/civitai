import { dbRead } from '~/server/db/client';
import type { ChallengeJudgingCategory } from '~/server/schema/challenge.schema';

// Categories whose score reflects originality, so a repeat of a recent winner can cost points.
export const FRESHNESS_CATEGORY_KEYS = new Set(['creativity', 'wordplay']);
export const FRESHNESS_CRITERIA_SUFFIX = ' Ideas that repeat a recent winner score lower.';

const RECENT_WINNER_LIMIT = 10;
const RECENT_WINNER_IDEA_MAX_LENGTH = 200;

export function hasFreshnessCategory(categories: { key: string }[] | undefined) {
  return !!categories?.some((c) => FRESHNESS_CATEGORY_KEYS.has(c.key));
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
 * presented under the untrusted-fields preamble.
 */
export async function getRecentWinnerIdeas(excludeChallengeId: number): Promise<string[]> {
  const rows = await dbRead.$queryRaw<{ reason: string }[]>`
    SELECT cw.reason
    FROM "ChallengeWinner" cw
    JOIN "Challenge" c ON c.id = cw."challengeId"
    WHERE c.source = 'System'
      AND c.id <> ${excludeChallengeId}
      AND cw.reason IS NOT NULL
    ORDER BY cw."createdAt" DESC
    LIMIT ${RECENT_WINNER_LIMIT}
  `;
  return rows
    .map((r) => r.reason.replace(/\s+/g, ' ').trim().slice(0, RECENT_WINNER_IDEA_MAX_LENGTH))
    .filter(Boolean);
}
