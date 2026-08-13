import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { getFliptBoolean } from '~/server/flipt/client';
import type { CreateFeedbackInput } from '~/server/schema/feedback.schema';
import type { FeedbackArea } from '~/shared/constants/feedback.constants';
import { FEEDBACK_RATE_LIMIT, feedbackAreaFlagKey } from '~/shared/constants/feedback.constants';

export async function isFeedbackAreaEnabled({
  area,
  userId,
}: {
  area: FeedbackArea;
  userId?: number;
}) {
  return getFliptBoolean(feedbackAreaFlagKey(area), userId?.toString() ?? 'anonymous');
}

export async function createFeedback({
  userId,
  area,
  message,
  context,
}: CreateFeedbackInput & { userId: number }) {
  const since = new Date(Date.now() - FEEDBACK_RATE_LIMIT.windowMs);
  const recentCount = await dbRead.feedback.count({
    where: { userId, createdAt: { gt: since } },
  });
  if (recentCount >= FEEDBACK_RATE_LIMIT.max)
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `You can submit ${FEEDBACK_RATE_LIMIT.max} pieces of feedback per hour. Try again later.`,
    });

  return dbWrite.feedback.create({
    data: { userId, area, message, context: context ?? {} },
    select: { id: true },
  });
}
