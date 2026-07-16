import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

export type UserSearchResult = { id: number; username: string | null; image: string | null };

// Prefix username search — `username LIKE 'query%'`, excludes deleted users + the system user (-1),
// shortest username first (best prefix hits), limited. Reusable across pages that need a user picker.
export async function searchUsers(
  db: Kysely<DB>,
  {
    query,
    limit = 10,
  }: {
    query: string;
    limit?: number;
  }
): Promise<UserSearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  return db
    .selectFrom('User')
    .select(['id', 'username', 'image'])
    .where('username', 'like', `${q}%`)
    .where('deletedAt', 'is', null)
    .where('id', '!=', -1)
    .orderBy(sql`length(username)`, 'asc')
    .limit(limit)
    .execute();
}
