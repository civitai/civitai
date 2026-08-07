import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';

export type UserSearchResult = { id: number; username: string | null; image: string | null };

export type UserSummary = { username: string | null; bannedAt: Date | null };

// Rows from ClickHouse and from aggregate queries carry user ids and no names; four places were each
// hand-rolling this hydration and had already drifted on the guard (one deduped, one filtered `> 0`,
// one did neither). Empty in / empty out, so callers do not need their own length check.
export async function usersByIds(ids: number[]): Promise<Map<number, UserSummary>> {
  const unique = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0);
  if (!unique.length) return new Map();

  const rows = await dbRead
    .selectFrom('User')
    .select(['id', 'username', 'bannedAt'])
    .where('id', 'in', unique)
    .execute();
  return new Map(rows.map((r) => [r.id, { username: r.username, bannedAt: r.bannedAt }]));
}

export async function searchUsers({
  query,
  limit = 10,
}: {
  query: string;
  limit?: number;
}): Promise<UserSearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  return dbRead
    .selectFrom('User')
    .select(['id', 'username', 'image'])
    .where('username', 'like', `${q}%`)
    .where('deletedAt', 'is', null)
    .where('id', '!=', -1)
    .orderBy(sql`length(username)`, 'asc')
    .limit(limit)
    .execute();
}
