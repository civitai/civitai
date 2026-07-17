import { sql, type Kysely, type Selectable, type Updateable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { jsonBuildObject, toJson } from './infra/helpers';

// `UserRestriction.status` enum, derived from the schema so this module needs no separate enum import.
type UserRestrictionStatusValue = Selectable<DB['UserRestriction']>['status'];

// A restriction's `triggers` column is jsonb (`BlockedPromptEntry[]`); the shape lives with the app/orchestrator
// audit code, so the DB layer treats each entry as opaque and only serializes it via `toJson()`.
type RestrictionTrigger = unknown;

export type GetUserRestrictionsParams = {
  page?: number;
  limit?: number;
  status?: UserRestrictionStatusValue;
  username?: string;
  userId?: number;
};

// A page of generation restrictions for moderator review, newest first, each with its (non-deleted) user's
// id/username/image nested as a json object (Prisma-parity shape). Returns the page items plus the total for
// pagination. The `username` filter is a case-insensitive substring match (Prisma `contains`, insensitive).
export async function getUserRestrictions(
  db: Kysely<DB>,
  { page = 1, limit = 20, status, username, userId }: GetUserRestrictionsParams
) {
  const offset = (page - 1) * limit;

  let base = db
    .selectFrom('UserRestriction')
    .innerJoin('User', 'User.id', 'UserRestriction.userId')
    .where('UserRestriction.type', '=', 'generation')
    .where('User.deletedAt', 'is', null);

  if (status) base = base.where('UserRestriction.status', '=', status);
  if (userId) base = base.where('UserRestriction.userId', '=', userId);
  if (username) base = base.where('User.username', 'ilike', `%${username}%`);

  const totalCount = Number(
    (await base.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirst())?.count ?? 0
  );

  const items = await base
    .select((eb) => [
      'UserRestriction.id',
      'UserRestriction.userId',
      'UserRestriction.status',
      'UserRestriction.triggers',
      'UserRestriction.createdAt',
      'UserRestriction.resolvedAt',
      'UserRestriction.resolvedBy',
      'UserRestriction.resolvedMessage',
      'UserRestriction.userMessage',
      'UserRestriction.userMessageAt',
      jsonBuildObject({
        id: eb.ref('User.id'),
        username: eb.ref('User.username'),
        image: eb.ref('User.image'),
      }).as('user'),
    ])
    .orderBy('UserRestriction.createdAt', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();

  return { items, totalCount };
}

// One restriction by id, with its user's email/username nested (used by the resolve flow to guard the
// transition and to address the follow-on notification/email, which stay with the caller).
export function getUserRestrictionById(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('UserRestriction')
    .leftJoin('User', 'User.id', 'UserRestriction.userId')
    .where('UserRestriction.id', '=', id)
    .select((eb) => [
      'UserRestriction.id',
      'UserRestriction.userId',
      'UserRestriction.status',
      jsonBuildObject({
        email: eb.ref('User.email'),
        username: eb.ref('User.username'),
      }).as('user'),
    ])
    .executeTakeFirst();
}

// Generic single-restriction update by id. The caller passes the id plus whichever columns to set; `updatedAt`
// is stamped automatically (Prisma `@updatedAt` column, no DB trigger). Prefer this over a narrow single-column
// setter; keep a named function only for a multi-column semantic transition (`setUserRestrictionStatus`) or a
// jsonb write whose value needs `toJson()` (`setUserRestrictionTriggers`). Returns the updated row.
export function updateUserRestriction(
  db: Kysely<DB>,
  input: Updateable<DB['UserRestriction']> & { id: number }
) {
  const { id, ...data } = input;
  return db
    .updateTable('UserRestriction')
    .set({ ...data })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

// Moderator resolution of a restriction (uphold/overturn): stamp status + who/when/what. `updatedAt` is
// auto-stamped by the @updatedAt plugin (matching Prisma's client-side `@updatedAt`).
export function setUserRestrictionStatus(
  db: Kysely<DB>,
  input: {
    id: number;
    status: UserRestrictionStatusValue;
    resolvedBy: number;
    resolvedMessage?: string;
  }
) {
  return db
    .updateTable('UserRestriction')
    .set({
      status: input.status,
      resolvedAt: new Date(),
      resolvedBy: input.resolvedBy,
      resolvedMessage: input.resolvedMessage ?? null,
    })
    .where('id', '=', input.id)
    .execute();
}

// Replace a restriction's trigger set (backfill / re-audit). jsonb column → `toJson()`; `updatedAt` stamped
// explicitly. NOTE: the caller's ClickHouse read that assembles `triggers` is NOT ported (skipped, per plan) —
// this is the Postgres write only.
export function setUserRestrictionTriggers(
  db: Kysely<DB>,
  input: { id: number; triggers: RestrictionTrigger[] }
) {
  return db
    .updateTable('UserRestriction')
    .set({ triggers: toJson(input.triggers) })
    .where('id', '=', input.id)
    .execute();
}

// Restrictions eligible for trigger backfill, newest first. Optional `id` narrows to a single record. The
// caller then reads ClickHouse (NOT ported) to build the trigger set and writes it via
// `setUserRestrictionTriggers`.
export function getUserRestrictionsForBackfill(
  db: Kysely<DB>,
  input: { id?: number; limit?: number }
) {
  let query = db
    .selectFrom('UserRestriction')
    .where('type', '=', 'generation')
    .select(['id', 'userId', 'triggers', 'createdAt']);

  if (input.id) query = query.where('id', '=', input.id);

  return query
    .orderBy('createdAt', 'desc')
    .limit(input.limit ?? 10)
    .execute();
}

// Auto-mute write core: create a Pending generation restriction capturing the blocked-prompt triggers. `type`
// is set explicitly (Prisma-parity) and `updatedAt` stamped since it has no DB default. The Redis counter read
// and orchestrator/notification side effects around this write stay with the caller (dropped here).
export function createUserRestriction(
  db: Kysely<DB>,
  input: { userId: number; triggers: RestrictionTrigger[] }
) {
  return db
    .insertInto('UserRestriction')
    .values({
      userId: input.userId,
      type: 'generation',
      triggers: toJson(input.triggers),
      updatedAt: new Date(),
    })
    .returning(['id', 'userId', 'status'])
    .executeTakeFirst();
}

// (User mute writes live in user.db.ts's generic `updateUser`: `updateUser(db, { id, muted })` for the flag,
// `updateUser(db, { id, mutedAt: new Date() })` to confirm — single-column User updates, not restriction ops.)

// Upsert a moderator-curated prompt-allowlist entry (unique on trigger+category). On insert, records the full
// entry incl. optional reason and the linked restriction; on conflict, refreshes only who added it and the
// reason (Prisma-parity). The cache-bust that follows in the router is a side effect (dropped here).
export function upsertPromptAllowlistEntry(
  db: Kysely<DB>,
  input: {
    trigger: string;
    category: string;
    addedBy: number;
    reason?: string;
    userRestrictionId?: number;
  }
) {
  return db
    .insertInto('PromptAllowlist')
    .values({
      trigger: input.trigger,
      category: input.category,
      addedBy: input.addedBy,
      reason: input.reason ?? null,
      userRestrictionId: input.userRestrictionId ?? null,
    })
    .onConflict((oc) =>
      oc.columns(['trigger', 'category']).doUpdateSet({
        addedBy: input.addedBy,
        reason: input.reason ?? null,
      })
    )
    .execute();
}

// The full prompt allowlist (trigger + category pairs). Ported from the cached allowlist's fallback loader;
// the Redis fetch-through cache layer around it is dropped — the caller caches if it wants to.
export function getPromptAllowlist(db: Kysely<DB>) {
  return db.selectFrom('PromptAllowlist').select(['trigger', 'category']).execute();
}
