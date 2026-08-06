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
 * │ Two things a mechanical union gets WRONG and a reviewer has to do by    │
 * │ hand:                                                                  │
 * │                                                                        │
 * │  1. Both sides import `isIP`, from DIFFERENT specifiers — this file     │
 * │     uses `node:net`, #3658 uses `net`. Keeping both lines is a          │
 * │     duplicate identifier (TS2300). Keep the `node:net` line and drop    │
 * │     the other: `net` is the only builtin this repo imports with a       │
 * │     single spelling — 3 of 3 occurrences are `node:net`, none bare.     │
 * │                                                                        │
 * │  2. Delete #3658's paragraph beginning "SCOPE / KNOWN LIMIT — read      │
 * │     before extending this:" — the one whose last sentences say the      │
 * │     stricter variant "lives with the token-minting endpoint in          │
 * │     src/pages/api/v1/block-tokens/" and is "deliberately NOT shared     │
 * │     here". After the union it IS shared: it is `getTrustedClientIp`,    │
 * │     a few dozen lines below, and block-tokens now calls it. The         │
 * │     paragraph survives a keep-both merge intact and is false the        │
 * │     moment that merge lands, so removing it is not optional.            │
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
 *     also present. Cloudflare stamps `cf-ray` on every request it proxies, so
 *     requiring the pair is what stops an unaccompanied `cf-connecting-ip` —
 *     a header carrying no corroboration whatsoever — from being read as an
 *     edge attestation. It is a corroboration requirement, not a proof of
 *     origin; the second source below is what the derivation falls back on.
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
 * connection peer rather than to a self-declared address. Wherever that peer is
 * a shared hop, this collapses ALL such traffic into ONE bucket.
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
 * So: this predicate is the right key for the download blocklists. Keying a
 * per-client QUOTA on it is sound only where the collapsed bucket carries no
 * threshold — see the call-site note in
 * `src/pages/api/download/models/[modelVersionId].ts`. Do not generalise the
 * blocklist's safety argument onto a counting surface.
 *
 * ── CHOOSING BETWEEN THE TWO PREDICATES IN THIS FILE ──────────────────────
 *
 * They differ in TRUST, and the weaker one is the one with the friendlier name,
 * so read the return type — it is the tell:
 *
 *   `resolveClientIp(req): string`         ← ALWAYS returns something: an opaque
 *                           bucket LABEL for ATTRIBUTION, not a validated
 *                           address. Its job is to keep distinct callers in
 *                           distinct rate-limit buckets across many procedures,
 *                           so that non-edge callers (internal services, dev) do
 *                           not 429 each other. It is not an input to an
 *                           allow/deny decision.
 *
 *   `getTrustedClientIp(req): string | null` ← returns a VALIDATED address, or
 *                           `null` when provenance could not be established.
 *                           Every non-null value is edge-attested or observed
 *                           off the socket, and is a syntactically valid
 *                           address. This is the one to use for an ENFORCEMENT
 *                           decision — a blocklist, or a quota that is itself
 *                           the control — and its `null` must be handled.
 *
 * If you are writing a check whose outcome is a 403, a 429, or anything else a
 * caller would want to change, you want `getTrustedClientIp`. A `string`
 * arriving where you expected a trusted address type-checks silently, so the
 * compiler will not catch reaching for the wrong one — this paragraph is the
 * only guard there is.
 *
 * The distinction is the SURFACE, not a disagreement about which is better. A
 * limiter spanning many procedures and a blocklist guarding four download routes
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
 * True when `value` is a syntactically valid IPv4 or IPv6 address, WITHOUT a
 * zone identifier.
 *
 * Backed by node's `net.isIP`, so it is the same parser the runtime uses —
 * minus one thing that parser accepts and no consumer here wants: an IPv6
 * scoped-address zone id (`fe80::1%eth0`). `net.isIP` returns 6 for those and
 * places NO LENGTH LIMIT on the zone id; measured on node 26,
 * `'fe80::1%' + 'a'.repeat(1e6)` is accepted and comes back verbatim.
 *
 * That matters because a zone id is meaningful only on the host that owns the
 * interface — it is never part of a remote peer's identity — while every
 * consumer of this predicate uses the returned string AS an identity: a
 * blocklist comparand, a rate-limit bucket key, and a value interpolated into a
 * ClickHouse query. An unbounded, freely-varying suffix on any of those is a key
 * space nobody bounded: it mints unlimited distinct bucket keys, and it can
 * never equal an address an operator typed into a list.
 *
 * The zone id is also the ONLY construct that makes an accepted value
 * unbounded, so rejecting it is what bounds the result. With no `%`, the longest
 * text `net.isIP` accepts is 45 characters
 * (`0000:0000:0000:0000:0000:ffff:255.255.255.255`). The zone id's own grammar
 * is narrow — measured, `[-.0-9:A-Za-z]` only, so it can carry no quote,
 * whitespace or NUL — which is why this is a key-space and identity problem
 * rather than an injection one.
 *
 * This is the validation every consumer of a client IP should apply before the
 * value is allowed to reach a query, a cache key, or a comparison — see
 * `fetchDownloadCount` for a call site that depends on it.
 */
