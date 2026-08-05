import { sql } from 'kysely';
import { db } from '../db/db';

// Moderator-impersonation audit, written by the HUB (it owns the impersonation logic now) into the shared
// `ModActivity` table.
//
// `ON CONFLICT DO NOTHING` carries NO conflict target on purpose: a targetless clause is valid whether or
// not a unique index exists, so this survives the pending migration that drops ModActivity's
// (activity, entityType, entityId) unique index and makes the table append-only. Naming the target would
// fail with 42P10 the moment that index goes; omitting the clause entirely would fail with 23505 until it
// does. Do not add a target back.
export async function trackImpersonation(
  moderatorId: number,
  targetUserId: number,
  activity: 'on' | 'off'
): Promise<void> {
  await sql`
    INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId")
    VALUES (${moderatorId}, 'impersonate', ${activity}, ${targetUserId})
    ON CONFLICT DO NOTHING
  `.execute(db);
}
