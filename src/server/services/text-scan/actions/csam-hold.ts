import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import { getTextScanCsamMode } from '~/server/services/text-scan/mode';
import { composeUserText } from '~/server/services/text-scan/segment';
import type { TextScanEntityType } from '~/server/services/text-scan/types';
import { isPrismaUniqueViolation } from '~/server/utils/errorHandling';

export const CSAM_HOLD_TEXT_CHARS = 50_000;

// Postgres rejects NUL and lone surrogates, so storing either would fail every retry.
const stripNul = (value: string) => value.replace(/\u0000/g, '');

function storable(value: unknown): unknown {
  if (typeof value === 'string') return stripNul(value);
  if (Array.isArray(value)) return value.map(storable);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, storable(v)]));
  return value;
}

function capText(text: string, max: number) {
  const cut = stripNul(text).slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function contentAtOf(meta: Record<string, unknown> | undefined) {
  const value = meta?.contentAt;
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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
  // Submit already drops csam while the gate is off, but a verdict submitted before a flip can land after it.
  if ((await getTextScanCsamMode()) !== 'review') return;

  const userId = subject.userId && subject.userId > 0 ? subject.userId : null;
  let holdId: number | null = null;
  try {
    const hold = await dbWrite.textScanHold.create({
      data: {
        entityType,
        entityId,
        label: 'csam',
        textHash,
        userId,
        text: capText(composeUserText(subject), CSAM_HOLD_TEXT_CHARS),
        reason: stripNul(outcome.csam.reason),
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

  logToAxiom({
    name: 'text-scan',
    type: 'csam-hold',
    message: holdId ? 'csam hold created, awaiting moderator' : 'csam hold already recorded',
    entityType,
    entityId,
    workflowId,
    holdId,
    created: holdId !== null,
  }).catch(() => null);
}

/**
 * The hold goes first so a failing entity action (a scam cleanup, a rating floor) cannot cost it.
 */
export function withCsamHold(
  entityType: TextScanEntityType,
  apply: (args: ApplyTextScanArgs) => Promise<unknown>
) {
  return async (args: ApplyTextScanArgs) => {
    try {
      await applyCsamHold({ entityType, ...args });
    } catch (error) {
      // Not rethrown: a retry would re-run the entity action, and a deterministic failure would loop.
      logToAxiom({
        name: 'text-scan',
        type: 'error',
        message: 'csam hold failed',
        entityType,
        entityId: args.entityId,
        workflowId: args.workflowId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => null);
    }
    await apply(args);
  };
}
