import { isIP } from 'net';
import type { NextApiRequest } from 'next';
import requestIp from 'request-ip';

/**
 * THE single client-IP predicate for anything that keys a per-client control
 * (rate-limit buckets, per-IP quotas) on the caller's address.
 *
 * PREFER Cloudflare's `CF-Connecting-IP` (Next lowercases header keys →
 * `cf-connecting-ip`). CF stamps it at the edge on every proxied request, so for
 * traffic that transits Cloudflare — which is all of production — it is the one
 * address in the request the origin did not take on the caller's word. Fall back
 * to `requestIp.getClientIp` (XFF chain → socket peer) for non-CF / local
 * requests that never traversed the edge, so dev and direct-to-origin traffic
 * still bucket sensibly.
 *
 * WHY A SHARED PREDICATE: a bucket key is only as good as the value it is
 * derived from, and a per-call-site derivation drifts — each new limiter picks
 * whichever header its author reached for first, and the resulting disagreement
 * is invisible until someone audits all of them at once. Keeping ONE exported
 * function means the choice is made in one reviewable place and every keyed
 * control inherits it. If you are adding a limiter, call this rather than
 * reading headers yourself; `src/server/utils/__tests__/client-ip-ledger.test.ts`
 * pins the (small) set of modules allowed a direct `request-ip` dependency and
 * will fail if a new one appears.
 *
 * NOT THE ONLY PREDICATE — CHOOSE PER SURFACE. A stricter, fail-closed variant
 * lives with the token-minting endpoint in `src/pages/api/v1/block-tokens/`.
 * The two differ deliberately in what they are willing to trust and in what they
 * hand back, because a credential-minting endpoint and a generic rate limiter do
 * not want the same trade — strictness is not free in either direction. Pick the
 * one that matches the surface you are on; do not reach for either by default,
 * and do not collapse them into one without re-deciding the trade for both.
 *
 * WHAT THE RETURN VALUE IS: a BARE, well-formed IPv4/IPv6 address, or the
 * literal `'unknown'` when the request carries no resolvable address at all.
 * Both branches validate against the same grammar — see `isBareAddress` — so the
 * value is bounded in length and in content. That is load-bearing wherever this
 * is used as a key: an unbounded key space is unbounded storage, and a caller
 * able to vary the key at will can rotate away from its own bucket. Callers must
 * still NAMESPACE their keys — see `middleware.trpc.ts` — because a key space
 * shared between two namespaces is only disjoint by luck.
 *
 * Note `'unknown'` is a SHARED bucket for every caller that lands on it, so it
 * is deliberately a single fixed label rather than something per-request: an
 * unresolvable caller must not be able to mint itself a fresh empty quota.
 */

/**
 * The longest textual IP address: the fully-expanded IPv4-mapped IPv6 form,
 * `0000:0000:0000:0000:0000:ffff:255.255.255.255`.
 */
const MAX_TEXTUAL_ADDRESS_LENGTH = 45;

/**
 * A BARE address — a well-formed IPv4/IPv6 address with no IPv6 zone identifier,
 * no longer than the grammar permits.
 *
 * `net.isIP` on its own is NOT this check, and the difference matters. It accepts
 * a zone-scoped address (`fe80::1%eth0`) and bounds neither the zone part's
 * length nor its contents, while the `request-ip` fallback's own `is.ip()`
 * rejects exactly those values — so a validator resting on `isIP` alone lets the
 * two branches of `resolveClientIp` disagree about what counts as an address,
 * and lets an arbitrary-length caller-supplied suffix through the accepting one.
 *
 * Measured across both families, the zone suffix is the ENTIRE disagreement
 * between the two validators: every value they score differently contains a `%`.
 * Excluding it is therefore what makes the two branches agree.
 *
 * ON THE LENGTH BOUND — it is DEFENCE IN DEPTH, not the working check, and the
 * distinction is recorded so nobody mistakes it for load-bearing. Once `%` is
 * excluded, `isIP` cannot accept anything longer than the grammar's own maximum
 * anyway: probing ~1.4M `%`-free strings of length 46-80, plus every maximal
 * canonical form, produced ZERO acceptances above 45. So deleting this line is a
 * provably EQUIVALENT mutation — no input can distinguish it, and the mutation
 * battery reports it as a survivor for that reason rather than for want of a
 * test. It is kept as a bound that still holds if `isIP`'s accepted grammar ever
 * widens. Its VALUE is pinned: tightening it below 45 fails the longest-legal-
 * address control in `src/server/utils/__tests__/client-ip.test.ts`.
 *
 * That file also pins the zone rejection in content and in length, with controls
 * proving the bare address is still accepted.
 */
function isBareAddress(value: string): boolean {
  if (value.length > MAX_TEXTUAL_ADDRESS_LENGTH) return false;
  if (value.includes('%')) return false;
  return isIP(value) !== 0;
}

export function resolveClientIp(req: NextApiRequest): string {
  // `req.headers` is optional-chained rather than assumed. This is reached from
  // middleware with no try/catch, and at least one call path supplies `req`
  // through an `as any` (`server-side-helpers.ts`), so the type is not the
  // guarantee it looks like. `requestIp.getClientIp` already guards its own
  // access the same way.
  const cfip = req.headers?.['cf-connecting-ip'];
  const cf = Array.isArray(cfip) ? cfip[0] : cfip;
  const candidate = cf?.trim();
  // Validate rather than pass through: an unvalidated edge header is a
  // caller-controlled string, and every consumer of this uses the result as a
  // key. A header that does not validate falls through to the fallback, which
  // yields a real address rather than the value that was presented.
  if (candidate && isBareAddress(candidate)) return candidate;
  return requestIp.getClientIp(req) ?? 'unknown';
}
