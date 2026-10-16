import { sql } from '@civitai/db/kysely';
import { ReportStatus } from '$lib/reports';
import { dbRead, dbWrite } from './db';
import { blockImage, isModerationBlocked } from './image-moderation.service';
import { recordModActivity } from './mod-activity';
import { setReportStatus } from './reports.service';
import { getLatestApprovedImageAppeals } from '@civitai/db-queries/image-removal-confirmation';

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
}: {
  status: RemovalConfirmationStatus;
  limit: number;
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
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

export type DecideResult =
  | { ok: true; status: RemovalConfirmationStatus; note?: string }
  | { ok: false; error: string };

const NOT_PENDING = 'This removal was decided or changed since the page loaded. Reload.';

/**
 * Confirms a held removal and runs it. The requester cannot confirm their own: the hold exists so a
 * second moderator agrees. The removal is recorded as the requester's, the confirmation as the
 * confirmer's.
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
  if (row.requestedById === userId)
    return {
      ok: false,
      error: 'You requested this removal, so another moderator must confirm it.',
    };

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
    .where('appealId', '=', row.appealId)
    .returning('reportIds')
    .executeTakeFirst();
  if (!claimed) return { ok: false, error: NOT_PENDING };
  if (voidNote === 'A later appeal was approved') return { ok: true, status, note: voidNote };

  if (!voidNote)
    try {
      await blockImage({
        imageId: row.imageId,
        userId: row.requestedById,
        violationType: row.violationType ?? undefined,
        violationDetails: row.violationDetails ?? undefined,
        skipAppealCheck: true,
      });
    } catch (e) {
      // Back to Pending so it is not recorded as confirmed with the image still up.
      await dbWrite
        .updateTable('ImageRemovalConfirmation')
        .set({ status: 'Pending', decidedById: null, decidedAt: null, decisionNote: null })
        .where('id', '=', id)
        .execute();
      throw e;
    }
  // The image is down either way, so the reports the removal answered are actioned.
  for (const reportId of claimed.reportIds)
    await setReportStatus({ id: reportId, status: ReportStatus.Actioned, userId });
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
