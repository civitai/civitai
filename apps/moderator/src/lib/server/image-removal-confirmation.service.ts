import { sql } from '@civitai/db/kysely';
import { ReportStatus } from '$lib/reports';
import { dbRead, dbWrite } from './db';
import { blockImage, isBannedOwnerBlocked, isModerationBlocked } from './image-moderation.service';
import { recordModActivity } from './mod-activity';
import { setReportStatus } from './reports.service';
import {
  getLatestApprovedImageAppeals,
  OPEN_REPORT_STATUSES,
} from '@civitai/db-queries/image-removal-confirmation';
import { restrictedImageIds, withheldRow } from './retracted-media';
import { confirmRemovalRefusal } from '$lib/removal-confirmation';

// Removals held by `holdRemovals` because they repeat the reason an approved appeal overturned. A
// moderator holding `image.removal.confirm` decides each one on /images/re-removals. Confirming runs
// the held removal as its requester's; declining leaves the image up.

export const REMOVAL_CONFIRMATION_STATUSES = ['Pending', 'Confirmed', 'Declined', 'Void'] as const;
export type RemovalConfirmationStatus = (typeof REMOVAL_CONFIRMATION_STATUSES)[number];

export async function countPendingRemovalConfirmations(): Promise<number> {
  const row = await dbRead
    .selectFrom('ImageRemovalConfirmation')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('status', '=', 'Pending')
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function getRemovalConfirmations({
  status,
  limit,
  csamReview,
}: {
  status: RemovalConfirmationStatus;
  limit: number;
  csamReview: boolean;
}) {
  const rows = await dbRead
    .selectFrom('ImageRemovalConfirmation as c')
    .innerJoin('Image as i', 'i.id', 'c.imageId')
    .innerJoin('Appeal as a', 'a.id', 'c.appealId')
    .leftJoin('AppealDecisionRecord as d', 'd.appealId', 'a.id')
    .leftJoin('User as owner', 'owner.id', 'i.userId')
    .leftJoin('User as rq', 'rq.id', 'c.requestedById')
    .leftJoin('User as dc', 'dc.id', 'c.decidedById')
    .leftJoin('User as ap', 'ap.id', 'a.resolvedBy')
    .select([
      'c.id',
      'c.imageId',
      'c.status',
      'c.source',
      'c.violationType',
      'c.violationDetails',
      'c.reportIds',
      'c.requestedAt',
      'c.requestedById',
      'c.joinedByIds',
      'rq.username as requestedByUsername',
      'c.decidedAt',
      'dc.username as decidedByUsername',
      'c.decisionNote',
      'i.url',
      'i.type as mediaType',
      'i.nsfwLevel',
      'i.ingestion',
      'i.userId as ownerId',
      'owner.username as ownerUsername',
      'a.id as appealId',
      'a.appealMessage',
      sql<Date | null>`a."resolvedAt" AT TIME ZONE 'UTC'`.as('approvedAt'),
      'ap.username as approvedByUsername',
      'a.resolvedReason',
      'a.resolvedMessage',
      'd.removalLabel',
    ])
    .where('c.status', '=', status)
    .orderBy('c.requestedAt', status === 'Pending' ? 'asc' : 'desc')
    .orderBy('c.id', status === 'Pending' ? 'asc' : 'desc')
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit);
  const withheld = await restrictedImageIds(
    page.map((row) => row.imageId),
    { csamReview }
  );
  const items = page.map((row) =>
    withheld.has(row.imageId)
      ? {
          ...withheldRow(row),
          mediaType: null,
          violationType: null,
          violationDetails: null,
          reportIds: [] as number[],
          removalLabel: null,
          appealMessage: null,
          resolvedReason: null,
          resolvedMessage: null,
          decisionNote: null,
        }
      : { ...row, restricted: false }
  );
  return { items, hasMore: rows.length > limit };
}

export type DecideResult =
  | { ok: true; status: RemovalConfirmationStatus; note?: string }
  | { ok: false; error: string };

/** Removal paths whose unheld run also actions every open TOS report on the image. */
const TOS_SETTLING_SOURCES = ['api.removeImages', 'site.setTosViolation'];

const NOT_PENDING = 'This removal was decided or changed since the page loaded. Reload.';

/** The image a removal confirmation is about; `null` for one that does not exist. */
export async function removalConfirmationImageId(id: number): Promise<number | null> {
  const row = await dbWrite
    .selectFrom('ImageRemovalConfirmation')
    .select('imageId')
    .where('id', '=', id)
    .executeTakeFirst();
  return row?.imageId ?? null;
}

/**
 * Confirms a held removal and runs it. Neither the requester nor a moderator whose removal joined the
 * request may confirm: the hold exists so a moderator with no part in it agrees. The removal is
 * recorded as the requester's, the confirmation as the confirmer's.
 */
