import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import { getTextScanCsamMode } from '~/server/services/text-scan/mode';
import { composeUserText } from '~/server/services/text-scan/segment';
import type { PromptIds, TextScanEntityType } from '~/server/services/text-scan/types';
import { isPrismaUniqueViolation } from '~/server/utils/errorHandling';

export const CSAM_HOLD_TEXT_CHARS = 50_000;

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
}: ApplyTextScanArgs & { entityType: TextScanEntityType; promptIds?: PromptIds }) {
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
        text: composeUserText(subject).slice(0, CSAM_HOLD_TEXT_CHARS),
        reason: outcome.csam.reason,
        workflowId,
        promptId: promptIds?.csam ?? null,
        contentAt: contentAtOf(subject.meta),
        meta: (subject.meta ?? undefined) as Prisma.InputJsonValue | undefined,
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
 * The hold goes first so a failing entity action (a scam cleanup, a rating floor) cannot cost it. A
 * failed hold is rethrown only after that action ran, so the callback marks the row Failed and the
 * retry cron rescans for it.
 */
export function withCsamHold(
  entityType: TextScanEntityType,
  apply: (args: ApplyTextScanArgs) => Promise<unknown>
) {
  return async (args: ApplyTextScanArgs) => {
    let holdError: unknown;
    try {
      await applyCsamHold({ entityType, ...args });
    } catch (error) {
      holdError = error ?? new Error('csam hold failed');
    }
    await apply(args);
    if (holdError) throw holdError;
  };
}
