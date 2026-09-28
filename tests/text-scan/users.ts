import { OnboardingComplete } from '../../src/server/common/enums';
import { many, one } from './db';

export const RESERVED_FIRST_ID = 2_050_000_000;
export const RESERVED_LAST_ID = 2_099_999_999;
const SEQUENCE = 'e2e_text_scan_user_id';

export type TestUser = { id: number; username: string };

/** Once per run, from global setup: workers only call nextval. */
export async function ensureUserIdSequence() {
  await many(
    `CREATE SEQUENCE IF NOT EXISTS ${SEQUENCE} START ${RESERVED_FIRST_ID} MINVALUE ${RESERVED_FIRST_ID} MAXVALUE ${RESERVED_LAST_ID}`
  );
  // A sequence recreated beside rows from an earlier run would hand out their ids again.
  await many(
    `SELECT setval('${SEQUENCE}', GREATEST(
       (SELECT last_value FROM ${SEQUENCE}),
       (SELECT COALESCE(max(id), $1) FROM "User" WHERE id BETWEEN $1 AND $2)
     ))`,
    [RESERVED_FIRST_ID, RESERVED_LAST_ID]
  );
}

/**
 * `createdAt` is at least 3 minutes old so the new-user sweep, which reads only rows older than
 * its settle window, picks the user up on the next run.
 */
export async function createUser(
  opts: { moderator?: boolean; ageDays?: number; username?: string } = {}
): Promise<TestUser> {
  const { id } = (await one<{ id: number }>(`SELECT nextval('${SEQUENCE}')::int AS id`))!;
  const username = opts.username ?? `e2e${id}`;
  await many(
    `INSERT INTO "User" (id, username, email, "emailVerified", onboarding, "isModerator", "createdAt", "showNsfw", "blurNsfw", "browsingLevel")
     VALUES ($1, $2, $3, now() AT TIME ZONE 'UTC', $4, $5,
             (now() AT TIME ZONE 'UTC') - GREATEST(interval '3 minutes', $6::int * interval '1 day'),
             true, false, 31)`,
    [
      id,
      username,
      `${username}@e2e.invalid`,
      OnboardingComplete,
      !!opts.moderator,
      opts.ageDays ?? 0,
    ]
  );
  await many(`INSERT INTO "UserReferral" ("userId") VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
  return { id, username };
}

export async function getUserState(id: number) {
  return one<{ muted: boolean; mutedAt: Date | null; username: string }>(
    `SELECT muted, "mutedAt", username FROM "User" WHERE id = $1`,
    [id]
  );
}
