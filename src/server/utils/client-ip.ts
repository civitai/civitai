import { isIP } from 'node:net';

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ MERGE NOTE — this module is created concurrently by two PRs.            │
 * │ #3658 adds `resolveClientIp` here (moved out of public-api-rate-limit); │
 * │ this PR adds `getTrustedClientIp` + `isIpAddress`. They are DIFFERENT   │
 * │ predicates for DIFFERENT surfaces and both are wanted — resolve the     │
 * │ add/add conflict by KEEPING BOTH, not by picking one. See               │
 * │ "Choosing between the two" below.                                      │
 * │                                                                        │
 * │ WHICHEVER PR LANDS SECOND also has to fix one paragraph: #3658's copy   │
 * │ of this doc says the stricter variant "lives at                         │
 * │ src/pages/api/v1/block-tokens/index.ts … deliberately not shared here". │
 * │ After the union merge it IS shared — it is `getTrustedClientIp`, a few  │
 * │ dozen lines below. Delete that paragraph rather than merging it in.     │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Client-IP derivation for ENFORCEMENT controls (abuse blocklists, per-client
 * quotas).
 *
 * A control that keys on a client IP is only as strong as the provenance of
 * that IP. This predicate derives it from the two sources the origin can
 * attest:
 *
 *  1. The Cloudflare edge — `cf-connecting-ip`, accepted ONLY when `cf-ray` is
 *     also present. Cloudflare stamps `cf-ray` on every request it proxies and
 *     its value identifies a specific edge datacenter request, so its presence
 *     is what establishes that the pair actually came from the edge rather than
 *     from the caller.
 *  2. The transport peer — `req.socket.remoteAddress`, which is observed from
 *     the connection itself and is not part of the request the caller composes.
 *
 * Nothing else is consulted. Any other forwarding header is, by definition, a
 * value chosen by whoever composed the request, and a control keyed on such a
 * value can be re-pointed at will by the party it is meant to constrain.
 *
 * ── THE TRADE, AND WHY ITS COST IS NOT THE SAME ON EVERY SURFACE ──────────
 *
 * Traffic that reaches the origin without edge transit is attributed to the
 * connection peer (in this deployment, the load balancer) rather than to a
 * self-declared address. That collapses ALL such traffic into ONE bucket.
 *
 * It is tempting to summarise this as "over-attributing is the safe direction".
 * That is true of a BLOCKLIST and false of a QUOTA, and the difference decides
 * whether a given control may be keyed on this value:
 *
 *   BLOCKLIST (a set-membership test).  The collapsed value is compared against
 *   a list an operator curates. Over-attribution costs nothing unless the
 *   collapsed address is itself listed, and it is a value an operator would
 *   never deliberately list. The failure is bounded by, and visible in, the
 *   list. Safe. See `parseIpBlocklist` for the one hazard this does create.
 *
 *   QUOTA (a counter with a threshold).  The collapsed value is not compared to
 *   anything — it is ACCUMULATED. Every non-edge anonymous caller increments the
 *   same counter, so the threshold is reached by the aggregate volume of
 *   unrelated callers rather than by any one caller's behaviour. Once it trips,
 *   it trips for all of them at once. Over-attribution here is not a conservative
 *   default; it converts a per-client limit into a shared one, and the people who
 *   feel it are the ones the limit was never aimed at.
 *
 * So: this predicate is the right key for the download blocklists. It is the
 * right key for a download quota ONLY while that quota's anonymous bucket stays
 * unconfigured — see the call-site note in
 * `src/pages/api/download/models/[modelVersionId].ts`. Do not generalise the
 * blocklist's safety argument onto a counting surface.
 *
 * ── CHOOSING BETWEEN THE TWO PREDICATES IN THIS FILE ──────────────────────
 *
 * They differ in TRUST, and the weaker one is the one with the friendlier name,
 * so read the return type — it is the tell:
 *
 *   `resolveClientIp(req): string`         ← ALWAYS returns something.
 *                           NOT a validated IP. An opaque bucket label that may
 *                           be derived from headers the CALLER CHOSE. For RATE
 *                           LIMITERS spanning many procedures, where the point
 *                           is that non-edge callers (internal services, dev)
 *                           keep distinct buckets instead of 429-ing each other.
 *                           Because a caller can influence it, it must never
 *                           decide an ALLOW/DENY outcome.
 *
 *   `getTrustedClientIp(req): string | null` ← Can return `null`, and that
 *                           `null` is the whole point: it is the module
 *                           admitting it could not establish provenance. Every
 *                           returned value is edge-attested or observed off the
 *                           socket, and is a syntactically valid address. For
 *                           ENFORCEMENT controls — a blocklist, or a quota that
 *                           is the control rather than a convenience.
 *
 * If you are writing a check whose outcome is a 403, a 429, or anything else a
 * caller would want to change, you want `getTrustedClientIp` and you must
 * handle its `null`. A `string` arriving where you expected a trusted address
 * type-checks silently, so the compiler will not catch reaching for the wrong
 * one — this paragraph is the only guard there is.
 *
 * The distinction is the SURFACE, not a disagreement about which is better. A
 * limiter guarding ~33 procedures and a blocklist guarding four download routes
 * fail in opposite directions, so they want opposite defaults.
 *
 * Whichever you pick: import it. Do not re-derive a client IP inline at a call
 * site.
 */

