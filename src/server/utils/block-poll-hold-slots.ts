import { randomUUID } from 'crypto';
import { redis, REDIS_KEYS } from '~/server/redis/client';

/**
 * How long one hold slot can outlive its request. A held read is aborted by `getWorkflow`'s 20 s
 * backstop, so a live slot is released well inside this; the margin only matters for a process that
 * died mid-hold, whose entry then stops counting by itself.
 */
export const BLOCK_POLL_HOLD_SLOT_TTL_MS = 25_000;

export type ReleaseBlockPollHoldSlot = () => Promise<void>;

/**
 * Take one of `limit` concurrent long-poll slots for an (install, viewer), keyed like the `:poll:`
 * rate bucket. Returns the release, or `null` when the caller must NOT hold: over the limit, or the
 * store failed. `null` means "answer without a hold", never "refuse the poll".
 *
 * A sorted set whose scores are each slot's own expiry, not a counter: a counter's leaked increment
 * from a dead process lives until the whole key goes idle, which a busy key never does, while an
 * expired entry is dropped on the next acquire. The steps are not atomic; two racing acquirers at
 * the limit can both see the other and both get `null`, so a race over-refuses but never admits
 * more than `limit`.
 */
export async function acquireBlockPollHoldSlot(
  blockInstanceId: string,
  userId: number,
  limit: number
): Promise<ReleaseBlockPollHoldSlot | null> {
  const key = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:poll-hold:${blockInstanceId}:${userId}`;
  const member = randomUUID();
  const release: ReleaseBlockPollHoldSlot = async () => {
    try {
      await redis.zRem(key as never, member);
    } catch {
      // the entry expires on its own
    }
  };
  try {
    const now = Date.now();
    await redis.zRemRangeByScore(key as never, '-inf', now);
    await redis.zAdd(key as never, { score: now + BLOCK_POLL_HOLD_SLOT_TTL_MS, value: member });
    await redis.expire(key as never, Math.ceil(BLOCK_POLL_HOLD_SLOT_TTL_MS / 1000));
    const held = await redis.zCard(key as never);
    if (typeof held === 'number' && Number.isFinite(held) && held <= limit) return release;
  } catch {
    // fall through: fail open to no hold, never to an unbounded one
  }
  await release();
  return null;
}
