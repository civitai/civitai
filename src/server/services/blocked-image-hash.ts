import { env } from '~/env/server';
import { clickhouse } from '~/server/clickhouse/client';
import { withRetries } from '~/utils/errorHandling';

/** Whether a perceptual hash is on the live blocklist, near matches included. */
export async function getIsImageBlocked(hash: bigint) {
  if (!env.BLOCKED_IMAGE_HASH_CHECK || !clickhouse) return false;

  const client = clickhouse;
  // $query has no retry of its own, and the observed failure is a dropped socket.
  const rows = await withRetries(
    () => client.$query<{ count: number }>`
      SELECT cast(count() as int) as count
      FROM blocked_images
      WHERE bitCount(bitXor(hash, ${hash})) < 5 AND disabled = false
    `,
    2,
    250
  );

  return (rows?.[0]?.count ?? 0) > 0;
}
