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
 * the caller passed in — for an anonymous download, the enforcement derivation
 * `getTrustedClientIp` — while the `ip` column was written from the tracker's
 * own, which is a DIFFERENT PREDICATE, not a different rendering of the same
 * one. The two consult different inputs and can therefore name different
 * addresses for one request.
 *
 * 🔴 Note what that rules out: this is NOT a spelling mismatch, and normalising
 * the text on either side does not close it. Wherever the two predicates
 * disagree about which address a request came from, the `ip =` filter matches
 * nothing however either value is written. Before these controls shared one
 * predicate the two sides were the same call and equality held by construction;
 * now it holds only where the two derivations agree, and the count seeds 0
 * instead of the true 24h figure everywhere else.
 *
 * The direction is permissive — an under-count relaxes a limit, it does not
 * block anyone.
 *
 * ── HOW FAR THE WRITE SIDE MOVING NARROWED IT: NARROWED, NOT CLOSED ───────
 *
 * The tracker no longer derives its address from the library resolver; it now
 * calls the shared attribution predicate. That removes the largest class of
 * disagreement — a request that DID transit the edge, where the two sides
 * previously had no reason to settle on the same hop. Both sides now start from
 * the edge-attested address for such a request.
 *
 * 🔴 It does NOT close, and the two remaining classes are stated so nobody
 * upgrades this to "fixed":
 *
 *   1. NORMALISATION. This side is compared against a NORMALIZED address
 *      (`getTrustedClientIp` folds its result); the write side stores the
 *      derived text as-is. For IPv4 the two coincide. For IPv6 they coincide
 *      only while the address is already in canonical form — one address has
 *      several legal spellings, and the filter is exact string equality.
 *   2. REQUESTS THAT DID NOT TRANSIT THE EDGE. The two predicates fall back
 *      differently by design: the enforcement one drops to the transport peer,
 *      the attribution one does not. That difference is deliberate — it is the
 *      whole reason there are two — so it cannot be "fixed" here without
 *      re-deciding the trade for the surface that depends on it.
 *
 * So the gap is narrower and still real. Closing it entirely would mean one of
 * the two surfaces adopting the other's trade, which is a product decision
 * about the download quota, not a refactor. What is pinned meanwhile is the
 * half this module controls: `download-quota-seam.test.ts` asserts that the
 * value used for the lookup is the one the trusted derivation produced, so a
 * future change to either side has something to trip over.
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
