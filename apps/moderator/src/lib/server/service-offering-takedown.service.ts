import { NotificationCategory } from '@civitai/notifications';
import {
  SERVICE_OFFERING_TAKEN_DOWN,
  sellerFacingTakedownDetails,
  serviceOfferingTakenDownKey,
  type ServiceOfferingTakedownReason,
} from '@civitai/shared/service-offering-takedown';
import { dbRead, dbWrite } from './db';
import { recordModActivity } from './mod-activity';
import { getNotifications } from './notifications';

export type ReportedServiceOffering = {
  id: number;
  title: string;
  description: string;
  status: string;
  maxNsfwLevel: number;
  sellerId: number;
  sellerUsername: string | null;
  removedReason: string | null;
  removedDetails: string | null;
  removedAt: Date | null;
};

const selectOffering = (db: typeof dbRead) =>
  db
    .selectFrom('ServiceOffering as o')
    .leftJoin('User as u', 'u.id', 'o.sellerId')
    .select([
      'o.id',
      'o.title',
      'o.description',
      'o.status',
      'o.maxNsfwLevel',
      'o.sellerId',
      'u.username as sellerUsername',
      'o.removedReason',
      'o.removedDetails',
      'o.removedAt',
    ]);

/** What each reported offering looks like now, for the report sheet: the shop it links to hides
 *  paused, removed and mature offerings, so the sheet shows the offering itself. */
export async function getReportedServiceOfferings(
  ids: number[]
): Promise<ReportedServiceOffering[]> {
  if (!ids.length) return [];
  return selectOffering(dbRead).where('o.id', 'in', ids).execute();
}

/** The offering a report is about, read from the primary: the moderator is acting on it. */
export async function getReportServiceOfferingId(reportId: number): Promise<number | null> {
  const row = await dbWrite
    .selectFrom('ServiceOfferingReport')
    .select('serviceOfferingId')
    .where('reportId', '=', reportId)
    .executeTakeFirst();
  return row?.serviceOfferingId ?? null;
}

/**
 * The main app's `takedownServiceOffering`, for the report queue. The same conditional write: it
 * applies to any offering not already taken down, including one its seller removed, so removing
 * first cannot dodge it. The seller is notified, and the activity recorded, only by the write that
 * took it down, so two moderators acting at once send one notification.
 *
 * What a takedown does to deals is read from `removedReason` by the deal code (no new requests,
 * pending ones cannot be accepted), so it follows from this write and needs nothing here.
 *
 * Null when the offering no longer exists.
 */
export async function takedownServiceOffering({
  offeringId,
  reason,
  details,
  moderatorId,
}: {
  offeringId: number;
  reason: ServiceOfferingTakedownReason;
  details: string | null;
  moderatorId: number;
}): Promise<(ReportedServiceOffering & { changed: boolean }) | null> {
  const { numUpdatedRows } = await dbWrite
    .updateTable('ServiceOffering')
    .set({
      status: 'Removed',
      removedReason: reason,
      removedDetails: details,
      removedAt: new Date(),
      removedById: moderatorId,
      // Prisma's @updatedAt sets this on the main app's write; Kysely does not.
      updatedAt: new Date(),
    })
    .where('id', '=', offeringId)
    .where('removedReason', 'is', null)
    .executeTakeFirst();

  const offering = await selectOffering(dbWrite).where('o.id', '=', offeringId).executeTakeFirst();
  if (!offering) return null;

  const changed = numUpdatedRows > 0n;
  if (changed) {
    await recordModActivity({
      userId: moderatorId,
      entityType: 'serviceOffering',
      entityId: offeringId,
      activity: 'takedown',
    });
    try {
      // Never the moderator: the seller is told what was removed and why.
      await getNotifications().createNotification({
        userId: offering.sellerId,
        type: SERVICE_OFFERING_TAKEN_DOWN,
        category: NotificationCategory.System,
        key: serviceOfferingTakenDownKey(offeringId),
        details: {
          offeringId,
          offeringTitle: offering.title,
          sellerUsername: offering.sellerUsername,
          reason,
          details: sellerFacingTakedownDetails(reason, details),
        },
      });
    } catch (error) {
      // Best-effort: the takedown has landed. Logged here because a payload the client rejects
      // throws before its own failure logging runs.
      console.error('service-offering-takedown: seller notification failed', {
        offeringId,
        error: (error as Error)?.message,
      });
    }
  }
  return { ...offering, changed };
}
