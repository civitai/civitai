import { sql } from 'kysely';
import {
  moderatorDbStatus,
  storeUnavailableMessage,
  type ModeratorDbStatus,
} from '$lib/moderator-db-status';
import { sameOwners } from '$lib/queue-owners';
import { dbRead } from './db';
import { getModeratorDb } from './moderator-db';
import type { Generated, Timestamp } from './moderator-db/types';
import { SYSTEM_USER_ID } from './users.service';

/** Hand-declared: the tables are hand-applied (`apps/moderator/queue-owners/schema.sql`), not pulled. */
export type QueueOwnerTables = {
  queue_owner: {
    path: string;
    user_id: number;
    assigned_by: number;
    assigned_at: Generated<Timestamp>;
  };
  queue_owner_change: {
    id: Generated<string>;
    at: Generated<Timestamp>;
    actor_id: number;
    path: string;
    owners_before: number[];
    owners_after: number[];
  };
};

const db = () => getModeratorDb().withTables<QueueOwnerTables>();

export const queueOwnersUnavailableMessage = (status: Exclude<ModeratorDbStatus, 'ok'>) =>
  storeUnavailableMessage(status, {
    tables: 'The queue owner tables',
    database: 'the moderator database',
    schemaFile: 'apps/moderator/queue-owners/schema.sql',
  });

/** A queue's owners moved after the caller read them. Nothing was written. */
export class QueueOwnerConflictError extends Error {
  readonly status = 409;
  constructor(readonly path: string) {
    super(`The owners of ${path} changed since the page loaded.`);
  }
}

/** The change could not be made or recorded, so neither happened. */
export class QueueOwnersUnavailableError extends Error {
  readonly status = 503;
  constructor(readonly dbStatus: Exclude<ModeratorDbStatus, 'ok'>) {
    super(`${queueOwnersUnavailableMessage(dbStatus)} No owner was changed.`);
  }
}

/** Every stored owner, by queue path. A path with no rows is absent: nobody owns it. */
export async function listQueueOwners(): Promise<Record<string, number[]>> {
  const rows = await db()
    .selectFrom('queue_owner')
    .select(['path', 'user_id'])
    .orderBy('path')
    .orderBy('assigned_at')
    .orderBy('user_id')
    .execute();
  const out: Record<string, number[]> = {};
  for (const row of rows) (out[row.path] ??= []).push(row.user_id);
  return out;
}

/** The queue paths one moderator owns. */
export async function ownedQueuePaths(userId: number): Promise<string[]> {
  const rows = await db()
    .selectFrom('queue_owner')
    .select('path')
    .where('user_id', '=', userId)
    .execute();
  return rows.map((r) => r.path);
}

/**
 * The one write path for owners. Each changed queue gets a history row in the same transaction as the
 * change, so a change that cannot be recorded does not happen.
 *
 * `expect` is each queue's owners as the caller last read them, and is required for every entry: a save
 * that does not say what it is replacing would silently revert whatever another admin changed since.
 * All saves take one transaction-scoped lock, rather than `FOR UPDATE`, because a row lock cannot cover
 * a queue with no owners yet, and two first saves of the same queue would both pass a compare against
 * "nobody". Queues whose owners would not change are skipped and recorded nowhere.
 */
export async function changeQueueOwners(input: {
  entries: { path: string; owners: number[] }[];
  expect: Record<string, number[]>;
  actorId: number;
}): Promise<{ changed: number }> {
  const paths = input.entries.map((e) => e.path);
  for (const path of paths)
    if (!Object.hasOwn(input.expect, path)) throw new QueueOwnerConflictError(path);
  if (!paths.length) return { changed: 0 };

  try {
    return await db()
      .transaction()
      .execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext('queue_owner'))`.execute(trx);
        const rows = await trx
          .selectFrom('queue_owner')
          .select(['path', 'user_id'])
          .where('path', 'in', paths)
          .execute();
        const stored = (path: string) => rows.filter((r) => r.path === path).map((r) => r.user_id);

        for (const path of paths)
          if (!sameOwners(stored(path), input.expect[path]))
            throw new QueueOwnerConflictError(path);

        const changed = input.entries
          .map((e) => ({ path: e.path, before: stored(e.path), after: [...new Set(e.owners)] }))
          .filter((c) => !sameOwners(c.before, c.after));
        if (!changed.length) return { changed: 0 };

        await trx
          .insertInto('queue_owner_change')
          .values(
            changed.map((c) => ({
              actor_id: input.actorId,
              path: c.path,
              owners_before: c.before,
              owners_after: c.after,
            }))
          )
          .execute();

        for (const c of changed) {
          const removed = c.before.filter((id) => !c.after.includes(id));
          const added = c.after.filter((id) => !c.before.includes(id));
          if (removed.length) {
            const result = await trx
              .deleteFrom('queue_owner')
              .where('path', '=', c.path)
              .where('user_id', 'in', removed)
              .executeTakeFirst();
            // Under the lock nothing else can remove these rows, so a short count is a bug, not a race.
            if (Number(result.numDeletedRows) !== removed.length)
              throw new Error(`Removing owners of ${c.path} touched the wrong number of rows.`);
          }
          if (added.length)
            await trx
              .insertInto('queue_owner')
              .values(
                added.map((userId) => ({
                  path: c.path,
                  user_id: userId,
                  assigned_by: input.actorId,
                }))
              )
              .execute();
        }
        return { changed: changed.length };
      });
  } catch (e) {
    if (e instanceof QueueOwnerConflictError) throw e;
    console.error('[queue-owners] owner change failed, nothing was written', e);
    throw new QueueOwnersUnavailableError(moderatorDbStatus(e));
  }
}

export type QueueOwnerChange = {
  id: string;
  at: Date;
  actorId: number;
  path: string;
  before: number[];
  after: number[];
};

export async function listQueueOwnerChanges(limit: number): Promise<QueueOwnerChange[]> {
  const rows = await db()
    .selectFrom('queue_owner_change')
    .select([
      'id',
      'at',
      'actor_id as actorId',
      'path',
      'owners_before as before',
      'owners_after as after',
    ])
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

export type ModeratorCandidate = { id: number; username: string | null; roles: string[] };

/**
 * Everyone who can be made an owner: live moderator accounts, with their moderator-app roles so the
 * admin page can say which owners cannot open the queue they own. The system account is flagged as a
 * moderator but is nobody to assign work to.
 */
export async function listModeratorCandidates(): Promise<ModeratorCandidate[]> {
  const users = await dbRead
    .selectFrom('User')
    .select(['id', 'username'])
    .where('isModerator', '=', true)
    .where('deletedAt', 'is', null)
    .where('bannedAt', 'is', null)
    .where('id', '!=', SYSTEM_USER_ID)
    .orderBy('username')
    .execute();
  if (!users.length) return [];
  const roles = await dbRead
    .selectFrom('UserRole')
    .select(['userId', 'role'])
    .where(
      'userId',
      'in',
      users.map((u) => u.id)
    )
    .where('role', 'like', 'moderator:%')
    .execute();
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    roles: roles.filter((r) => r.userId === u.id).map((r) => r.role),
  }));
}
