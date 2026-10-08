import { NotificationCategory } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { getCreatorJourneyConfig } from '~/server/services/creator-journey-config.service';
import type { ScoreTierCrossing } from '~/server/services/creator-milestone-grant.service';
import { LEGEND } from '~/server/services/creator-showcase.service';
import { createNotification } from '~/server/services/notification.service';

/**
 * Tells the staff in `legendAlertUserIds` that a creator just became a Legend, so one of them can
 * send a personal note. Takes crossings only: a silent grant (the launch backfill, a tier already
 * passed) never reaches here, so a Founding Legend is never announced as new.
 */
export async function alertNewLegends(
  crossings: Pick<ScoreTierCrossing, 'userId' | 'milestoneKey'>[]
) {
  const legendUserIds = [
    ...new Set(crossings.filter((c) => c.milestoneKey === LEGEND).map((c) => c.userId)),
  ];
  if (!legendUserIds.length) return;

  const { legendAlertUserIds } = await getCreatorJourneyConfig();
  if (!legendAlertUserIds?.length) return;

  const users = await dbRead.user.findMany({
    where: { id: { in: legendUserIds } },
    select: { id: true, username: true },
  });
  for (const user of users) {
    await createNotification({
      type: 'creator-legend-reached-staff',
      category: NotificationCategory.System,
      key: `creator-legend-reached-staff:${user.id}`,
      userIds: legendAlertUserIds,
      details: { userId: user.id, username: user.username },
    });
  }
}
