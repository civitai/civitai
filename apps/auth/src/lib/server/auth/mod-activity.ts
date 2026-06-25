import { sql } from 'kysely';
import { db } from '../db/db';

// Moderator-impersonation audit, written by the HUB (it owns the impersonation logic now). Mirrors the main
// app's trackModActivity upsert: one row per (entityType, activity, entityId), refreshed each time — so it
// records the LATEST moderator who impersonated a given user, with a timestamp. Shared `ModActivity` table.
export async function trackImpersonation(
  moderatorId: number,
  targetUserId: number,
  activity: 'on' | 'off'
): Promise<void> {
  await sql`
    INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId")
    VALUES (${moderatorId}, 'impersonate', ${activity}, ${targetUserId})
    ON CONFLICT ("entityType", activity, "entityId")
    DO UPDATE SET "createdAt" = NOW(), "userId" = ${moderatorId}
  `.execute(db);
}
