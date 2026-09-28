import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { restoreScamCase, type ScamCleanupRecord } from '~/server/services/scam-cleanup.service';
import { UserRestrictionStatus } from '~/shared/utils/prisma/enums';

const MODERATOR_UNMUTE_ACTIVITIES = ['unmute', 'revokeTimedMute'];
const SYSTEM_ACTOR_ID = -1;
const CLEANUP_ONLY_MESSAGE =
  'Recorded automatically: the account was already muted by a moderator, so only its content was hidden.';

export type ScamTriggerEntry = {
  category: 'scam';
  source: string;
  dedupeKey: string;
  reason: string;
  time: string;
  entityType?: string;
  entityId?: number;
  text?: string;
  textHash?: string;
  contentAt?: string | null;
  cleanup?: ScamCleanupRecord | null;
};

export async function scamVerdictActioned(userId: number, dedupeKey: string) {
  const rows = await dbWrite.$queryRaw<unknown[]>`
    SELECT 1 FROM "UserRestriction"
    WHERE "userId" = ${userId} AND type = 'scam' AND triggers @> ${JSON.stringify([
    { dedupeKey },
  ])}::jsonb
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function lastModeratorUnmuteAt(userId: number): Promise<Date | null> {
  const [row] = await dbWrite.$queryRaw<{ at: Date | null }[]>`
    SELECT GREATEST(
      (SELECT max("createdAt") FROM "ModActivity"
        WHERE "entityType" = 'user' AND "entityId" = ${userId} AND "userId" > 0
          AND activity = ANY(${MODERATOR_UNMUTE_ACTIVITIES}::text[])),
      (SELECT max("resolvedAt") FROM "UserRestriction"
        WHERE "userId" = ${userId} AND type = 'scam' AND status = 'Overturned' AND "resolvedBy" > 0)
    ) AS at
  `;
  return row?.at ?? null;
}

export async function scamTextSeenBefore(
  userId: number,
  probe: { entityType: string; entityId: number; textHash: string },
  before: Date
) {
  const rows = await dbWrite.$queryRaw<unknown[]>`
    SELECT 1
    FROM "UserRestriction" ur,
      jsonb_array_elements(CASE WHEN jsonb_typeof(ur.triggers) = 'array' THEN ur.triggers ELSE '[]'::jsonb END) t
    WHERE ur."userId" = ${userId} AND ur.type = 'scam'
      AND t @> ${JSON.stringify(probe)}::jsonb AND (t->>'time')::timestamptz <= ${before}
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Closes the Pending scam cases an out-of-queue unmute left behind, and restores what their cleanup
 * hid. Otherwise the next verdict would fold into a case the moderator already let go.
 */
export async function closeScamCasesOpenedBefore(userId: number, at: Date) {
  const closed = await dbWrite.$queryRaw<{ id: number }[]>`
    UPDATE "UserRestriction"
    SET status = 'Overturned', "resolvedAt" = ${at}, "resolvedBy" = ${SYSTEM_ACTOR_ID},
        "resolvedMessage" = 'Closed automatically: the account was unmuted outside the review queue.',
        "updatedAt" = now()
    WHERE "userId" = ${userId} AND type = 'scam' AND status = 'Pending' AND "createdAt" < ${at}
    RETURNING id
  `;
  for (const { id } of closed) {
    await restoreScamCase(id).catch((error) =>
      logToAxiom({
        name: 'scam-restore-failed',
        type: 'error',
        message: (error as Error).message,
        details: { userRestrictionId: id, userId },
      })
    );
  }
  return closed.length;
}

export async function appendScamTrigger(userRestrictionId: number, entry: ScamTriggerEntry) {
  const rows = await dbWrite.$queryRaw<{ index: number }[]>`
    UPDATE "UserRestriction"
    SET triggers = triggers || ${JSON.stringify([entry])}::jsonb, "updatedAt" = now()
    WHERE id = ${userRestrictionId} AND NOT triggers @> ${JSON.stringify([
    { dedupeKey: entry.dedupeKey },
  ])}::jsonb
    RETURNING (jsonb_array_length(triggers) - 1)::int AS index
  `;
  return rows[0]?.index ?? null;
}

/**
 * Where a verdict against an account a moderator already muted records its cleanup: one already-
 * resolved `scam` row per account, so the hidden ids stay restorable and the verdict stays deduped,
 * without opening a case nobody needs to rule on. `null` when the verdict is already on it.
 */
export async function fileScamCleanupRecord(userId: number, entry: ScamTriggerEntry) {
  const existing = await dbWrite.userRestriction.findFirst({
    where: {
      userId,
      type: 'scam',
      status: UserRestrictionStatus.Upheld,
      resolvedBy: SYSTEM_ACTOR_ID,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (existing) {
    const index = await appendScamTrigger(existing.id, entry);
    return index === null ? null : { userRestrictionId: existing.id, index, created: false };
  }
  const created = await dbWrite.userRestriction.create({
    data: {
      userId,
      type: 'scam',
      status: UserRestrictionStatus.Upheld,
      triggers: [entry],
      resolvedAt: new Date(),
      resolvedBy: SYSTEM_ACTOR_ID,
      resolvedMessage: CLEANUP_ONLY_MESSAGE,
    },
    select: { id: true },
  });
  return { userRestrictionId: created.id, index: 0, created: true };
}

export async function recordScamCleanup(
  userRestrictionId: number,
  index: number,
  dedupeKey: string,
  record: ScamCleanupRecord
) {
  await dbWrite.$executeRaw`
    UPDATE "UserRestriction"
    SET triggers = jsonb_set(triggers, ARRAY[${String(index)}, 'cleanup'], ${JSON.stringify(
    record
  )}::jsonb),
        "updatedAt" = now()
    WHERE id = ${userRestrictionId} AND triggers -> ${index}::int ->> 'dedupeKey' = ${dedupeKey}
  `;
}
