import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';

export type UserSearchResult = { id: number; username: string | null; image: string | null };

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
