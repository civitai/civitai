import { sql } from '@civitai/db/kysely';
import { dbWrite } from './db';

// Record a moderator action for the audit trail (Postgres `ModActivity`). Upserts on
// (entityType, activity, entityId): repeating the same action refreshes `createdAt` + the acting
// moderator rather than inserting a duplicate. Best-effort — failures are logged, never thrown, so an
// audit-write hiccup can't break the moderation action that triggered it.
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
      .onConflict((oc) =>
        oc.columns(['entityType', 'activity', 'entityId']).doUpdateSet({
          createdAt: sql`now()`,
          userId: input.userId,
        })
      )
      .execute();
  } catch (e) {
    console.error('[mod-activity] failed to record', { ...input, error: e });
  }
}
