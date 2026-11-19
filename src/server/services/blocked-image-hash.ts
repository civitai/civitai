import { env } from '~/env/server';
import { clickhouse } from '~/server/clickhouse/client';
import { withRetries } from '~/utils/errorHandling';

/**
 * A blocklist store call failed. Only the driver error's class and code are kept: its message can
 * quote the statement, hashes included (`$query` appends the whole query), and callers log it.
 */
export class BlocklistStoreError extends Error {
  readonly code: unknown;
  constructor(failure: unknown) {
    const code = (failure as { code?: unknown })?.code;
    super('blocked_images: the blocklist call failed', {
      cause: { name: (failure as Error)?.name, code },
    });
    this.name = 'BlocklistStoreError';
    this.code = code;
  }
}

/** Runs one blocklist store call, rethrowing its failure as a BlocklistStoreError. */
export async function blocklistCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new BlocklistStoreError(error);
  }
}

/** Whether the live blocklist can be read here; without it every hash reads as not blocked. */
export function canCheckBlockedImageHash() {
  return !!env.BLOCKED_IMAGE_HASH_CHECK && !!clickhouse;
}

/** Whether a perceptual hash is on the live blocklist, near matches included. */
export async function getIsImageBlocked(hash: bigint) {
  if (!env.BLOCKED_IMAGE_HASH_CHECK || !clickhouse) return false;

  const client = clickhouse;
  // $query has no retry of its own, and the observed failure is a dropped socket.
  const rows = await blocklistCall(() =>
    withRetries(
      () => client.$query<{ count: number }>`
        SELECT cast(count() as int) as count
        FROM blocked_images
        WHERE bitCount(bitXor(hash, ${hash})) < 5 AND disabled = false
      `,
      2,
      250
    )
  );

  return (rows?.[0]?.count ?? 0) > 0;
}
