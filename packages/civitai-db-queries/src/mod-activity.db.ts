import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// The `ModActivity` free-text columns, derived from the schema so this module needs no separate type import.
type ModActivityType = NonNullable<DB['ModActivity']['entityType']>;
type ModActivityName = DB['ModActivity']['activity'];

export type RecordModActivityInput = {
  userId: number;
  entityType: ModActivityType;
  entityId: number;
  activity: ModActivityName;
};

// Record a moderator action for the audit trail (Postgres `ModActivity`). Upserts on
// (entityType, activity, entityId): repeating the same action refreshes `createdAt` + the acting moderator
// rather than inserting a duplicate. Best-effort — failures are logged, never thrown, so an audit-write
// hiccup can't break the moderation action that triggered it.
export async function recordModActivity(
  db: Kysely<DB>,
  input: RecordModActivityInput
): Promise<void> {
  try {
    await db
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
