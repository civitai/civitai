import type { Prisma } from '@prisma/client';

export type CsamHoldRow = { status: string; textHash: string; meta: Prisma.JsonValue };

/**
 * A hold awaiting a moderator bars the content. So does a verdict that raises one, until a moderator
 * dismisses the hold for that text: the verdict is recorded before its hold is written.
 */
export function csamHoldBars(
  check: { triggeredLabels: string[]; result: Prisma.JsonValue } | null,
  holds: CsamHoldRow[]
) {
  if (holds.some((hold) => hold.status === 'Pending')) return true;
  if (!check?.triggeredLabels.includes('csam')) return false;
  const textHash = (check.result as { textHash?: unknown } | null)?.textHash;
  // A superseded hold was closed without a ruling.
  return !holds.some(
    (hold) =>
      hold.status === 'Dismissed' &&
      hold.textHash === textHash &&
      (hold.meta as { decision?: unknown } | null)?.decision !== 'superseded'
  );
}
