import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { getFliptBoolean } from '~/server/flipt/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
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

const windowSeconds = Math.round(FEEDBACK_RATE_LIMIT.windowMs / 1000);

/**
 * INCR + EXPIRE, so N concurrent submits from one click cannot each read the
 * same pre-write count and all pass. On a Redis error it falls back to counting
 * rows on the WRITER — non-atomic, so a burst can overshoot, but it still bounds
 * sustained abuse rather than removing the limit with the cache.
 */
async function withinRateLimit(userId: number) {
  const key = `${REDIS_SYS_KEYS.FEEDBACK.RATE_LIMIT}:${userId}` as const;
  try {
    const count = await sysRedis.incrBy(key, 1);
    if (count === 1) await sysRedis.expire(key, windowSeconds);
    else {
      const ttl = await sysRedis.ttl(key);
      if (ttl < 0) await sysRedis.expire(key, windowSeconds);
    }
    return count <= FEEDBACK_RATE_LIMIT.max;
  } catch {
    // Counted on dbWrite, never dbRead: the replica can lag behind rows this
    // same user just wrote, which reads as an empty window.
    const recent = await dbWrite.feedback.count({
      where: { userId, createdAt: { gt: new Date(Date.now() - FEEDBACK_RATE_LIMIT.windowMs) } },
    });
    return recent < FEEDBACK_RATE_LIMIT.max;
  }
}

export async function createFeedback({
  userId,
  area,
  message,
  context,
}: CreateFeedbackInput & { userId: number }) {
  if (!(await withinRateLimit(userId)))
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `You can submit ${FEEDBACK_RATE_LIMIT.max} pieces of feedback per hour. Try again later.`,
    });

  return dbWrite.feedback.create({
    data: { userId, area, message, context: context ?? {} },
    select: { id: true },
  });
}
