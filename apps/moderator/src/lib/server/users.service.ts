import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';

// Account -1 is `civitai`, the system bot: it auto-posts chat join lines and owns 14% of ChatMessage.
// It is also flagged `isModerator`, so treating it as a person has already shipped one bug — the User
// Lookup moderator-contact banner fired for 133,081 accounts. Every "is this a real user" test goes
// through here rather than open-coding -1 again.
export const SYSTEM_USER_ID = -1;

/** `Chat.id`, `Image.id` and friends are Postgres `integer`. A larger value ERRORS the comparison
 *  rather than missing, so a pasted snowflake or a double-pasted id 500s the page instead of finding
 *  nothing. Every id that reaches a query is bounded by this. */
export const MAX_INT4 = 2_147_483_647;
export const isInt4Id = (value: number) =>
  Number.isInteger(value) && value > 0 && value <= MAX_INT4;

export type AccountStatus = 'active' | 'banned' | 'deleted' | 'gone';

/** `gone`: no `User` row, so a hard-deleted account or an id that never existed. */
export const accountStatus = (
  user: Pick<UserSummary, 'bannedAt' | 'deletedAt'> | null | undefined
): AccountStatus =>
  !user ? 'gone' : user.bannedAt ? 'banned' : user.deletedAt ? 'deleted' : 'active';

const INSTANT_VERIFY_SECONDS = 120;

/** Email verified within `INSTANT_VERIFY_SECONDS` of signup. Null when either timestamp is missing,
 *  which is not the same as false. */
export const isInstantVerify = (
  createdAt: Date | string | null,
  verifiedAt: Date | string | null
): boolean | null =>
  createdAt && verifiedAt
    ? new Date(verifiedAt).getTime() - new Date(createdAt).getTime() < INSTANT_VERIFY_SECONDS * 1000
    : null;

export type UserSearchResult = { id: number; username: string | null; image: string | null };

export type UserSummary = {
  username: string | null;
  bannedAt: Date | null;
  /** The BOOLEAN, not `mutedAt`. A scheduled-but-inactive timed mute sets the timestamp without the
   *  flag, so testing the timestamp badges accounts as muted that every other surface shows as not. */
  muted: boolean | null;
  deletedAt: Date | null;
  isModerator: boolean | null;
};

// Rows from ClickHouse and from aggregate queries carry user ids and no names; four places were each
// hand-rolling this hydration and had already drifted on the guard (one deduped, one filtered `> 0`,
// one did neither). Empty in / empty out, so callers do not need their own length check.
export async function usersByIds(ids: number[]): Promise<Map<number, UserSummary>> {
  const unique = [...new Set(ids)].filter(isInt4Id);
  if (!unique.length) return new Map();

  const rows = await dbRead
    .selectFrom('User')
    .select(['id', 'username', 'bannedAt', 'muted', 'deletedAt', 'isModerator'])
    .where('id', 'in', unique)
    .execute();
  return new Map(
    rows.map((r) => [
      r.id,
      {
        username: r.username,
        bannedAt: r.bannedAt,
        muted: r.muted,
        deletedAt: r.deletedAt,
        isModerator: r.isModerator,
      },
    ])
  );
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
    .where('id', '!=', SYSTEM_USER_ID)
    .orderBy(sql`length(username)`, 'asc')
    .limit(limit)
    .execute();
}

/** Does a user with exactly this username exist? Disambiguates an all-digit search term, which is both
 *  a plausible chat id and a real username shape — 88 users whose username is a number inside the live
 *  chat-id range have chat messages. */
export async function usernameExists(username: string): Promise<boolean> {
  const row = await dbRead
    .selectFrom('User')
    .select('id')
    .where('username', '=', username)
    .executeTakeFirst();
  return !!row;
}

/** citext: matches case-insensitively via the unique index. */
export async function userIdByUsername(username: string): Promise<number | null> {
  const row = await dbRead
    .selectFrom('User')
    .select('id')
    .where('username', '=', username)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  return row?.id ?? null;
}
