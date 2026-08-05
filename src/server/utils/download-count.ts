import { clickhouse } from '~/server/clickhouse/client';
import { isIpAddress } from '~/server/utils/client-ip';

/**
 * Rolling 24h Download count for a rate-limiter key, read from ClickHouse.
 *
 * The key is a union: either a numeric user id (authenticated caller) or a
 * client IP (anonymous caller). Which column to filter on is decided by
 * VALIDATING the key against the two shapes it is allowed to have, not by
 * sniffing for a character:
 *
 *   - `^\d+$`      → an integer id, filtered on `userId`
 *   - `net.isIP`   → an address, filtered on `ip`
 *
 * `clickhouse.$query` is a plain template-concatenating tagged template — it
 * performs NO parameter binding (see `packages/civitai-clickhouse/src/client.ts`),
 * so every value in the query text is there literally. Validating to these two
 * shapes is therefore load-bearing, not defensive tidiness: an integer and an
 * IP address are both closed character sets that cannot terminate a string
 * literal or introduce a clause. A key matching neither shape is a broken
 * invariant upstream and THROWS rather than silently returning 0 — the caller
 * (`createLimiter.hasExceededLimit`) already has a logged fail-open around this
 * call, so throwing surfaces the fault instead of quietly disabling the limit.
 *
 * NOT converted to bound `query_params`: the deployed column type for `ip` is
 * not declared in this repo, so a typed parameter risks a ClickHouse type
 * mismatch whose only symptom is this limiter failing open. Shape validation
 * gives the same guarantee with no change to the emitted query.
 */
export async function fetchDownloadCount(userKey: string): Promise<number> {
  if (!clickhouse) return 0;

  const isUserId = /^\d+$/.test(userKey);
  if (!isUserId && !isIpAddress(userKey)) {
    throw new Error('fetchDownloadCount: rate-limit key is neither a user id nor an IP address');
  }

  const data = await clickhouse.$query<{ count: number }>`
      SELECT
        COUNT(*) as count
      FROM modelVersionEvents
      WHERE type = 'Download' AND time > subtractHours(now(), 24)
      ${isUserId ? `AND userId = ${userKey}` : `AND ip = '${userKey}'`}
    `;

  return data[0]?.count ?? 0;
}
