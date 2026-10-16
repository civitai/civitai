import { NotificationCategory } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { getCreatorJourneyConfig } from '~/server/services/creator-journey-config.service';
import type { ScoreTierCrossing } from '~/server/services/creator-milestone-grant.service';
import { scoreTierKey } from '~/shared/constants/creator-journey.constants';
import { createNotification } from '~/server/services/notification.service';

/** The tiers whose crossing staff hear about, with the notification each one sends. */
const ALERTED_TIERS = [
  { milestoneKey: scoreTierKey('legend'), type: 'creator-legend-reached-staff' },
  { milestoneKey: scoreTierKey('mythic'), type: 'creator-mythic-reached-staff' },
] as const;

/**
 * Tells the staff in `legendAlertUserIds` that a creator just became a Legend or a Mythic, so one of
 * them can send a personal note. Takes crossings only: a silent grant (the launch backfill, a tier
 * already passed) never reaches here, so a founding holder is never announced as new.
 */
export async function alertNewLegends(
  crossings: Pick<ScoreTierCrossing, 'userId' | 'milestoneKey'>[]
) {
  const alerts = ALERTED_TIERS.map((tier) => ({
    type: tier.type,
    userIds: [
      ...new Set(
        crossings.filter((c) => c.milestoneKey === tier.milestoneKey).map((c) => c.userId)
      ),
    ],
  })).filter((alert) => alert.userIds.length);
  if (!alerts.length) return;

  const { legendAlertUserIds } = await getCreatorJourneyConfig();
  if (!legendAlertUserIds?.length) return;

  const users = await dbRead.user.findMany({
    where: { id: { in: [...new Set(alerts.flatMap((alert) => alert.userIds))] } },
    select: { id: true, username: true },
  });
  for (const { type, userIds } of alerts) {
    for (const user of users) {
      // The message links to the profile, which needs a username.
      if (!userIds.includes(user.id) || !user.username) continue;
      await createNotification({
        type,
        category: NotificationCategory.System,
        key: `${type}:${user.id}`,
        userIds: legendAlertUserIds,
        details: { userId: user.id, username: user.username },
      });
    }
  }
}
