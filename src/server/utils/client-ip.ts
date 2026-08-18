import { isIP } from 'net';
import type { NextApiRequest } from 'next';
import requestIp from 'request-ip';

/**
 * TWO PREDICATES IN ONE FILE — the record of a resolved add/add merge.
 *
 * #3658 and #3659 each created this module, independently, for different
 * surfaces. The conflict was resolved as a UNION, because neither predicate
 * replaces the other:
 *
 *   `resolveClientIp`     an attribution LABEL for rate-limit buckets
 *   `getTrustedClientIp`  a validated address for an ENFORCEMENT decision
 *
 * The section "CHOOSING BETWEEN THE TWO PREDICATES IN THIS FILE" further down
 * is how to pick between them, and the return type is the tell. Three things
 * the union settled by hand, recorded here so they are not re-litigated:
 *
 *  1. IMPORT SPECIFIER. Both sides imported `isIP`; keeping both lines would be
 *     a duplicate identifier (TS2300), so one spelling had to win. This file
 *     uses the bare `net`, which is what the merged-in side already had — the
 *     smallest possible edit in a file where the boring resolution is the right
 *     one. The repo is NOT actually consistent on this: measured at the merge
 *     base, the other `src/` imports of this builtin spell it `node:net`, so
 *     the count runs the other way. The choice is inert — both specifiers
 *     resolve to the same builtin — and normalising the repo on one spelling
 *     belongs with the follow-up in (3), not in a conflict resolution.
 *
 *  2. The "NOT THE ONLY PREDICATE — CHOOSE PER SURFACE" paragraph below used to
 *     say the stricter variant lived with the token-minting endpoint. After the
 *     union it does not live there: it is `getTrustedClientIp` in this file,
 *     and that endpoint calls it. The paragraph's POINT — two predicates,
 *     choose per surface, they differ deliberately — survives untouched, so it
 *     was repointed rather than deleted.
 *
 *  3. DUPLICATED VALIDATION — NOW RESOLVED. The merge left `isBareAddress` and
 *     `isIpAddress` in place as two independent copies of one rule, agreeing by
 *     convention and held together by a test rather than by structure. That
 *     follow-up has happened: there is now exactly ONE predicate that decides
 *     what an address is, `isIpAddress`, and `resolveClientIp` calls it. The
 *     lockstep notes the two carried are gone with the duplication, because a
 *     rule with one implementation cannot drift from itself.
 *
 *     The two DERIVATIONS below (`resolveClientIp`, `getTrustedClientIp`) are a
 *     different thing and remain two, deliberately — they differ in what they
 *     are willing to trust, which is a real distinction, whereas the two
 *     validators differed in nothing.
 */