type IpSourceRequest = {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string } | null;
};

/**
 * True when `value` is a syntactically valid IPv4 or IPv6 address.
 *
 * Backed by node's `net.isIP`, so it is the same parser the runtime uses. This
 * is the validation every consumer of a client IP should apply before the value
 * is allowed to reach a query, a cache key, or a comparison — see
 * `fetchDownloadCount` for a call site that depends on it.
 */
export function isIpAddress(value: unknown): value is string {
  return typeof value === 'string' && isIP(value) !== 0;
}

/**
 * The single value of a header, trimmed; `undefined` when absent, blank, or
 * REPEATED.
 *
 * A repeated header arrives as an array. This returns `undefined` for that case
 * rather than picking an element, because the two headers read here are an edge
 * ATTESTATION: their meaning depends on Cloudflare having been the one to set
 * them, and a value that arrived more than once is evidence that something other
 * than a single edge hop composed it. Treating it as absent falls through to the
 * transport peer, which is the fail-closed direction and matches the rule the
 * block-tokens resolver applied before it was consolidated here.
 *
 * Node's HTTP server joins duplicate headers into one comma-separated string
 * (`set-cookie` is the only exception), so this branch is not reachable through
 * a Node server today. It is kept, and tested, because the parameter type admits
 * an array and a future non-Node caller could pass one — an unreachable branch
 * that silently picks an element is exactly how the strictness above gets lost.
 */
function headerValue(raw: string | string[] | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * IPv4-mapped IPv6 → dotted quad (`::ffff:203.0.113.7` → `203.0.113.7`).
 *
 * Node reports an IPv4 peer on a dual-stack listener in the mapped form. An
 * operator maintaining a blocklist writes the dotted quad, so without this
 * normalization a socket-derived address would never match a list entry.
 *
 * All three spellings of the mapped form are handled, not just the canonical
 * one Node emits, because the comparison this feeds is string equality: an
 * address that is not folded to the same text as the operator's list entry is
 * an entry that silently never matches. The forms are
 *
 *   `::ffff:1.2.3.4`                   canonical — what Node produces
 *   `0:0:0:0:0:ffff:1.2.3.4`           zero groups written out
 *   `::ffff:0102:0304`                 low 32 bits as hex groups
 *
 * Anything else — including a mapped address written with an unusual `::`
 * placement — is returned unchanged rather than guessed at. This is a
 * best-effort fold toward the canonical text, not an IPv6 canonicaliser.
 */
const IPV4_MAPPED_PREFIX = /^(?:::|(?:0{1,4}:){5})ffff:/i;
const HEX_GROUP_PAIR = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

function normalizeIp(ip: string): string {
  if (isIP(ip) !== 6) return ip;

  const prefix = IPV4_MAPPED_PREFIX.exec(ip);
  if (!prefix) return ip;
  const tail = ip.slice(prefix[0].length);

  // `::ffff:1.2.3.4` — the low 32 bits already written as a dotted quad.
  if (isIP(tail) === 4) return tail;

  // `::ffff:0102:0304` — the same 32 bits as two hex groups.
  const hex = HEX_GROUP_PAIR.exec(tail);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    const dotted = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    if (isIP(dotted) === 4) return dotted;
  }

  return ip;
}

/**
 * Split a comma-separated operator-maintained IP list (the `ip-blacklist` /
 * `user-blacklist` key-value rows) into entries.
 *
 * Entries are TRIMMED, and blanks dropped. This is not tidiness: the comparison
 * these entries feed is exact string equality, so an entry stored as
 * `1.2.3.4, 5.6.7.8` yields a second entry of `" 5.6.7.8"` that can never equal
 * any address this module produces. The control silently covers one fewer
 * address than the operator believes it does, with nothing anywhere reporting a
 * problem. Writing a list with spaces after the commas is the obvious way to
 * write one.
 *
 * 🔴 OPERATOR HAZARD, stated here because this is the function that reads the
 * list: the addresses this list is compared against come from
 * `getTrustedClientIp`, which attributes every request that did NOT transit the
 * Cloudflare edge to the transport peer — the load balancer. Adding that
 * address to `ip-blacklist` therefore 403s ALL non-edge traffic to every
 * download route at once, not one abuser. It is not an address any abuser can
 * cause to be listed, so this is a footgun rather than an exposure; but if a
 * download blocklist entry ever appears to have blocked far more than intended,
 * this is the first thing to check.
 */
export function parseIpBlocklist(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolve the client IP for a security control.
 *
 * Returns `null` when neither source yields a valid address — callers must
 * treat that as "unknown", never as a match. Both candidates are validated
 * before they are returned, so a caller never receives a value that merely
 * looked like an address.
 */
export function getTrustedClientIp(req: IpSourceRequest): string | null {
  const headers = req.headers ?? {};

  // Edge-attested: cf-connecting-ip is meaningful only alongside cf-ray.
  const cfRay = headerValue(headers['cf-ray']);
  if (cfRay) {
    const cfIp = headerValue(headers['cf-connecting-ip']);
    if (isIpAddress(cfIp)) return normalizeIp(cfIp);
  }

  // Transport peer.
  const socketIp = req.socket?.remoteAddress?.trim();
  if (isIpAddress(socketIp)) return normalizeIp(socketIp);

  return null;
}
