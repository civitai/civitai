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
 * This helper validates its input before the value reaches the query text, and
 * that validation is load-bearing rather than defensive tidiness: it is the
 * property that makes the interpolation below safe to write. Both accepted
 * shapes are closed character sets — an integer and an IP address contain
 * nothing that could terminate a string literal or introduce a clause — so a
 * key that has passed this check contributes no syntax to the statement.
 *
 * A key matching neither shape is a broken invariant upstream and THROWS rather
 * than silently returning 0 — the caller (`createLimiter.hasExceededLimit`)
 * already has a logged fail-open around this call, so throwing surfaces the
 * fault instead of quietly disabling the limit.
 *
 * Keep the validation adjacent to the interpolation. If this function ever
 * grows a second query or a third key shape, validate the new one here too
 * rather than at the call site: the guarantee above is a property of this
 * function, and it is only true while every value placed into the text below
 * has been through it.
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
