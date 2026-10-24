import { sql } from '@civitai/db/kysely';
import type { dbRead } from '$lib/server/db';

/**
 * Which of `ids` follow `ownerId` now. A primary-key probe per id, so the cost is bounded by `ids.length` and
 * never by how many followers the owner has.
 */
export async function followersAmong(
  db: typeof dbRead,
  ownerId: number,
  ids: number[]
): Promise<Set<number>> {
  const followers = new Set<number>();
  if (!ids.length) return followers;
  // `= ANY($1)` and not an `in` list: kysely expands `in` to one placeholder per id, and a heavy creator's reactor
  // set is past Postgres' 65535-parameter ceiling.
  const { rows } = await sql<{ userId: number }>`
    SELECT "userId" FROM "UserEngagement"
    WHERE "targetUserId" = ${ownerId} AND "type" = 'Follow' AND "userId" = ANY(${ids})
  `.execute(db);
  for (const row of rows) followers.add(Number(row.userId));
  return followers;
}