/**
 * THE single client-IP predicate for anything that keys a per-client control
 * (rate-limit buckets, per-IP quotas) on the caller's address.
 *
 * PREFER Cloudflare's `CF-Connecting-IP` (Next lowercases header keys →
 * `cf-connecting-ip`). CF stamps it at the edge on every proxied request, so for
 * traffic that transits Cloudflare it is the one address in the request the
 * origin did not take on the caller's word. Fall back
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
 * NOT THE ONLY PREDICATE — CHOOSE PER SURFACE. The stricter, fail-closed
 * variant is `getTrustedClientIp`, further down THIS file. It used to live with
 * the token-minting endpoint in `src/pages/api/v1/block-tokens/`; that endpoint
 * now calls the shared one, so the strict predicate is no longer over there —
 * only this pointer changed, the choice it describes did not. The two differ
 * deliberately in what they are willing to trust and in what they hand back,
 * because an enforcement decision and a generic rate limiter do not want the
 * same trade — strictness is not free in either direction. Pick the one that
 * matches the surface you are on; do not reach for either by default, and do
 * not collapse them into one without re-deciding the trade for both. The
 * section "CHOOSING BETWEEN THE TWO PREDICATES IN THIS FILE" below is the long
 * form of that choice.
 *
 * WHAT THE RETURN VALUE IS: a BARE, well-formed IPv4/IPv6 address, or the
 * literal `'unknown'` when the request carries no resolvable address at all.
 * Both branches validate against the same grammar — see `isIpAddress`, the one
 * predicate in this module — so the value is bounded in length and in content. That is load-bearing wherever this
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

export function resolveClientIp(req: NextApiRequest): string {
  // `req.headers` is optional-chained rather than assumed. This is reached from
  // middleware with no try/catch, and at least one call path supplies `req`
  // through an `as any` (`server-side-helpers.ts`), so the type is not the
  // guarantee it looks like. `requestIp.getClientIp` already guards its own
  // access the same way.
  const cfip = req.headers?.['cf-connecting-ip'];
  const cf = Array.isArray(cfip) ? cfip[0] : cfip;
  const candidate = cf?.trim();
  // Validate rather than pass through: every consumer of this uses the result as
  // a key, so a value that does not validate falls through to the fallback,
  // which yields a real address rather than the string that was presented.
  //
  // This is `isIpAddress` — THE one predicate in this module that decides what
  // an address is. It used to be a private near-copy of it (`isBareAddress`);
  // the two were folded together because two implementations of one rule can
  // only ever agree by convention, and neither failed when the other changed.
  if (isIpAddress(candidate)) return candidate;
  return requestIp.getClientIp(req) ?? UNRESOLVED_CLIENT_IP;
}

/**
 * The label `resolveClientIp` returns when no address resolves at all.
 *
 * Exported so a caller can RECOGNISE it rather than string-matching `'unknown'`
 * at the call site. It is not a valid address under `isIpAddress`, and the
 * library fallback cannot produce it either, so it is unambiguous: a value equal
 * to this came from the unresolvable branch and from nowhere else.
 */
export const UNRESOLVED_CLIENT_IP = 'unknown';

/**
 * `resolveClientIp` for surfaces whose "no address" sentinel is FALSY rather
 * than the shared label.
 *
 * Same derivation — this is a thin adapter over `resolveClientIp`, not a second
 * opinion about where an address comes from. It exists because the label and the
 * falsy sentinel are not interchangeable at every call site, and the difference
 * is load-bearing in three places that were measured rather than guessed:
 *
 *  - `base.reward.ts` folds `''` (and `::1`) to `undefined` before an address
 *    reaches a buzz-transaction idempotency key. `'unknown'` is not in that
 *    list, so handing it the label would change a key that guards real money.
 *  - The captcha verifier forwards the value to an external verification API as
 *    a remote-address field. A non-address string there is a change to a
 *    payment-gating call whose far side cannot be observed from this repo.
 *  - `buildSearchActor` hashes `ip ?? ''`, and its three call sites must agree
 *    with each other or one caller gets two different actor labels depending on
 *    which entry point served the request.
 *
 * So: surfaces that already treat `'unknown'` as their own sentinel (the
 * ClickHouse tracker, whose `actor.ip` is initialised to exactly that) call
 * `resolveClientIp` directly. Surfaces built around a falsy sentinel call this,
 * and keep the sentinel they already had.
 */
export function resolveClientIpOrNull(req: NextApiRequest): string | null {
  const ip = resolveClientIp(req);
  return ip === UNRESOLVED_CLIENT_IP ? null : ip;
}

