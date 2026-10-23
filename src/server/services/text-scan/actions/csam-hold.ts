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
 * detection is recorded nowhere else, so the callback must fail and let the retry cron's rescan redo it;
 * that relies on the cron outlasting the 30-minute claim window.
 */
export class CsamHoldBusyError extends Error {
  constructor() {
    super('csam hold is mid-decision; the detection must be retried');
    this.name = 'CsamHoldBusyError';
  }
}

/** Advisory lock shared with a decision's final update, so a decision cannot land between the ruled-text check and the write. */
export const lockCsamHold = (
  tx: Pick<typeof dbWrite, '$executeRaw'>,
  entityType: string,
  entityId: number
) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`csam-hold:${entityType}`}), ${entityId}::int)`;

const PREVIOUS_TEXTS_KEPT = 5;

type PendingRow = {
  id: number;
  text: string;
  textHash: string;
  reason: string;
  workflowId: string | null;
  meta: Record<string, unknown> | null;
  claimed: boolean;
};

/**
 * One pending hold per entity, kept current. Rescans only happen when the scanned text changed, so a
 * second detection means new text: it replaces the pending hold's text in place, keeping the replaced
 * text in `meta.previous`, instead of queueing another row. Text a moderator already ruled on is not held
 * again unless a different text is pending, which it replaces; changed text after a ruling is held once
 * more and marked as re-detected.
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
    const decided = await tx.$queryRaw<{ id: number; textHash: string; status: string }[]>`
      SELECT "id", "textHash", "status"::text AS "status" FROM "TextScanHold"
      WHERE "entityType" = ${hold.entityType} AND "entityId" = ${hold.entityId} AND "label" = 'csam'
        AND "status" <> 'Pending' AND "meta"->>'decision' IS DISTINCT FROM 'superseded'
      ORDER BY "id" DESC
    `;
    const priorHoldId = decided[0]?.id ?? null;
    const ruled = decided.find((row) => row.textHash === hold.textHash);
    const [pending] = await tx.$queryRaw<PendingRow[]>`
      SELECT "id", "text", "textHash", "reason", "workflowId", "meta",
        coalesce("meta"->'decisionClaim' IS NOT NULL
          AND NOT coalesce(("meta"->'decisionClaim'->>'at')::timestamptz < now() - interval '30 minutes', false),
          false) AS "claimed"
      FROM "TextScanHold"
      WHERE "entityType" = ${hold.entityType} AND "entityId" = ${hold.entityId}
        AND "label" = 'csam' AND "status" = 'Pending'
    `;

    if (!pending) {
      if (ruled) return { holdId: null, write: 'skipped', priorHoldId };
      const meta = JSON.stringify(
        priorHoldId === null ? hold.meta : { ...hold.meta, kind: 'redetected', priorHoldId }
      );
      const [row] = await tx.$queryRaw<{ id: number }[]>`
        INSERT INTO "TextScanHold"
          ("entityType", "entityId", "label", "textHash", "userId", "text", "reason", "workflowId",
           "promptId", "contentAt", "meta", "updatedAt")
        VALUES (${hold.entityType}, ${hold.entityId}, 'csam', ${hold.textHash}, ${hold.userId},
          ${hold.text}, ${hold.reason}, ${hold.workflowId ?? null}, ${hold.promptId},
          (${hold.contentAt?.toISOString() ?? null}::timestamptz AT TIME ZONE 'UTC'),
          ${meta}::jsonb, now())
        RETURNING "id"
      `;
      return { holdId: row.id, write: 'created', priorHoldId };
    }

    if (pending.textHash === hold.textHash)
      return { holdId: null, write: 'unchanged', priorHoldId };
    // Leave a hold mid-decision alone: swapping the text would apply the ruling to text the moderator never saw. A claim is live for 30 min, well past the 5 a decision waits.
    if (pending.claimed) throw new CsamHoldBusyError();

    const { decisionClaim: _claim, ruledBefore: _ruled, previous, ...kept } = pending.meta ?? {};
    const replaced = {
      text: pending.text,
      textHash: pending.textHash,
      reason: pending.reason,
      workflowId: pending.workflowId,
      at: new Date().toISOString(),
    };
    const meta = JSON.stringify({
      ...kept,
      ...hold.meta,
      textUpdatedAt: replaced.at,
      ...(priorHoldId === null ? {} : { kind: 'redetected', priorHoldId }),
      ...(ruled ? { ruledBefore: { holdId: ruled.id, status: ruled.status } } : {}),
      previous: [replaced, ...(Array.isArray(previous) ? previous : [])].slice(
        0,
        PREVIOUS_TEXTS_KEPT
      ),
    });
    // A decision's claim does not take the entity lock, so one can land after the read above; the
    // update matches only the row as read and unclaimed, rather than overwrite the claim.
    const updated = await tx.$executeRaw`
      UPDATE "TextScanHold" SET
        "textHash" = ${hold.textHash},
        "text" = ${hold.text},
        "reason" = ${hold.reason},
        "workflowId" = ${hold.workflowId ?? null},
        "promptId" = ${hold.promptId},
        "contentAt" = (${hold.contentAt?.toISOString() ?? null}::timestamptz AT TIME ZONE 'UTC'),
        "meta" = ${meta}::jsonb,
        "updatedAt" = now()
      WHERE "id" = ${pending.id} AND "status" = 'Pending' AND "textHash" = ${pending.textHash}
        AND ("meta"->'decisionClaim' IS NULL
          OR coalesce(("meta"->'decisionClaim'->>'at')::timestamptz < now() - interval '30 minutes', false))
    `;
    if (!updated) throw new CsamHoldBusyError();
    return { holdId: pending.id, write: 'updated', priorHoldId };
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
