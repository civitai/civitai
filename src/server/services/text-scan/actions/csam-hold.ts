import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import { composeUserText } from '~/server/services/text-scan/segment';
import type { TextScanEntityType } from '~/server/services/text-scan/types';
import { isPrismaUniqueViolation } from '~/server/utils/errorHandling';
import { sanitizeForPostgres } from '~/utils/string-helpers';

export const CSAM_HOLD_TEXT_CHARS = 50_000;

function storable(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeForPostgres(value);
  if (Array.isArray(value)) return value.map(storable);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, storable(v)]));
  return value;
}

function contentAtOf(meta: Record<string, unknown> | undefined) {
  const value = meta?.contentAt;
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

type PendingHoldWrite = 'created' | 'updated' | 'unchanged' | 'skipped';

/**
 * Thrown when new csam text cannot replace a pending hold because a moderator is mid-decision on it. The
 * detection is recorded nowhere else, so the callback must fail and let the retry cron's rescan redo it.
 */
export class CsamHoldBusyError extends Error {
  constructor() {
    super('csam hold is mid-decision; the detection must be retried');
    this.name = 'CsamHoldBusyError';
  }
}

/**
 * The advisory lock the write below and a decision's final update both take, so a decision cannot land
 * between the ruled-text check and the upsert. A pair key keeps it off the single-key article lock.
 */
export const lockCsamHold = (
  tx: Pick<typeof dbWrite, '$executeRaw'>,
  entityType: string,
  entityId: number
) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`csam-hold:${entityType}`}), ${entityId}::int)`;

/**
 * One pending hold per entity, kept current. Rescans only happen when the scanned text changed, so a
 * second detection means new text: it replaces the pending hold's text in place instead of queueing
 * another row. Text a moderator already ruled on is not held again; changed text after a ruling is held
 * once more and marked as re-detected.
 */
async function writePendingHold(hold: {
  entityType: string;
  entityId: number;
  textHash: string;
  userId: number | null;
  text: string;
  reason: string;
  workflowId: string | undefined;
  promptId: number | null;
  contentAt: Date | null;
  meta: Record<string, unknown>;
}): Promise<{ holdId: number | null; write: PendingHoldWrite; priorHoldId: number | null }> {
  return dbWrite.$transaction(async (tx) => {
    await lockCsamHold(tx, hold.entityType, hold.entityId);
    // A hold the migration superseded was never ruled on, so it neither blocks nor marks a re-detection.
    const [decided] = await tx.$queryRaw<{ latestId: number | null; sameText: boolean | null }[]>`
      SELECT max("id") AS "latestId", bool_or("textHash" = ${hold.textHash}) AS "sameText"
      FROM "TextScanHold"
      WHERE "entityType" = ${hold.entityType} AND "entityId" = ${hold.entityId} AND "label" = 'csam'
        AND "status" <> 'Pending' AND "meta"->>'decision' IS DISTINCT FROM 'superseded'
    `;
    const priorHoldId = decided?.latestId ?? null;
    if (decided?.sameText) return { holdId: null, write: 'skipped', priorHoldId };

    const meta = JSON.stringify(
      priorHoldId === null ? hold.meta : { ...hold.meta, kind: 'redetected', priorHoldId }
    );
    // The update leaves a hold mid-decision alone: swapping the text under a moderator would apply their
    // ruling to text they never saw. A claim counts as live for 30 minutes, far past the 5 a decision
    // itself waits before treating one as crashed, so a slow decision still finishes.
    const rows = await tx.$queryRaw<{ id: number; inserted: boolean }[]>`
      INSERT INTO "TextScanHold"
        ("entityType", "entityId", "label", "textHash", "userId", "text", "reason", "workflowId",
         "promptId", "contentAt", "meta", "updatedAt")
      VALUES (${hold.entityType}, ${hold.entityId}, 'csam', ${hold.textHash}, ${hold.userId},
        ${hold.text}, ${hold.reason}, ${hold.workflowId ?? null}, ${hold.promptId},
        (${hold.contentAt?.toISOString() ?? null}::timestamptz AT TIME ZONE 'UTC'),
        ${meta}::jsonb, now())
      ON CONFLICT ("entityType", "entityId", "label")
        WHERE "status" = 'Pending' AND "entityType" <> 'ChatMessage'
      DO UPDATE SET
        "textHash" = EXCLUDED."textHash",
        "text" = EXCLUDED."text",
        "reason" = EXCLUDED."reason",
        "workflowId" = EXCLUDED."workflowId",
        "promptId" = EXCLUDED."promptId",
        "contentAt" = EXCLUDED."contentAt",
        "meta" = (CASE WHEN jsonb_typeof("TextScanHold"."meta") = 'object'
          THEN "TextScanHold"."meta" - 'decisionClaim' ELSE '{}'::jsonb END) || EXCLUDED."meta",
        "updatedAt" = now()
      WHERE "TextScanHold"."textHash" IS DISTINCT FROM EXCLUDED."textHash"
        AND ("TextScanHold"."meta"->'decisionClaim' IS NULL
          OR ("TextScanHold"."meta"->'decisionClaim'->>'at')::timestamptz < now() - interval '30 minutes')
      RETURNING "id", (xmax = 0) AS "inserted"
    `;
    const row = rows[0];
    if (row)
      return {
        holdId: row.id,
        write: row.inserted ? 'created' : 'updated',
        priorHoldId,
      } as const;

    // Nothing written: either the pending hold already has this text, or a live claim blocked the swap.
    const [pending] = await tx.$queryRaw<{ textHash: string }[]>`
      SELECT "textHash" FROM "TextScanHold"
      WHERE "entityType" = ${hold.entityType} AND "entityId" = ${hold.entityId}
        AND "label" = 'csam' AND "status" = 'Pending'
    `;
    if (pending && pending.textHash !== hold.textHash) throw new CsamHoldBusyError();
    return { holdId: null, write: 'unchanged', priorHoldId } as const;
  });
}

const messageIdsOf = (meta: unknown) => {
  const ids = (meta as { messageIds?: unknown } | null)?.messageIds;
  return Array.isArray(ids) ? ids : [];
};

/** A new message rescans the sender's recent window; returns the newest pending (else newest decided) hold that already saw every message in this window, so one conversation queues one hold. */
async function coveringChatHold(userId: number | null, meta: Record<string, unknown> | undefined) {
  const chatId = meta?.chatId;
  if (typeof chatId !== 'number') return null;
  const window = messageIdsOf(meta);
  if (!window.length) return null;
  const where = {
    entityType: 'ChatMessage',
    label: 'csam',
    userId,
    meta: { path: ['chatId'], equals: chatId },
  } satisfies Prisma.TextScanHoldWhereInput;
  for (const status of ['Pending', { not: 'Pending' }] as const) {
    const hold = await dbWrite.textScanHold.findFirst({
      where: { ...where, status },
      orderBy: { id: 'desc' },
      select: { id: true, meta: true },
    });
    const seen = new Set(messageIdsOf(hold?.meta));
    if (hold && window.every((id) => seen.has(id))) return hold.id;
  }
  return null;
}

export async function applyCsamHold({
  entityType,
  entityId,
  outcome,
  subject,
  workflowId,
  textHash,
  promptIds,
}: ApplyTextScanArgs & { entityType: TextScanEntityType }) {
  if (!outcome.csam?.detected) return;

  const userId = subject.userId && subject.userId > 0 ? subject.userId : null;
  // Cut before well-forming, so a pair split by the cap is replaced rather than kept half.
  const text = sanitizeForPostgres(composeUserText(subject).slice(0, CSAM_HOLD_TEXT_CHARS));
  const reason = sanitizeForPostgres(outcome.csam.reason);
  const promptId = promptIds?.csam ?? null;
  const contentAt = contentAtOf(subject.meta);
  const meta = (subject.meta ? storable(subject.meta) : undefined) as
    | Prisma.InputJsonObject
    | undefined;

  let holdId: number | null = null;
  let write: PendingHoldWrite | 'covered' | 'duplicate' = 'unchanged';
  let coveredBy: number | null = null;
  let priorHoldId: number | null = null;
  if (entityType === 'ChatMessage') {
    coveredBy = await coveringChatHold(userId, subject.meta);
    write = 'covered';
    if (coveredBy === null) {
      write = 'duplicate';
      try {
        const hold = await dbWrite.textScanHold.create({
          data: {
            entityType,
            entityId,
            label: 'csam',
            textHash,
            userId,
            text,
            reason,
            workflowId,
            promptId,
            contentAt,
            meta,
          },
          select: { id: true },
        });
        holdId = hold.id;
        write = 'created';
      } catch (error) {
        if (!isPrismaUniqueViolation(error)) throw error;
      }
    }
  } else {
    ({ holdId, write, priorHoldId } = await writePendingHold({
      entityType,
      entityId,
      textHash,
      userId,
      text,
      reason,
      workflowId,
      promptId,
      contentAt,
      meta: (meta ?? {}) as Record<string, unknown>,
    }));
  }

  logToAxiom({
    name: 'text-scan',
    type: 'csam-hold',
    message: `csam hold ${write}`,
    entityType,
    entityId,
    workflowId,
    holdId,
    write,
    created: write === 'created',
    ...(coveredBy !== null ? { coveredBy } : {}),
    ...(priorHoldId !== null ? { priorHoldId } : {}),
  }).catch(() => null);
}

/** Hold first: a failed write throws before the entity action, so the retry cron's rescan redoes both. */
export function withCsamHold(
  entityType: TextScanEntityType,
  apply: (args: ApplyTextScanArgs) => Promise<unknown>
) {
  return async (args: ApplyTextScanArgs) => {
    try {
      await applyCsamHold({ entityType, ...args });
    } catch (error) {
      // Code and name only: a Prisma message can echo the arguments, which here are the held text.
      logToAxiom({
        name: 'text-scan',
        type: 'error',
        message: 'csam hold failed',
        entityType,
        entityId: args.entityId,
        workflowId: args.workflowId,
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: (error as { code?: unknown } | null | undefined)?.code,
      }).catch(() => null);
      throw error;
    }
    await apply(args);
  };
}
