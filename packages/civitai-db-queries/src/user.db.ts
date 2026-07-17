import { sql, type Kysely, type Updateable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { toJson } from './infra/helpers';

// The user fields the soft-delete guard needs (mod status + a paddle-customer flag).
export function getUserForSoftDelete(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('User')
    .select(['isModerator', 'paddleCustomerId'])
    .where('id', '=', id)
    .executeTakeFirst();
}

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

// `NsfwLevel.Blocked` is the top bit (32) of the browsing-level bitfield. `updateUserById` strips it before
// writing so a user can never carry the Blocked flag as a browsing preference (the "central enforcement").
const NSFW_LEVEL_BLOCKED = 32;

// Shape of the moderation-relevant slices of `User.meta` (jsonb). The DB layer only serializes these via
// `toJson()`; the merge logic (spread existing meta, set/clear the block) lives with the caller.
export type BanDetails = {
  reasonCode?: string;
  detailsInternal?: string;
  detailsExternal?: string;
};
export type ContestBanDetails = {
  bannedAt?: Date;
  detailsInternal?: string;
};

// Generic User update. Ports `updateUserById`'s DB core: strip the Blocked flag from `browsingLevel` (the
// enforcement) then UPDATE the row, RETURNing it. The email-overwrite guard (a pre-read of the existing
// email), the update counter, cache busts and the Paddle email push are all side effects handled by the
// caller. jsonb columns (e.g. `meta`) are not special-cased here — use `setUserBan`/`setUserContestBan`.
export function updateUser(db: Kysely<DB>, input: Updateable<DB['User']> & { id: number }) {
  const { id, ...data } = input;
  if (typeof data.browsingLevel === 'number' && (data.browsingLevel & NSFW_LEVEL_BLOCKED) !== 0) {
    data.browsingLevel = data.browsingLevel & ~NSFW_LEVEL_BLOCKED;
  }
  return db.updateTable('User').set(data).where('id', '=', id).returningAll().executeTakeFirst();
}

// `toggleBan` write core: set `bannedAt` and the merged `meta` (which carries `banDetails`). The caller reads
// the current user, computes the next `bannedAt` (null to clear, a Date to ban) and the merged meta object,
// then hands them here. jsonb via `toJson()`.
export function setUserBan(
  db: Kysely<DB>,
  input: { id: number; bannedAt: Date | null; meta: unknown }
) {
  return db
    .updateTable('User')
    .set({ bannedAt: input.bannedAt, meta: toJson(input.meta) })
    .where('id', '=', input.id)
    .returningAll()
    .executeTakeFirst();
}

// `toggleContestBan` write core: write only the merged `meta` (which carries `contestBanDetails`). `bannedAt`
// is untouched — a contest ban lives entirely in meta.
export function setUserContestBan(db: Kysely<DB>, input: { id: number; meta: unknown }) {
  return db
    .updateTable('User')
    .set({ meta: toJson(input.meta) })
    .where('id', '=', input.id)
    .returningAll()
    .executeTakeFirst();
}

// Explicit moderator mute/unmute. Sets `muted` and stamps `mutedAt` (a Date on mute, cleared on unmute) —
// `mutedAt` is a moderator-confirmation marker, so it moves in lockstep with the flag here. Session
// invalidation stays with the caller.
export function setUserMuted(db: Kysely<DB>, input: { id: number; muted: boolean }) {
  const now = new Date();
  return db
    .updateTable('User')
    .set({ muted: input.muted, mutedAt: input.muted ? now : null })
    .where('id', '=', input.id)
    .returningAll()
    .executeTakeFirst();
}

// The guard `softDeleteUser` reads before force-banning: skip moderators, and surface the Paddle customer id
// the caller needs to cancel subscriptions. The force-ban itself is `setUserBan` (bannedAt = now); the CSAM
// image-block and search-index removal are dropped per the port plan.

// Users whose mute was confirmed by a moderator since `since` (`muted` set AND `mutedAt` newer than the last
// run). The per-user subscription-cancel + session-refresh loop stays with the job.
export function getConfirmedMutedUsers(db: Kysely<DB>, since: Date) {
  return db
    .selectFrom('User')
    .select('id')
    .where('muted', '=', true)
    .where('mutedAt', '>', since)
    .execute();
}

export type GetUsersParams = {
  limit?: number;
  query?: string;
  email?: string;
  ids?: number[];
  include?: Array<'status' | 'avatar'>;
  excludedUserIds?: number[];
  contestBanned?: boolean;
};

export type GetUsersRow = {
  id: number;
  username: string | null;
  status?: 'active' | 'banned' | 'muted' | 'deleted';
  avatarUrl?: string | null;
  avatarNsfwLevel?: number;
  meta?: unknown;
};

// Faithful port of the moderator user lookup: id/username plus optional derived `status`, avatar, and (for
// the contest-ban view) raw `meta`; filtered by id set / username prefix / email prefix / exclusion set,
// always excluding deleted users and the system user (-1). Built as an assembled `sql` query (the original
// was `$queryRaw` with `Prisma.raw` fragments). The JS post-mapping (`avatarNsfw`) stays with the caller.
//
// Two deviations from the literal original, both required for the SQL to parse/plan against the real schema
// (the original was latently broken on these paths): the `ORDER BY LENGTH(username)` is emitted AFTER the
// WHERE (the original spliced it between two WHERE `AND`s), and the avatar level reads the `"nsfwLevel"` int
// column with a `0` default (the original used unquoted `i.nsfwLevel` — folds to a non-existent
// `nsfwlevel` — and a `'None'` text default against an int column).
export async function getUsers(db: Kysely<DB>, params: GetUsersParams): Promise<GetUsersRow[]> {
  const { limit, query, email, ids, include, excludedUserIds, contestBanned } = params;
  const wantsAvatar = !!include?.includes('avatar');
  const wantsStatus = !!include?.includes('status');

  const selectFrags = [sql`u.id`, sql`u.username`];
  if (wantsStatus)
    selectFrags.push(
      sql`CASE
        WHEN u."deletedAt" IS NOT NULL THEN 'deleted'
        WHEN u."bannedAt" IS NOT NULL THEN 'banned'
        WHEN u.muted IS TRUE THEN 'muted'
        ELSE 'active'
      END AS status`
    );
  if (wantsAvatar)
    selectFrags.push(
      sql`COALESCE(i.url, u.image) AS "avatarUrl"`,
      sql`COALESCE(i."nsfwLevel", 0) AS "avatarNsfwLevel"`
    );
  if (contestBanned) selectFrags.push(sql`u."meta"`);

  const joinFrag = wantsAvatar ? sql`LEFT JOIN "Image" i ON i.id = u."profilePictureId"` : sql``;

  const whereFrags = [
    ids && ids.length > 0 ? sql`u.id IN (${sql.join(ids)})` : sql`TRUE`,
    query ? sql`u.username LIKE ${query + '%'}` : sql`TRUE`,
    email ? sql`u.email ILIKE ${email + '%'}` : sql`TRUE`,
    excludedUserIds && excludedUserIds.length > 0
      ? sql`u.id != ALL(${excludedUserIds}::int[])`
      : sql`TRUE`,
    sql`u."deletedAt" IS NULL`,
    sql`u."id" != -1`,
    contestBanned ? sql`u."meta"->>'contestBanDetails' IS NOT NULL` : sql`TRUE`,
  ];

  const orderFrag = query ? sql`ORDER BY LENGTH(u.username) ASC` : sql``;
  const limitFrag = limit ? sql`LIMIT ${limit}` : sql``;

  const result = await sql<GetUsersRow>`
    SELECT ${sql.join(selectFrags)}
    FROM "User" u
    ${joinFrag}
    WHERE ${sql.join(whereFrags, sql` AND `)}
    ${orderFrag}
    ${limitFrag}
  `.execute(db);

  return result.rows;
}

// Guard read: confirm the (id, username) pair matches a real user before scrubbing.
export function getUserByIdAndUsername(db: Kysely<DB>, input: { id: number; username: string }) {
  return db
    .selectFrom('User')
    .select('id')
    .where('id', '=', input.id)
    .where('username', '=', input.username)
    .executeTakeFirst();
}

// Delete the user's own UserEngagement rows. NOTE: faithful to the original Prisma filter
// `{ OR: [{ userId, targetUserId }] }`, which is a single AND'd predicate (`userId = id AND targetUserId =
// id`) — i.e. only self-engagements, almost certainly a latent bug (intended `userId = id OR targetUserId =
// id`). Ported verbatim; flag to the caller before relying on it.
export function deleteUserEngagementsForUser(db: Kysely<DB>, userId: number) {
  return db
    .deleteFrom('UserEngagement')
    .where('userId', '=', userId)
    .where('targetUserId', '=', userId)
    .execute();
}

// The User-row scrub on deletion: set `deletedAt` and null out identity/PII/avatar fields.
export function scrubDeletedUser(db: Kysely<DB>, id: number) {
  return db
    .updateTable('User')
    .set({
      deletedAt: new Date(),
      email: null,
      username: null,
      paddleCustomerId: null,
      image: null,
      profilePictureId: null,
    })
    .where('id', '=', id)
    .execute();
}

export function deleteUserLinkForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('UserLink').where('userId', '=', userId).execute();
}
export function deleteUserProfileForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('UserProfile').where('userId', '=', userId).execute();
}