/**
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
 * So: this predicate is the right key for the download blocklists. On a
 * COUNTING surface the same value carries the trade above whichever way the
 * threshold is configured, so the design question is settled by giving the
 * surface a key that does not collapse, or by scoping the limit to
 * edge-attested requests — not by reasoning about a redis hash. See the
 * call-site note in `src/pages/api/download/models/[modelVersionId].ts`. Do
 * not generalise the blocklist's safety argument onto a counting surface.
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
 *
 * ── THE ONLY PLACE THAT DECIDES WHAT AN ADDRESS IS ────────────────────────
 *
 * There used to be two of these: this one, and a private `isBareAddress` that
 * `resolveClientIp` called. They applied the same rule to the same grammar and
 * returned the same verdict for every string, so nothing structural held them
 * together — neither failed when the other changed, and a divergence would have
 * been silent at every call site of both. They are now one function, and BOTH
 * derivations in this module call it. Do not reintroduce a second one: if a
 * surface needs a different rule, that is a different question and wants an
 * explicitly different name, not a near-copy of this.
 *
 * Both original signatures are served by this one. `unknown` → type predicate
 * is the wider of the two and narrows for callers that need it
 * (`getTrustedClientIp`, `fetchDownloadCount`); a caller that already holds a
 * `string` (`resolveClientIp`) passes it unchanged. The narrowing is deliberate
 * and is pinned — do not weaken the parameter to `string` to "tidy" it, or the
 * `unknown`-typed call sites silently lose their guard.
 *
 * ON THE LENGTH BOUND — DEFENCE IN DEPTH, not the working check, recorded so
 * nobody mistakes it for load-bearing. Once `%` is excluded, `isIP` cannot
 * accept anything longer than the grammar's own maximum anyway: probing
 * ~1.4M `%`-free strings of length 46-80, plus every maximal canonical form,
 * produced ZERO acceptances above 45 (re-measured on node 22 when the two
 * predicates were folded together — the probe carries a positive control, so
 * the zero is a result and not an unwired harness). So deleting the line is a
 * provably EQUIVALENT mutation: no input can distinguish it, and the mutation
 * battery reports it as a survivor for that reason rather than for want of a
 * test. It is kept as a bound that still holds if `isIP`'s accepted grammar
 * ever widens. Its VALUE is pinned — tightening it below 45 fails the
 * longest-legal-address control in
 * `src/server/utils/__tests__/client-ip.test.ts`.
 *
 * The bound came from `isBareAddress` and was carried onto this predicate by
 * the fold rather than dropped, so the surviving rule is the STRICTER of the
 * two originals on paper and identical to both in behaviour.
 */
export function isIpAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length > MAX_TEXTUAL_ADDRESS_LENGTH) return false;
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
 * The comparison this feeds is string EQUALITY, so an address that is not
 * folded to the same text as the operator's list entry is an entry that
 * silently never matches. That makes the fold a two-part job:
 *
 *  1. CANONICALISE the IPv6 text. One address has many legal spellings —
 *     `2001:0db8::1`, `2001:db8:0:0:0:0:0:1` and `2001:DB8::1` are the same
 *     address as `2001:db8::1`, which is the form node reports off a socket.
 *     The WHATWG URL host parser is a spec IPv6 serialiser and is used as one
 *     here: zero-compression, leading zeroes and case all collapse to one text.
 *  2. FOLD an IPv4-mapped address to its dotted quad. Step 1 rewrites every
 *     mapped spelling to `::ffff:hhhh:hhhh`, so the hex-pair branch below is
 *     what carries it the rest of the way to `1.2.3.4` — the form an operator
 *     writes and node reports for a real IPv4 peer.
 *
 * ⚠️ BOTH SIDES OF THE COMPARISON MUST TAKE THIS PATH. A fold applied only to
 * the derived address makes the two sides MORE likely to disagree, not less:
 * the derived value moves to the canonical text and a list entry written any
 * other way stops matching an address it used to match. `parseIpBlocklist`
 * therefore runs its entries through this same function. Pinned by the
 * spelling-variant cases in
 * `src/server/utils/__tests__/client-ip-trusted.test.ts`.
 *
 * Every transformation here is identity-preserving — it changes the SPELLING of
 * an address and never which address it denotes — so folding cannot make one
 * address equal to a different one. Anything that is not a parseable IPv6
 * literal is returned unchanged rather than guessed at.
 */
const IPV4_MAPPED_PREFIX = /^(?:::|(?:0{1,4}:){5})ffff:/i;
const HEX_GROUP_PAIR = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/**
 * One IPv6 address → its single canonical text, via the WHATWG URL host
 * parser (an IPv6 serialiser that is already in the runtime).
 *
 * Returns the input unchanged if it does not round-trip. The `isIP` check on
 * the way out is the guard that keeps this a canonicaliser and not a parser
 * with opinions: nothing is returned that is not still an IPv6 address.
 */
