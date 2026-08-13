import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { getFliptBoolean } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
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
function rateLimitKey(userId: number) {
  return `${REDIS_SYS_KEYS.FEEDBACK.RATE_LIMIT}:${userId}` as const;
}

async function withinRateLimit(userId: number) {
  const key = rateLimitKey(userId);
  try {
    const count = await sysRedis.incrBy(key, 1);
    // Without an expiry the window never rolls and the fifth submission bars the
    // user forever, so the TTL is re-armed whenever the key has lost one.
    if (count === 1) await sysRedis.expire(key, windowSeconds);
    else {
      const ttl = await sysRedis.ttl(key);
      if (ttl < 0) await sysRedis.expire(key, windowSeconds);
    }
    return { allowed: count <= FEEDBACK_RATE_LIMIT.max, reserved: true };
  } catch (error) {
    // The sys client fast-fails during any reconnect, so this is a routine
    // window rather than "redis is down" — log it, or the limiter silently
    // degrades to the weaker path with nothing to see.
    logToAxiom({
      type: 'feedback-rate-limit-degraded',
      error: error instanceof Error ? error.message : String(error),
      userId,
    }).catch(() => undefined);
    // Counted on dbWrite, never dbRead: the replica can lag behind rows this
    // same user just wrote, which reads as an empty window.
    const recent = await dbWrite.feedback.count({
      where: { userId, createdAt: { gt: new Date(Date.now() - FEEDBACK_RATE_LIMIT.windowMs) } },
    });
    return { allowed: recent < FEEDBACK_RATE_LIMIT.max, reserved: false };
  }
}

/** A slot is spent on the WRITE, not the attempt. Without this a failed insert —
 * a DB blip, or the table not yet applied in this environment — locks the user
 * out for an hour with no row to show for it. Best-effort: a lost refund
 * over-counts, which only makes the cap stricter. */
async function refundRateLimit(userId: number) {
  await sysRedis.decrBy(rateLimitKey(userId), 1).catch(() => undefined);
}

export async function createFeedback({
  userId,
  area,
  message,
  context,
}: CreateFeedbackInput & { userId: number }) {
  const { allowed, reserved } = await withinRateLimit(userId);
  if (!allowed)
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `You can submit ${FEEDBACK_RATE_LIMIT.max} pieces of feedback per hour. Try again later.`,
    });

  try {
    return await dbWrite.feedback.create({
      data: { userId, area, message, context: context ?? {} },
      select: { id: true },
    });
  } catch (error) {
    if (reserved) await refundRateLimit(userId);
    throw error;
  }
}
