import { NotificationCategory } from '~/server/common/enums';
import { createNotification } from '~/server/services/notification.service';
import { highestNsfwLevel } from '~/server/services/text-scan/evaluate';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

export const TEXT_SCAN_RATING_RAISED = 'text-scan-rating-raised';

export function ratingRose(before: number, after: number) {
  const droppedSfwBit = (before & sfwBrowsingLevelsFlag & ~after) !== 0;
  return droppedSfwBit || highestNsfwLevel(after) > highestNsfwLevel(before);
}

export type NotifyTextScanRatingRaisedArgs = Parameters<typeof notifyTextScanRatingRaised>[0];

export function textScanRatingRaisedKey({
  entityType,
  entityId,
  level,
  workflowId,
}: {
  entityType: string;
  entityId: number;
  level: number;
  workflowId: string;
}) {
  return `${TEXT_SCAN_RATING_RAISED}-${entityType}-${entityId}-${level}-${workflowId}`;
}

export async function notifyTextScanRatingRaised({
  entityType,
  entityId,
  userId,
  level,
  title,
  url,
  workflowId,
}: {
  entityType: string;
  entityId: number;
  userId: number;
  level: number;
  title: string | null;
  url: string;
  workflowId: string;
}) {
  await createNotification({
    userId,
    category: NotificationCategory.Moderation,
    type: TEXT_SCAN_RATING_RAISED,
    key: textScanRatingRaisedKey({ entityType, entityId, level, workflowId }),
    details: { entityType, entityId, level, title, url },
  });
}