export function isIpAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // Reject a scoped address outright. Cheaper and clearer than parsing the zone
  // off, and there is no consumer here that wants one.
  if (value.includes('%')) return false;
  return isIP(value) !== 0;
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
 * Split a comma-separated operator-maintained `KeyValue` list into entries.
 *
 * Entries are TRIMMED, and blanks dropped. This is not tidiness: the comparison
 * these entries feed is exact string equality, so an entry stored as
 * `1.2.3.4, 5.6.7.8` yields a second entry of `" 5.6.7.8"` that can never equal
 * any value it is compared against. The control silently covers one fewer entry
 * than the operator believes it does, with nothing anywhere reporting a problem.
 * Writing a list with spaces after the commas is the obvious way to write one.
 *
 * ── FAIL DIRECTION ────────────────────────────────────────────────────────
 *
 * `KeyValue.value` is a `Json` column, so a non-string is representable. This
 * THROWS on one rather than reading it as an empty list, and the asymmetry is
 * the whole reason: every caller of this helper is an enforcement control, so
 * `[]` is indistinguishable at the call site from a genuinely empty list. A
 * control that switches ITSELF off is the one failure mode nothing downstream
 * can detect — the requests it should have stopped simply succeed, and look
 * exactly like requests it was never meant to stop.
 *
 * Throwing surfaces a malformed row as a 5xx, which the endpoint wrappers
 * already count (`instrumentApiResponse`) and, on the routes that wrap this in a
 * try, log to Axiom. It is also what these routes did before the splitter was
 * shared — the inline `(value ?? '').split(',')` threw a `TypeError` on a
 * non-string — so a malformed row still fails the way it always has, and this
 * PR is not the thing that changed it.
 *
 * An ABSENT row (`null`/`undefined`) is the ordinary "no list configured" state,
 * not a malformed one, and yields no entries without complaint.
 *
 * @param key the `KeyValue` key, named in the error so the row is identifiable.
 */
function parseKeyValueList(value: unknown, key: string): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'string') {
    throw new TypeError(
      `KeyValue '${key}' is not a string (got ${typeof value}); refusing to evaluate this list.`
    );
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Split the operator-maintained `ip-blacklist` row into address entries.
 *
 * 🔴 OPERATOR HAZARD, stated here because this is the function that reads the
 * list: the addresses this list is compared against come from
 * `getTrustedClientIp`, which attributes every request that did NOT transit the
 * Cloudflare edge to the transport peer. Where that peer is a shared hop, its
 * address stands for many callers at once — so listing it 403s all of them on
 * every download route, rather than one abuser. No caller can cause an address
 * to be listed, so this is a footgun rather than an exposure; but if a download
 * blocklist entry ever appears to have blocked far more than intended, this is
 * the first thing to check.
 */
export function parseIpBlocklist(value: unknown): string[] {
  return parseKeyValueList(value, 'ip-blacklist');
}

/**
 * Split the operator-maintained `user-blacklist` row into user-id entries.
 *
 * Same splitter, different list: these are user ids compared against
 * `session.user.id.toString()`, not addresses, so they get their own name
 * rather than being pushed through `parseIpBlocklist`.
 *
 * The invariant is the same one the address list needs: the comparison is exact
 * string equality, so every entry must be trimmed. An entry that keeps a leading
 * space can never equal an id, and a list that does not match looks exactly like
 * a caller who is not on it.
 */
export function parseUserBlocklist(value: unknown): string[] {
  return parseKeyValueList(value, 'user-blacklist');
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
