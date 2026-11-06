import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';

export type StorylineEarlyAccessSignupRow = {
  userId: number;
  username: string | null;
  /** Where they signed up from; the storyline may have been deleted since. */
  storylineId: number | null;
  storylineTitle: string | null;
  createdAt: Date;
};

/** Newest first, so a sign-up from today is on the first page. */
export async function getStorylineEarlyAccessSignups({
  limit,
  offset = 0,
}: {
  limit: number;
  offset?: number;
}) {
  const [rows, count] = await Promise.all([
    sql<StorylineEarlyAccessSignupRow>`
      SELECT s."userId", u.username, s."storylineId", st.title AS "storylineTitle", s."createdAt"
      FROM "StorylineEarlyAccessSignup" s
      LEFT JOIN "User" u ON u.id = s."userId"
      LEFT JOIN "Storyline" st ON st.id = s."storylineId"
      ORDER BY s."createdAt" DESC, s."userId" DESC
      LIMIT ${limit} OFFSET ${offset}
    `.execute(dbRead),
    sql<{ total: number }>`
      SELECT COUNT(*)::int AS total FROM "StorylineEarlyAccessSignup"
    `.execute(dbRead),
  ]);
  return { items: rows.rows, total: count.rows[0]?.total ?? 0 };
}
