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
 * key that has passed this check contributes no syntax to the statement. The
 * address branch is LENGTH-bounded too, but only because `isIpAddress` refuses
 * an IPv6 zone id: that suffix is the one construct `net.isIP` accepts at
 * unbounded length, and without the refusal an accepted key could be arbitrarily
 * long. If that refusal is ever relaxed, this sentence stops being true.
 *
 * A key matching neither shape is a broken invariant upstream and THROWS rather
 * than silently returning 0 — the caller (`createLimiter.hasExceededLimit`)
 * already has a logged fail-open around this call, so throwing surfaces the
 * fault instead of quietly disabling the limit.
 *
 * ── THE WRITE SIDE USES A DIFFERENT DERIVATION ────────────────────────────
 *
 * The count read here was written by the download tracker, and the two sides
 * arrive at their address INDEPENDENTLY. The value looked up here is whatever
 * the caller passed in — for an anonymous download that is `getTrustedClientIp`,
 * which trims and folds an IPv4-mapped IPv6 to its dotted quad — while the `ip`
 * column was written from the tracker's own derivation, which applies neither.
 * Before these controls shared one predicate the two sides were the same call
 * and equality held by construction; now it holds only where the two spellings
 * of an address coincide. Where they do not, the `ip =` filter matches nothing
 * and the count seeds 0 instead of the true 24h figure.
 *
 * The direction is permissive — an under-count relaxes a limit, it does not
 * block anyone — and closing it means changing the WRITE side, which is a wider
 * blast radius than this module. What is pinned instead is the half this module
 * controls: `download-quota-seam.test.ts` asserts that the value used for the
 * lookup is the normalized one, so a future change to either side has something
 * to trip over.
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
