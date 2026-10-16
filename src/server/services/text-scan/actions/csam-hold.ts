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

const messageIdsOf = (meta: unknown) => {
  const ids = (meta as { messageIds?: unknown } | null)?.messageIds;
  return Array.isArray(ids) ? ids : [];
};

/**
 * Each new message rescans the sender's recent window, so one conversation would otherwise queue a
 * hold per message. The id of the newest pending or newest decided hold that already saw every
 * message in this window.
 */
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
  const coveredBy =
    entityType === 'ChatMessage' ? await coveringChatHold(userId, subject.meta) : null;
  let holdId: number | null = null;
  if (coveredBy === null) {
    try {
      const hold = await dbWrite.textScanHold.create({
        data: {
          entityType,
          entityId,
          label: 'csam',
          textHash,
          userId,
          // Cut before well-forming, so a pair split by the cap is replaced rather than kept half.
          text: sanitizeForPostgres(composeUserText(subject).slice(0, CSAM_HOLD_TEXT_CHARS)),
          reason: sanitizeForPostgres(outcome.csam.reason),
          workflowId,
          promptId: promptIds?.csam ?? null,
          contentAt: contentAtOf(subject.meta),
          meta: (subject.meta ? storable(subject.meta) : undefined) as
            | Prisma.InputJsonValue
            | undefined,
        },
        select: { id: true },
      });
      holdId = hold.id;
    } catch (error) {
      if (!isPrismaUniqueViolation(error)) throw error;
    }
  }

  logToAxiom({
    name: 'text-scan',
    type: 'csam-hold',
    message: holdId ? 'csam hold created, awaiting moderator' : 'csam hold already recorded',
    entityType,
    entityId,
    workflowId,
    holdId,
    created: holdId !== null,
    ...(coveredBy !== null ? { coveredBy } : {}),
  }).catch(() => null);
}

/**
 * The hold goes first, and a failed write fails the callback before the entity action runs: the
 * retry cron rescans, and an action that never ran cannot be applied twice.
 */
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
