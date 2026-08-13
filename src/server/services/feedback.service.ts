import { dbWrite } from '~/server/db/client';
import { isFlipt } from '~/server/flipt/client';
import type { CreateFeedbackInput } from '~/server/schema/feedback.schema';
import type { FeedbackArea } from '~/shared/constants/feedback.constants';
import { feedbackAreaFlagKey } from '~/shared/constants/feedback.constants';

export async function isFeedbackAreaEnabled({
  area,
  userId,
}: {
  area: FeedbackArea;
  userId?: number;
}) {
  // isEnabled, not getBoolean: getBoolean deliberately ignores
  // FLIPT_LOCAL_OVERRIDES, so an area could never be switched on locally.
  return isFlipt(feedbackAreaFlagKey(area), userId?.toString() ?? 'anonymous');
}

export async function createFeedback({
  userId,
  area,
  message,
  context,
}: CreateFeedbackInput & { userId: number }) {
  return dbWrite.feedback.create({
    data: { userId, area, message, context: context ?? {} },
    select: { id: true },
  });
}
