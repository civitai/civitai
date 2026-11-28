import { csamQueueHeldText } from '@civitai/shared/held-url';
import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { csamHoldBars } from '~/server/services/text-scan/csam-hold-bars';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import type { TextScanSubject } from '~/server/services/text-scan/types';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';

/** The caller's transaction, to read holds and the verdict on it; the primary otherwise. */
export type CsamHoldReader = Pick<Prisma.TransactionClient, 'textScanHold' | 'entityModeration'>;

export const readCsamHolds = (
  entityType: string,
  entityId: number,
  // primary: read with a verdict just written, to decide whether the content may be shown.
  db: CsamHoldReader = dbWrite
) =>
  db.textScanHold.findMany({
    where: { entityType, entityId, label: 'csam' },
    select: { status: true, textHash: true, meta: true },
  });

export type CsamHoldState = 'held' | 'clear' | 'unverified';

/**
 * Whether an entity hidden until scanned is held for the csam queue, read from the stored rows
 * alone. `unverified` when the stored verdict is not about the current text, or there is none; such
 * an entity is not shown.
 */
export async function csamHoldState(
  entityType: string,
  entityId: number,
  loadSubject: (id: number) => Promise<TextScanSubject | undefined>,
  // primary: the verdict a callback has just recorded.
  db: CsamHoldReader = dbWrite
): Promise<CsamHoldState> {
  const holds = await readCsamHolds(entityType, entityId, db);
  if (csamHoldBars(null, holds)) return 'held';
  const verdict = await db.entityModeration.findUnique({
    where: { entityType_entityId: { entityType, entityId } },
    select: { status: true, triggeredLabels: true, result: true },
  });
  if (verdict?.status !== EntityModerationStatus.Succeeded) return 'unverified';
  const held = csamHoldBars(verdict, holds);
  const result = verdict.result as { version?: unknown; textHash?: unknown } | null;
  // A fallback-check row carries no text hash and never this label.
  if (result?.version === undefined) return held ? 'held' : 'clear';
  const subject = await loadSubject(entityId);
  if (typeof result.textHash !== 'string' || !subject) return held ? 'held' : 'unverified';
  if (textScanTextHash(subject) !== result.textHash) return 'unverified';
  return held ? 'held' : 'clear';
}

/**
 * True in SQL when nothing in the csam queue holds the entity: no hold pending or confirmed, and no
 * csam verdict a moderator has not dismissed for its text. Only that queue's decisions let a held
 * entity out.
 */
export const csamQueueClearSql = (entityType: string, entityId: number) =>
  Prisma.sql`NOT ${Prisma.raw(csamQueueHeldText(entityType, String(entityId)))}`;
