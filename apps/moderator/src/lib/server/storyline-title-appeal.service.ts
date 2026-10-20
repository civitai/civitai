import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { callModEndpoint } from './user-actions.service';

export type StorylineTitleAppealRow = {
  appealId: number;
  appealMessage: string;
  appealCreatedAt: Date;
  storylineId: number;
  title: string;
  userId: number;
  username: string | null;
  tosViolationByScan: boolean;
  tosViolationByModerator: boolean;
};

export async function getStorylineTitleAppeals({
  limit,
  offset = 0,
}: {
  limit: number;
  offset?: number;
}) {
  const rows = await sql<StorylineTitleAppealRow>`
    SELECT a.id AS "appealId", a."appealMessage", a."createdAt" AS "appealCreatedAt",
           s.id AS "storylineId", s.title, s."userId", u.username,
           s."tosViolationByScan", s."tosViolationByModerator"
    FROM "Appeal" a
    JOIN "Storyline" s ON s.id = a."entityId"
    LEFT JOIN "User" u ON u.id = s."userId"
    WHERE a."entityType"::text = 'Storyline'
      AND a.status::text = 'Pending'
      AND a."entityRemovedAt" IS NULL
    ORDER BY a."createdAt", a.id
    LIMIT ${limit + 1} OFFSET ${offset}
  `.execute(dbRead);

  return { items: rows.rows.slice(0, limit), hasMore: rows.rows.length > limit };
}

/**
 * `reviewedTitle` is the title the moderator was shown, not a fresh read: the main app refuses a
 * grant for a title edited since.
 */
export async function resolveStorylineTitleAppeal(
  storylineId: number,
  grant: boolean,
  reviewedTitle: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await callModEndpoint(
    'storyline/resolve-title-appeal',
    { storylineId, grant, reviewedTitle },
    grant ? 'Grant appeal' : 'Deny appeal'
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
