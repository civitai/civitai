import { REDIS_KEYS } from '~/server/redis/client';
import { acquireConcurrencySlot } from '~/server/utils/concurrency-slots';

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
 */
export async function acquireBlockPollHoldSlot(
  blockInstanceId: string,
  userId: number,
  limit: number
): Promise<ReleaseBlockPollHoldSlot | null> {
  const key = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:poll-hold:${blockInstanceId}:${userId}`;
  const slot = await acquireConcurrencySlot(key, limit, BLOCK_POLL_HOLD_SLOT_TTL_MS);
  return slot.acquired ? slot.release : null;
}
