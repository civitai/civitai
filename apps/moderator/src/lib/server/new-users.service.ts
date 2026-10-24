import { dbRead } from './db';
import { containsLike } from './query';

export type NewUser = {
  id: number;
  username: string | null;
  email: string | null;
  createdAt: Date;
  emailVerified: Date | null;
  bannedAt: Date | null;
  deletedAt: Date | null;
  muted: boolean;
  bio: string | null;
  message: string | null;
};

export const NEW_USER_WINDOWS = [1, 7, 30, 90] as const;
export type NewUserWindow = (typeof NEW_USER_WINDOWS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ids and `createdAt` are not strictly monotone — 57 inversions across the last 1M accounts, one
 * backfilled row 3.5 years out of order — so the floor is deliberately loose and the `createdAt`
 * predicate still does the exact filtering. Over-including 10k ids costs nothing against 13M rows.
 */
const ID_FLOOR_MARGIN = 10_000;

/**
 * The id of the oldest account inside the window, less that margin. This is what bounds the scan, and
 * without it the page is unusable: `createdAt >= cutoff` cannot stop a backward walk of the primary
 * key, because the walk has no way to learn the predicate has gone permanently false. Measured on
 * prod, a filter matching nothing walked to id 1 — **7.1 s and 12.6M buffers warm, 19.9 s cold**. With
 * the floor: **118 ms, 60,585 buffers.**
 *
 * It reads `User_createdAt_idx`, which is partial on `deletedAt IS NULL` — the main query cannot use
 * that index, because it shows deleted accounts. So a deleted account more than `ID_FLOOR_MARGIN` ids
 * below the oldest live one in the window would be missed; there are none today, and the margin covers
 * the gap, but that is a second thing it is quietly doing.
 */
async function windowIdFloor(cutoff: Date): Promise<number> {
  const row = await dbRead
    .selectFrom('User')
    .select('id')
    .where('createdAt', '>=', cutoff)
    .where('deletedAt', 'is', null)
    // 🔴 `orderBy createdAt limit 1`, NOT `min(id)`. The index does not carry `id`, so an aggregate
    // over it cannot be answered from the index: Postgres rewrites `min(id)` to `ORDER BY id LIMIT 1`
    // and walks the primary key from id 1 — measured at 13.4 s and ~96 GB of buffers, which is the
    // exact cost this helper exists to avoid. Ordering by the indexed column instead is 0.4 ms and 4
    // buffers. It returns the id at the window edge rather than the strict minimum, which is what the
    // margin below already absorbs.
    .orderBy('createdAt', 'asc')
    .limit(1)
    .executeTakeFirst();
  return Math.max(0, (row?.id ?? 0) - ID_FLOOR_MARGIN);
}

/**
 * Newest accounts first, keyset-paged.
 *
 * Ordered by `id`, not `createdAt`: ids ascend with registration, and the only `createdAt` index is
 * partial on `deletedAt IS NULL`, which this query cannot satisfy. `days` is required rather than
 * offered as "all time" because it is what `windowIdFloor` turns into a scan bound.
 */
export async function getNewestUsers(input: {
  days: NewUserWindow;
  /** Keyset cursor: the last id of the previous page. */
  cursor?: number;
  limit: number;
  username?: string;
  email?: string;
}): Promise<NewUser[]> {
  const cutoff = new Date(Date.now() - input.days * DAY_MS);
  const floor = await windowIdFloor(cutoff);

  let query = dbRead
    .selectFrom('User')
    .leftJoin('UserProfile', 'UserProfile.userId', 'User.id')
    .select([
      'User.id',
      'User.username',
      'User.email',
      'User.createdAt',
      'User.emailVerified',
      'User.bannedAt',
      'User.deletedAt',
      'User.muted',
      'UserProfile.bio',
      'UserProfile.message',
    ])
    .where('User.createdAt', '>=', cutoff)
    .where('User.id', '>=', floor)
    .orderBy('User.id', 'desc')
    .limit(input.limit);

  if (input.cursor) query = query.where('User.id', '<', input.cursor);
  // Both columns are citext, so `like` is already case-insensitive.
  if (input.username) query = query.where('User.username', 'like', containsLike(input.username));
  if (input.email) query = query.where('User.email', 'like', containsLike(input.email));

  return query.execute() as Promise<NewUser[]>;
}
