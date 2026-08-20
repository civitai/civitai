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
