import { sql } from '@civitai/db/kysely';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { violationUserMessage } from '$lib/violations';
import { ReportStatus } from '$lib/reports';
import { dbWrite } from './db';
import { logToAxiom } from './axiom';
import { notifyImageTosViolation } from './image-moderation-effects';
import { insertModActivityBatch } from './mod-activity';
import { setReportStatus } from './reports.service';

/** Log names: keep them stable. */
export const DEFERRED_NOTICE_LOG = {
  firing: 'deferred-notice-firing',
  sent: 'deferred-notice-sent',
  failed: 'deferred-notice-failed',
  withheld: 'deferred-notice-withheld',
  checkFailed: 'deferred-notice-check-failed',
  effectFailed: 'deferred-effect-failed',
} as const;

/** ModActivity row for a notice not sent. Ids only. */
export const DEFERRED_NOTICE_WITHHELD_ACTIVITY = 'deferredNoticeWithheld';

export type DeferredBlockEffect = {
  imageId: number;
  violationType: string | null;
  notifyOwner: boolean;
};

const log = (data: Record<string, unknown>) => logToAxiom(data).catch(() => undefined);

/**
 * Deletes these images' deferred block effects and returns them, so each goes to exactly one close.
 * Run it inside the close's own transaction, and fire what it returns after that commits.
 */
export async function claimDeferredBlockEffects(
  db: Kysely<DB>,
  imageIds: readonly number[]
): Promise<DeferredBlockEffect[]> {
  if (!imageIds.length) return [];
  return db
    .deleteFrom('ImageDeferredBlockEffect')
    .where('imageId', 'in', [...imageIds])
    .returning(['imageId', 'violationType', 'notifyOwner'])
    .execute();
}

/** Drops the deferred effects unfired. */
export async function dropDeferredBlockEffects(
  db: Kysely<DB>,
  imageIds: readonly number[]
): Promise<void> {
  if (!imageIds.length) return;
  await db
    .deleteFrom('ImageDeferredBlockEffect')
    .where('imageId', 'in', [...imageIds])
    .execute();
}

/** Owners whose notice is not sent. Read on the primary; a failed read returns all of them. */
async function ownersWithNoticeWithheld(ownerIds: number[]): Promise<Set<number>> {
  if (!ownerIds.length) return new Set();
  try {
    const { rows } = await sql<{ userId: number }>`
      SELECT "userId" FROM "CsamReport" WHERE "userId" = ANY(${ownerIds}::int[])
      UNION
      SELECT u.id FROM "CsamReport" c, unnest(${ownerIds}::int[]) AS u(id)
      WHERE c.details ->> 'secondaryUserId' = u.id::text
      UNION
      SELECT "userId" FROM "EvidenceHold" WHERE "userId" = ANY(${ownerIds}::int[])
    `.execute(dbWrite);
    return new Set(rows.map((r) => r.userId));
  } catch (e) {
    await log({
      type: 'error',
      name: DEFERRED_NOTICE_LOG.checkFailed,
      message: (e as Error).message,
    });
    return new Set(ownerIds);
  }
}

/**
 * Runs what a block deferred: the owner notice (subject to `ownersWithNoticeWithheld`) and every
 * report still open on the image, read now, actioned without paying its owner. Never throws: the close
 * that claimed these has committed, so a failure is logged with the image id instead.
 */
export async function fireDeferredBlockEffects(
  claimed: readonly DeferredBlockEffect[],
  { moderatorId }: { moderatorId: number }
): Promise<void> {
  if (!claimed.length) return;
  const imageIds = claimed.map((c) => c.imageId);
  let images: { id: number; userId: number; postId: number | null }[];
  try {
    images = await dbWrite
      .selectFrom('Image')
      .select(['id', 'userId', 'postId'])
      .where('id', 'in', imageIds)
      .execute();
  } catch {
    for (const imageId of imageIds)
      await log({ type: 'error', name: DEFERRED_NOTICE_LOG.effectFailed, imageId });
    return;
  }
  if (!images.length) return;
  const byId = new Map(images.map((i) => [i.id, i]));
  const withheld = await ownersWithNoticeWithheld([...new Set(images.map((i) => i.userId))]);

  for (const { imageId, violationType, notifyOwner } of claimed) {
    const image = byId.get(imageId);
    if (!image || !notifyOwner) continue;
    if (withheld.has(image.userId)) {
      try {
        await insertModActivityBatch(dbWrite, {
          userId: moderatorId,
          entityType: 'image',
          entityIds: [imageId],
          activity: DEFERRED_NOTICE_WITHHELD_ACTIVITY,
        });
      } catch {
        await log({ type: 'error', name: DEFERRED_NOTICE_LOG.effectFailed, imageId });
      }
      await log({ type: 'warning', name: DEFERRED_NOTICE_LOG.withheld, imageId });
      continue;
    }
    // Logged before the send, so a notice lost to a crash shows as a firing with no sent.
    await log({ type: 'info', name: DEFERRED_NOTICE_LOG.firing, imageId });
    const sent = await notifyImageTosViolation({
      imageId,
      ownerId: image.userId,
      postId: image.postId,
      reason: violationType ? violationUserMessage(violationType) : undefined,
    });
    await log({
      type: sent ? 'info' : 'error',
      name: sent ? DEFERRED_NOTICE_LOG.sent : DEFERRED_NOTICE_LOG.failed,
      imageId,
    });
  }

  let reports: { imageId: number; id: number }[] = [];
  try {
    reports = await dbWrite
      .selectFrom('ImageReport as ir')
      .innerJoin('Report as r', 'r.id', 'ir.reportId')
      .select(['ir.imageId', 'r.id'])
      .where(
        'ir.imageId',
        'in',
        images.map((i) => i.id)
      )
      .where('r.status', 'in', [ReportStatus.Pending, ReportStatus.Processing])
      .execute();
  } catch {
    for (const imageId of imageIds)
      await log({ type: 'error', name: DEFERRED_NOTICE_LOG.effectFailed, imageId });
  }
  for (const { imageId, id } of reports) {
    const owner = byId.get(imageId)?.userId;
    try {
      await setReportStatus({
        id,
        status: ReportStatus.Actioned,
        userId: moderatorId,
        noRewardFor: owner == null ? [] : [owner],
      });
    } catch {
      await log({ type: 'error', name: DEFERRED_NOTICE_LOG.effectFailed, imageId, reportId: id });
    }
  }
}