export async function confirmRemoval({
  id,
  userId,
  note,
}: {
  id: number;
  userId: number;
  note?: string;
}): Promise<DecideResult> {
  const row = await dbWrite
    .selectFrom('ImageRemovalConfirmation')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row || row.status !== 'Pending') return { ok: false, error: NOT_PENDING };
  const refusal = confirmRemovalRefusal(row, userId);
  if (refusal) return { ok: false, error: refusal };

  // Void rather than run: removed meanwhile (running it again would notify the owner twice), or a
  // later appeal was approved, which this request never weighed.
  const latestAppeal = (await getLatestApprovedImageAppeals(dbWrite, [row.imageId])).get(
    row.imageId
  );
  const voidNote = (await isModerationBlocked(row.imageId))
    ? 'Already removed'
    : latestAppeal && latestAppeal.appealId !== row.appealId
    ? 'A later appeal was approved'
    : null;
  const status: RemovalConfirmationStatus = voidNote ? 'Void' : 'Confirmed';
  // Voided because another removal already took it down: that block decides the payout. Read before
  // the claim, so a failure here leaves the request Pending.
  const voidUnpaid =
    voidNote === 'Already removed' ? await isBannedOwnerBlocked(row.imageId) : false;

  // Claimed in one statement so two confirmers cannot both run the removal. A removal that joined
  // the request since the read above moved its appeal or added reports: refused, or read back here.
  const claimed = await dbWrite
    .updateTable('ImageRemovalConfirmation')
    .set({
      status,
      decidedById: userId,
      decidedAt: new Date(),
      decisionNote: voidNote ?? note ?? null,
    })
    .where('id', '=', id)
    .where('status', '=', 'Pending')
    .where('requestedById', '<>', userId)
    .where(sql<boolean>`NOT (${userId} = ANY("joinedByIds"))`)
    .where('appealId', '=', row.appealId)
    .returning('reportIds')
    .executeTakeFirst();
  if (!claimed) return { ok: false, error: NOT_PENDING };
  if (voidNote === 'A later appeal was approved') return { ok: true, status, note: voidNote };

  let skipped = false;
  let unpaid = voidUnpaid;
  if (!voidNote)
    try {
      unpaid = await isBannedOwnerBlocked(row.imageId);
      const result = await blockImage({
        imageId: row.imageId,
        userId: row.requestedById,
        violationType: row.violationType ?? undefined,
        violationDetails: row.violationDetails ?? undefined,
        skipAppealCheck: true,
      });
      skipped = !!result.skipped;
    } catch (e) {
      // Back to Pending so it is not recorded as confirmed with the image still up.
      await dbWrite
        .updateTable('ImageRemovalConfirmation')
        .set({ status: 'Pending', decidedById: null, decidedAt: null, decisionNote: null })
        .where('id', '=', id)
        .execute();
      throw e;
    }
  // The image is down either way, so the reports the removal answered are actioned, unless it is
  // held. One a moderator has reviewed since the hold keeps its status.
  const settlesTos = !voidNote && TOS_SETTLING_SOURCES.includes(row.source);
  const openReportIds =
    skipped || (!settlesTos && !claimed.reportIds.length)
      ? []
      : (
          await dbWrite
            .selectFrom('ImageReport as ir')
            .innerJoin('Report as r', 'r.id', 'ir.reportId')
            .select('r.id')
            .where('ir.imageId', '=', row.imageId)
            .where('r.status', 'in', OPEN_REPORT_STATUSES)
            .where((eb) =>
              eb.or([
                ...(claimed.reportIds.length ? [eb('r.id', 'in', claimed.reportIds)] : []),
                ...(settlesTos ? [eb(sql<string>`r.reason::text`, '=', 'TOSViolation')] : []),
              ])
            )
            .orderBy('r.id')
            .execute()
        ).map((r) => r.id);
  for (const reportId of openReportIds)
    await setReportStatus({
      id: reportId,
      status: ReportStatus.Actioned,
      userId,
      noReward: unpaid,
      fromStatuses: OPEN_REPORT_STATUSES,
    });
  await recordModActivity({
    userId,
    entityType: 'image',
    entityId: row.imageId,
    activity: 'confirmRemoval',
  });
  return { ok: true, status, ...(voidNote && { note: voidNote }) };
}

/** Declines a held removal; the image stays up. */
export async function declineRemoval({
  id,
  userId,
  note,
}: {
  id: number;
  userId: number;
  note?: string;
}): Promise<DecideResult> {
  const declined = await dbWrite
    .updateTable('ImageRemovalConfirmation')
    .set({
      status: 'Declined',
      decidedById: userId,
      decidedAt: new Date(),
      decisionNote: note ?? null,
    })
    .where('id', '=', id)
    .where('status', '=', 'Pending')
    .returning('imageId')
    .executeTakeFirst();
  if (!declined) return { ok: false, error: NOT_PENDING };
  await recordModActivity({
    userId,
    entityType: 'image',
    entityId: declined.imageId,
    activity: 'declineRemoval',
  });
  return { ok: true, status: 'Declined' };
}
