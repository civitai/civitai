import { dbWrite } from './db';

// Append-only: every call is one row, so repeating an action on the same entity keeps both events.
// Best-effort — failures are logged, never thrown.
//
// `onConflict(doNothing)` names NO target on purpose, matching the main app and the auth hub: a targetless
// clause is valid whether or not a unique index exists, so this works both before and after the migration
// that drops ModActivity's (activity, entityType, entityId) unique index. Naming the target would fail with
// 42P10 once that index goes; omitting the clause fails with 23505 until it does. Do not add a target.
export async function recordModActivity(input: {
  userId: number;
  entityType: string;
  entityId: number;
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
  entityType: string;
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