function canonicalizeIpv6(ip: string): string {
  try {
    const { hostname } = new URL(`http://[${ip}]`);
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      const inner = hostname.slice(1, -1);
      if (isIP(inner) === 6) return inner;
    }
  } catch {
    // Not a parseable IPv6 host — fall through and keep the original text.
  }
  return ip;
}

function normalizeIp(ip: string): string {
  if (isIP(ip) !== 6) return ip;

  const canonical = canonicalizeIpv6(ip);

  const prefix = IPV4_MAPPED_PREFIX.exec(canonical);
  if (!prefix) return canonical;
  const tail = canonical.slice(prefix[0].length);

  // `::ffff:1.2.3.4` — the low 32 bits already written as a dotted quad.
  if (isIP(tail) === 4) return tail;

  // `::ffff:0102:0304` — the same 32 bits as two hex groups. This is the form
  // step 1 produces for every mapped spelling.
  const hex = HEX_GROUP_PAIR.exec(tail);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    const dotted = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    if (isIP(dotted) === 4) return dotted;
  }

  return canonical;
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
 * ── WHO SEES WHAT ─────────────────────────────────────────────────────────
 *
 * 🔴 THE THROWN MESSAGE REACHES AN UNAUTHENTICATED CALLER. Every one of these
 * routes is public, and both paths out of a throw put `error.message` in the
 * response body — `endpoint-helpers.ts`'s catch-all, and the model route's own
 * `errorResponse(500, err.message)`. So the two audiences are split
 * deliberately:
 *
 *   CLIENT   a fixed, content-free string. It names no internal row, no column
 *            type, and nothing else about how these controls are configured.
 *   OPERATOR the row's key and the type it actually held, on the server log
 *            only — which is the audience that can act on either.
 *
 * Keep that split when editing this. The operator signal is the point of
 * throwing rather than returning `[]`, so do not drop the log to make the
 * message generic; and do not put the row's identity back in the message to
 * make it debuggable from a response body.
 *
 * An ABSENT row (`null`/`undefined`) is the ordinary "no list configured" state,
 * not a malformed one, and yields no entries without complaint.
 *
 * @param key the `KeyValue` key, named in the SERVER LOG so the row is
 *            identifiable. Never in the thrown message.
 */
export const MALFORMED_LIST_CLIENT_MESSAGE = 'Request could not be evaluated.';

function logMalformedListRow(key: string, value: unknown): void {
  // console.error rather than the Axiom client on purpose: this module is
  // imported by middleware and by the tRPC rate limiter, and a logging
  // dependency here would widen that import graph for one error path. The
  // routes that wrap this in a try already ship their own structured log.
  console.error(
    `[client-ip] KeyValue '${key}' is not a string (got ${typeof value}); refusing to evaluate this list.`
  );
}

function parseKeyValueList(value: unknown, key: string): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'string') {
    logMalformedListRow(key, value);
    throw new TypeError(MALFORMED_LIST_CLIENT_MESSAGE);
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
 *
 * ── ENTRIES ARE FOLDED THE SAME WAY THE DERIVED ADDRESS IS ────────────────
 *
 * The comparison at every call site is exact string equality between an entry
 * and the output of `getTrustedClientIp`, which returns a NORMALIZED address.
 * One address has many legal spellings, so an entry is only comparable once it
 * has been through the same fold — `normalizeIp` — as the value it is compared
 * against. Applying that fold to one side alone is worse than applying it to
 * neither: it moves the derived value to the canonical text and leaves an entry
 * written any other way matching nothing. Concretely, an entry of
 * `::ffff:203.0.113.7` or `2001:0DB8::1` has to be comparable against a derived
 * `203.0.113.7` / `2001:db8::1`, and an entry that never matches is a control
 * an operator believes covers an address it does not.
 *
 * `parseUserBlocklist` deliberately does NOT do this — its entries are user
 * ids, on which an address fold has no meaning.
 */
export function parseIpBlocklist(value: unknown): string[] {
  return parseKeyValueList(value, 'ip-blacklist').map(normalizeIp);
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
