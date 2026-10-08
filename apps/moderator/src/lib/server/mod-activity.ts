import { dbRead, dbWrite } from './db';
import { usersByIds } from './users.service';

// Append-only: every call is one row, so repeating an action on the same entity keeps both events.
// Best-effort — failures are logged, never thrown.
//
// `onConflict(doNothing)` names NO target on purpose, matching the main app and the auth hub: a targetless
// clause is valid whether or not a unique index exists, so this works both before and after the migration
// that drops ModActivity's (activity, entityType, entityId) unique index. Naming the target would fail with
// 42P10 once that index goes; omitting the clause fails with 23505 until it does. Do not add a target.
export async function recordModActivity(input: {
  userId: number;
  entityType: string | null;
  entityId: number | null;
  activity: string;
}): Promise<void> {
  try {
    await dbWrite
      .insertInto('ModActivity')
      .values({
        userId: input.userId,
        entityType: input.entityType,
        entityId: input.entityId,
        activity: input.activity,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  } catch (e) {
    console.error('[mod-activity] failed to record', { ...input, error: e });
  }
}

/**
 * The same row, once per entity, in one statement — for an action that writes many rows at once.
 *
 * 🔴 IT LIVES HERE RATHER THAN AS A LOOP AT THE CALL SITE SO THE `onConflict` ABOVE STAYS IN ONE
 * PLACE. That targetless clause is the whole subtlety of this module (read its comment before
 * touching either function), and a caller that open-codes its own insert to batch is a second copy
 * of it that will not be updated when the unique index is dropped.
 *
 * Best-effort and never throws, exactly like the single-row form: the audit row is a record OF a
 * write that already succeeded, so failing the operator's action because the log failed would turn
 * a completed bulk triage into an error message.
 *
 * An empty list is a no-op rather than an empty `INSERT`, which Kysely compiles to invalid SQL.
 */
export async function recordModActivityBatch(input: {
  userId: number;
  entityType: string | null;
  entityIds: readonly number[];
  activity: string;
}): Promise<void> {
  if (!input.entityIds.length) return;
  try {
    await dbWrite
      .insertInto('ModActivity')
      .values(
        input.entityIds.map((entityId) => ({
          userId: input.userId,
          entityType: input.entityType,
          entityId,
          activity: input.activity,
        }))
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  } catch (e) {
    console.error('[mod-activity] failed to record batch', { ...input, error: e });
  }
}

export type ModActivityRow = {
  id: number;
  activity: string;
  entityType: string | null;
  entityId: number | null;
  createdAt: Date;
  moderatorId: number | null;
  moderatorUsername: string | null;
};

/**
 * Moderator actions against entities of one type, newest first.
 *
 * 🔴 SCOPED BY `entityType` AS WELL AS ID, AND THAT IS NOT AN OPTIMISATION. Entity ids are per-type, so
 * an id-only read returns the report, image and user rows that happen to share the number and presents
 * them as this entity's history — the defect the Retool original shipped. The index is
 * (entityType, entityId, createdAt), so the scoping is also what makes this an index scan.
 */
export async function getModActivityFor(
  entityType: string,
  entityIds: number[],
  limit = 50
): Promise<{ rows: ModActivityRow[]; truncated: boolean }> {
  if (!entityIds.length) return { rows: [], truncated: false };

  const rows = await dbRead
    .selectFrom('ModActivity')
    .select(['id', 'activity', 'entityType', 'entityId', 'createdAt', 'userId'])
    .where('entityType', '=', entityType)
    .where('entityId', 'in', entityIds)
    .orderBy('createdAt', 'desc')
    .limit(limit + 1)
    .execute();

  return { rows: await withModerators(rows.slice(0, limit)), truncated: rows.length > limit };
}

/** Swaps a raw row's `userId` for who acted, with one user read for the whole batch. */
export async function withModerators<R extends { userId: number | null }>(rows: R[]) {
  const byId = await usersByIds(rows.map((r) => r.userId ?? 0));
  return rows.map(({ userId, ...row }) => ({
    ...row,
    moderatorId: userId,
    moderatorUsername: userId ? byId.get(userId)?.username ?? null : null,
  }));
}
