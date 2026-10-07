import type { Prisma } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { restoreScamCase, type ScamCleanupRecord } from '~/server/services/scam-cleanup.service';

const MODERATOR_UNMUTE_ACTIVITIES = ['unmute', 'revokeTimedMute'];
const SYSTEM_ACTOR_ID = constants.system.user.id;
const SCAM_CASE_CLOSED_VOID_REASON = 'The account was unmuted, which closed its scam review.';

type LedgerClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw' | 'userRestriction'>;

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
  strikeId?: number | null;
};

export async function scamVerdictActioned(
  userId: number,
  dedupeKey: string,
  client: LedgerClient = dbWrite
) {
  const rows = await client.$queryRaw<unknown[]>`
    SELECT 1 FROM "UserRestriction"
    WHERE "userId" = ${userId} AND type = 'scam' AND triggers @> ${JSON.stringify([
    { dedupeKey },
  ])}::jsonb
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function lastModeratorUnmuteAt(
  userId: number,
  client: LedgerClient = dbWrite
): Promise<Date | null> {
  const [row] = await client.$queryRaw<{ at: Date | null }[]>`
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
  before: Date,
  client: LedgerClient = dbWrite
) {
  const rows = await client.$queryRaw<unknown[]>`
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
 * Closes what an unmute lifts: Pending scam cases, and the cleanup records kept for an account a
 * moderator had muted, voiding the strikes they issued. Returns their ids; hand them to
 * `restoreScamCases` once the transaction commits. A closed row is no longer selected, so its
 * content is restored once.
 */
export async function closeScamCasesOpenedBefore(
  userId: number,
  at: Date,
  client: LedgerClient = dbWrite
) {
  const closed = await client.$queryRaw<{ id: number }[]>`
    UPDATE "UserRestriction"
    SET "resolvedMessage" = CASE WHEN status = 'Pending'
          THEN 'Closed automatically: the account was unmuted outside the review queue.'
          ELSE 'Content restored: the account was unmuted.' END,
        status = 'Overturned', "resolvedAt" = ${at}, "resolvedBy" = ${SYSTEM_ACTOR_ID},
        "updatedAt" = now()
    WHERE "userId" = ${userId} AND type = 'scam' AND "createdAt" < ${at}
      AND (status = 'Pending' OR (status = 'Upheld' AND "resolvedBy" = ${SYSTEM_ACTOR_ID}))
    RETURNING id
  `;
  const ids = closed.map(({ id }) => id);
  await voidScamCaseStrikes(ids, { voidedBy: null, reason: SCAM_CASE_CLOSED_VOID_REASON }, client);
  return ids;
}

/**
 * Database-only, so it can run inside the transaction that closes the case. Escalation is not re-run:
 * the caller settles the mute itself in that same transaction.
 */
export async function voidScamCaseStrikes(
  userRestrictionIds: number[],
  { voidedBy, reason }: { voidedBy: number | null; reason: string },
  client: LedgerClient = dbWrite
) {
  if (!userRestrictionIds.length) return [];
  const rows = await client.$queryRaw<{ id: number }[]>`
    UPDATE "UserStrike" s
    SET status = 'Voided', "voidedAt" = now(), "voidedBy" = ${voidedBy}::int, "voidReason" = ${reason}
    FROM "UserRestriction" ur,
      jsonb_array_elements(CASE WHEN jsonb_typeof(ur.triggers) = 'array' THEN ur.triggers ELSE '[]'::jsonb END) t
    WHERE ur.id = ANY(${userRestrictionIds}::int[]) AND ur.type = 'scam'
      AND s.id = (t->>'strikeId')::int AND s."userId" = ur."userId" AND s.status = 'Active'
    RETURNING s.id
  `;
  return rows.map(({ id }) => id);
}

export async function restoreScamCases(userId: number, userRestrictionIds: number[]) {
  for (const id of userRestrictionIds) {
    try {
      await restoreScamCase(id);
    } catch (error) {
      await logToAxiom({
        name: 'scam-restore-failed',
        type: 'error',
        message: (error as Error).message,
        details: { userRestrictionId: id, userId },
      }).catch(() => undefined);
    }
  }
}

export async function appendScamTrigger(
  userRestrictionId: number,
  entry: ScamTriggerEntry,
  client: LedgerClient = dbWrite
) {
  const rows = await client.$queryRaw<{ index: number }[]>`
    UPDATE "UserRestriction"
    SET triggers = triggers || ${JSON.stringify([entry])}::jsonb, "updatedAt" = now()
    WHERE id = ${userRestrictionId} AND NOT triggers @> ${JSON.stringify([
    { dedupeKey: entry.dedupeKey },
  ])}::jsonb
    RETURNING (jsonb_array_length(triggers) - 1)::int AS index
  `;
  return rows[0]?.index ?? null;
}

type TriggerSlot = { userRestrictionId: number; index: number; dedupeKey: string };

async function setTriggerField(
  { userRestrictionId, index, dedupeKey }: TriggerSlot,
  field: 'cleanup' | 'strikeId',
  value: unknown
) {
  await dbWrite.$executeRaw`
    UPDATE "UserRestriction"
    SET triggers = jsonb_set(triggers, ARRAY[${String(index)}, ${field}], ${JSON.stringify(
    value
  )}::jsonb),
        "updatedAt" = now()
    WHERE id = ${userRestrictionId} AND triggers -> ${index}::int ->> 'dedupeKey' = ${dedupeKey}
  `;
}

export async function recordScamCleanup(
  userRestrictionId: number,
  index: number,
  dedupeKey: string,
  record: ScamCleanupRecord
) {
  await setTriggerField({ userRestrictionId, index, dedupeKey }, 'cleanup', record);
}

export async function recordScamStrike(
  userRestrictionId: number,
  index: number,
  dedupeKey: string,
  strikeId: number
) {
  await setTriggerField({ userRestrictionId, index, dedupeKey }, 'strikeId', strikeId);
}
