import { sql } from '@civitai/db/kysely';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { violationUserMessage } from '$lib/violations';
import { ReportStatus } from '$lib/reports';
import { dbWrite } from './db';
import { logToAxiom } from './axiom';
import { notifyImageTosViolation } from './image-moderation-effects';
import { recordModActivity } from './mod-activity';
import { setReportStatus } from './reports.service';

/** Log names read by the monthly firing/sent reconciliation: keep them stable. */
export const DEFERRED_NOTICE_LOG = {
  firing: 'deferred-notice-firing',
  sent: 'deferred-notice-sent',
  failed: 'deferred-notice-failed',
  withheld: 'deferred-notice-withheld',
} as const;

/** The ModActivity row Legal Intake reads for a withheld notice. Ids only. */
export const DEFERRED_NOTICE_WITHHELD_ACTIVITY = 'deferredNoticeWithheld';

export type DeferredBlockEffect = { imageId: number; violationType: string | null };

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
    .returning(['imageId', 'violationType'])
    .execute();
}

/** For a close that outranks the block (an unblock): the effects go unfired. */
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

/**
 * Owners Legal holds notices for: named by any CSAM report or any evidence hold, released or not.
 * Read on the primary, so a report filed just before the close counts. A failed read holds them all.
 */
async function ownersWithNoticeWithheld(ownerIds: number[]): Promise<Set<number>> {
  try {
    const { rows } = await sql<{ userId: number }>`
      SELECT "userId" FROM "CsamReport" WHERE "userId" = ANY(${ownerIds}::int[])
      UNION
      SELECT "userId" FROM "EvidenceHold" WHERE "userId" = ANY(${ownerIds}::int[])
    `.execute(dbWrite);
    return new Set(rows.map((r) => r.userId));
  } catch (e) {
    console.error('[deferred-block-effects] withheld check failed', {
      error: (e as Error).message,
    });
    return new Set(ownerIds);
  }
}

/**
 * What a block put off, run at a close that is not a CSAM finding: the owner notice (unless Legal
 * holds it) and every report still open on the image, read now, actioned without paying its owner.
 */
export async function fireDeferredBlockEffects(
  claimed: readonly DeferredBlockEffect[],
  { moderatorId }: { moderatorId: number }
): Promise<void> {
  if (!claimed.length) return;
  const imageIds = claimed.map((c) => c.imageId);
  const images = await dbWrite
    .selectFrom('Image')
    .select(['id', 'userId', 'postId'])
    .where('id', 'in', imageIds)
    .execute();
  const byId = new Map(images.map((i) => [i.id, i]));
  const withheld = await ownersWithNoticeWithheld([...new Set(images.map((i) => i.userId))]);

  for (const { imageId, violationType } of claimed) {
    const image = byId.get(imageId);
    if (!image) continue;
    if (withheld.has(image.userId)) {
      await recordModActivity({
        userId: moderatorId,
        entityType: 'image',
        entityId: imageId,
        activity: DEFERRED_NOTICE_WITHHELD_ACTIVITY,
      });
      await logToAxiom({ type: 'warning', name: DEFERRED_NOTICE_LOG.withheld, imageId }).catch(
        () => undefined
      );
      continue;
    }
    // Logged before the send, so a notice lost to a crash shows as a firing with no sent.
    await logToAxiom({ type: 'info', name: DEFERRED_NOTICE_LOG.firing, imageId }).catch(
      () => undefined
    );
    const sent = await notifyImageTosViolation({
      imageId,
      ownerId: image.userId,
      postId: image.postId,
      reason: violationType ? violationUserMessage(violationType) : undefined,
    });
    await logToAxiom({
      type: sent ? 'info' : 'error',
      name: sent ? DEFERRED_NOTICE_LOG.sent : DEFERRED_NOTICE_LOG.failed,
      imageId,
    }).catch(() => undefined);
  }

  const reports = await dbWrite
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
  for (const { imageId, id } of reports) {
    const owner = byId.get(imageId)?.userId;
    await setReportStatus({
      id,
      status: ReportStatus.Actioned,
      userId: moderatorId,
      noRewardFor: owner == null ? [] : [owner],
    });
  }
}
