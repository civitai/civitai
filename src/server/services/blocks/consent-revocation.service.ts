import { redis, REDIS_KEYS } from '~/server/redis/client';
import { MAX_BLOCK_TOKEN_LIFETIME_SECONDS } from '~/server/services/block-token-lifetimes';
import {
  CONSENT_SPEND_SCOPE,
  isConsentExemptScope,
} from '~/server/services/blocks/scope-grant.service';

/**
 * PER-SCOPE CONSENT REVOCATION, ENFORCED ON TOKENS ALREADY IN FLIGHT.
 *
 * ## The window this closes
 *
 * `app_user_scope_grants` is read at MINT. The block-JWT path
 * (`block-scope.middleware.ts`) then trusts `claims.scopes` verbatim — only the
 * hub-OAuth path re-derives from the grant — so writing a revocation to Postgres is
 * invisible to a token that was already signed, for up to its remaining life: 900s
 * default, 300s settings-scoped, 4h dev (`block-token-lifetimes.ts`). A user who clicks
 * "remove this permission" and watches the app keep using it for four hours has been told
 * something untrue by the UI.
 *
 * This marker is what makes the revoke take effect at the next REQUEST rather than at the
 * next mint. It is written by `blocks.revokeScopes` in the same mutation as the Postgres
 * write, and read at the TWO token seams that authorize consent-gated scopes —
 * `withBlockScope` (REST) and `authorizeBlockBridgeToken` (tRPC) — which then STRIP the revoked
 * scopes from the verified claims.
 *
 * ⚠️ "BOTH token seams" WAS WRONG AS A COUNT: there are FOUR `verifyBlockToken` call sites, and
 * this repo ledgers them as four (`src/shared/constants/block-scope.constants.ts`). The other
 * two — `resolveSharedContext` (`apps-shared.router.ts`) and `resolveStorageContext`
 * (`apps/app-storage.service.ts`) — re-verify the raw bearer themselves and do NOT apply
 * revocations. That is harmless because each authorizes only `apps:storage:*` /
 * `apps:storage:shared:*`, every one of which is consent-exempt, so no marker can ever name a
 * scope they check. It is harmless by a PROPERTY, not by construction, so it is asserted:
 * `src/server/services/__tests__/no-unguarded-block-rest-token.test.ts` ledgers which seams
 * apply revocations and why the other two need not, and fails if either set moves.
 *
 * ## 🔴 STRIPPING, NOT ONLY REFUSING — AND THE FIRST VERSION OF THIS FILE GOT IT WRONG
 *
 * The first cut asked one question: "is the ROUTE's declared `requiredScope` revoked?".
 * That is narrower than the revoke, in the direction that matters, and review caught it by
 * enumeration: of the six consent-gated scopes, only four are ever a declared
 * `requiredScope`. The two that are NOT are the two most sensitive —
 * `posts:write:self`, authorized on the tRPC bridge at `authorizeBlockPostRequest` which
 * never passes through `withBlockScope` at all; and `collections:read:private`, an
 * IN-HANDLER sub-check (`pages/api/v1/blocks/collections/index.ts`,
 * `collections/[id]/index.ts`) sitting under a route whose declared scope is the
 * consent-EXEMPT `collections:read:self`. So revoking the scope this repo calls "the first
 * block scope that writes PUBLIC, feed-visible, reward-earning content under the VIEWER'S
 * name" enforced nothing, and the middleware's own comment claiming "the refusal is as
 * narrow as the revoke was" was false — it was narrower.
 *
 * The fix is to stop enumerating gates. Every consumer of a block token — the REST
 * middleware's own `requiredScope` check, every in-handler `claims.scopes.includes(...)`
 * sub-check, and every bridge procedure — authorizes off `claims.scopes`. Removing the
 * revoked members from that array at the two places a token is verified makes all of them
 * honour the revoke with no per-gate list to keep current. {@link applyRevocations} is that
 * step; the `consent_revoked` 403 remains on top of it, so an app gets a distinguishable
 * code instead of a bare `insufficient_scope`.
 *
 * ## 🔴 IT FAILS **CLOSED**, AND `BlockRevocation` FAILS **OPEN** — ON PURPOSE
 *
 * The two look like the same kind of control and are not, so this is stated in both
 * modules rather than in one:
 *
 *   - `BlockRevocation.isRevoked` swallows a Redis error and returns `false` (not
 *     revoked). Its markers are a SIDE EFFECT of uninstall / toggle-off / publisher-ban —
 *     operations whose own success must not depend on Redis — and its exposure is already
 *     bounded by the token lifetime. Blocking legitimate traffic fleet-wide on a cache
 *     incident buys nothing there, because the thing being protected (an install that has
 *     gone away) has no ongoing user asking for it.
 *   - THIS one refuses on a Redis error. The marker exists because a USER asked for access
 *     to stop, NOW. "The cache was down so we kept granting the permission you revoked"
 *     is not a degradation of that promise, it is the promise not being kept — and unlike
 *     the uninstall case there is a person on the other end who was told it was done.
 *
 * 🔴 THE TWO READS THEREFORE CANNOT SHARE ONE `mGet`, and that is not an oversight worth
 * "tidying". One call has one `catch`, and these two need opposite ones. Folding them
 * would silently convert whichever half lost the argument.
 *
 * 🔴 THE PRICE, STATED PLAINLY: during a Redis outage every revokable scope is stripped
 * from every authed token, and a route whose `requiredScope` is revokable refuses. That is
 * a real availability coupling on the App Blocks surface, accepted as the cost of the
 * guarantee above.
 *
 * It is narrowed by reading at all ONLY when a read could change the outcome — see
 * {@link shouldConsultMarker}: an anon token has no (user, app) pair, and a token carrying
 * no consent-gated scope cannot be affected by any marker. That keeps every
 * `apps:storage:*` and `collections:read:self`/`write:self` app out of the coupling
 * entirely, which is keyed on the app's MANIFEST, not on the route.
 *
 * ⚠️ DO NOT QUOTE "20 of the 29 scope-bound routes" FOR THIS PREDICATE — that figure belongs to
 * the FIRST version, which tested the route's declared scope, and reading it as this one's
 * saving is how the perf re-review mis-priced the change. The mint signs the app's whole
 * effective set, so an app declaring ANY gated scope is looked up on every route including its
 * exempt-scope ones. The population actually skipped is anon tokens (doubly — the mint strips
 * gated scopes for them) plus apps whose entire granted set is exempt; enumerated over the
 * first-party manifests on one box, 12 of 15 carry at least one gated scope, so the skip is a
 * minority of authed traffic and the fail-closed coupling is WIDER than the first estimate.
 * Stated plainly here because the honest number is the one that gets acted on.
 *
 * ## Why the value carries the scope set
 *
 * A per-(user, app) boolean would refuse the app's ENTIRE surface for up to a token
 * lifetime because the viewer withdrew one permission — so revoking `posts:write:self`
 * would break a block's unrelated `models:read:self` rendering. The value is a JSON array
 * of revoked scopes and the guard compares the route's OWN required scope against it, so
 * the refusal is as narrow as the revoke was.
 */

/**
 * TTL = the longest token this marker must outlive.
 *
 * 🔴 DERIVED, NEVER A LITERAL. `block-revocation.service.ts` states the same rule and the
 * same history: a marker shorter than the token it revokes lapses while that token is
 * still accepted, and a missing key reads as "not revoked" — the control stops refusing
 * without failing. That is precisely how `REVOKED_INSTANCE`'s TTL sat at 15 minutes for
 * the whole time `dev:live` tokens lived 4 hours. A new token kind added to
 * `BLOCK_TOKEN_LIFETIMES_SECONDS` raises this automatically.
 */
const CONSENT_REVOCATION_TTL_SECONDS = MAX_BLOCK_TOKEN_LIFETIME_SECONDS;

/**
 * `<prefix>:<userId>:<appBlockId>`.
 *
 * Keyed on the pair the GRANT is keyed on — not on `blockInstanceId`, which is what the
 * two `BlockRevocation` keyspaces use. A viewer's consent is per (user, app): the same
 * app can be installed on many models and minted under several instance-id namespaces,
 * and a revoke has to reach all of them.
 */
function consentRevokedKey(userId: number, appBlockId: string) {
  return `${REDIS_KEYS.BLOCKS.CONSENT_REVOKED_SCOPES}:${userId}:${appBlockId}` as const;
}

export class ConsentRevocation {
  /**
   * Publishes the viewer's CURRENT full suppression list for one app.
   *
   * 🔴 WRITES THE WHOLE LIST, NOT A DELTA. The caller has just computed
   * `revoked_scopes` in Postgres; writing that same set makes the marker a snapshot of
   * the authoritative row rather than an accumulating side channel that could disagree
   * with it. It also makes a re-consent expressible: `grantScopes` lifts suppressions in
   * Postgres and re-publishes the narrower list here, so the lifted scope stops being
   * refused immediately instead of waiting out the TTL.
   *
   * 🔴 THROWS ON A REDIS FAILURE, unlike `BlockRevocation.revokeInstance`, which swallows
   * one. Same asymmetry as the read, and for the same reason: the caller is a mutation
   * whose entire purpose is this revocation. If the marker cannot be written the viewer
   * must be told the revoke is only partially in force (the Postgres row IS written and
   * governs every future mint) rather than being shown a success that silently leaves an
   * in-flight token spending for up to four hours. The router turns this into a
   * user-visible error naming both halves.
   *
   * An EMPTY list deletes the key rather than storing `[]`: nothing is revoked, so there
   * is no reason to make every request pay a hit that can only ever answer "no".
   */
  static async publish(opts: {
    userId: number;
    appBlockId: string;
    revokedScopes: string[];
  }): Promise<void> {
    const key = consentRevokedKey(opts.userId, opts.appBlockId);
    if (opts.revokedScopes.length === 0) {
      await redis.del(key);
      return;
    }
    await redis.set(key, JSON.stringify(opts.revokedScopes), {
      EX: CONSENT_REVOCATION_TTL_SECONDS,
    });
  }

  /**
   * The viewer's current suppression set for one app, as a three-way verdict — FAIL CLOSED.
   *
   * Outcomes, all four states deliberate:
   *   - no key                  → `{ kind: 'none' }`. The overwhelmingly common case; one
   *                               GET, one miss.
   *   - key present and parsed   → `{ kind: 'revoked', scopes }`.
   *   - Redis threw              → `{ kind: 'unavailable' }`.
   *   - value would not parse as a string array → `{ kind: 'unavailable' }`.
   *
   * 🔴 THE LAST TWO ARE ONE ARM BECAUSE THEY ARE THE SAME SITUATION. A throw is the obvious
   * one. A value that does not parse is it wearing different clothes: the key EXISTS, so
   * something published a revocation, and we cannot tell which scopes it covered. Reading
   * an unparseable marker as "nothing revoked" would turn a corrupt write — or a format
   * change rolled out to some pods first — into a silent fail-open on the one control a
   * user explicitly asked for.
   *
   * 🔴 `unavailable` IS NOT `none`, AND THE CALLER MUST NOT COLLAPSE THEM. This function
   * deliberately does not decide what to do about it: a verdict that folded "unknown" into
   * "everything is revoked" here would be right for the REST gate and wrong for the
   * any-token catalog routes. {@link applyRevocations} owns that decision, in one place.
   */
  static async lookup(opts: {
    userId: number;
    appBlockId: string;
  }): Promise<ConsentRevocationVerdict> {
    try {
      const raw = await redis.get(consentRevokedKey(opts.userId, opts.appBlockId));
      if (raw == null) return { kind: 'none' };
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== 'string')) {
        return { kind: 'unavailable' };
      }
      return { kind: 'revoked', scopes: new Set(parsed as string[]) };
    } catch {
      // FAIL CLOSED — see the docblock. Covers both the Redis error and a JSON.parse throw.
      return { kind: 'unavailable' };
    }
  }
}

/**
 * What a viewer is told when the durable revoke landed but the in-flight marker did not.
 *
 * 🔴 IT MUST BE CARRIED BY A **4xx** TO REACH THEM. `src/server/trpc/client-safe-error.ts`
 * replaces the message of every `status >= 500 && status !== 503`, so throwing this under
 * `INTERNAL_SERVER_ERROR` — the first version — discarded it one layer below the throw and
 * showed a generic "something went wrong (ref: …)". The whole value of this wording is
 * letting the viewer tell "recorded, enforcement lags" from "nothing was recorded"; a
 * generic 500 says neither. `SERVICE_UNAVAILABLE` is that formatter's carve-out.
 *
 * Exported so the test pins the exact string and a mutant that swaps it for a different
 * error is killed by the MESSAGE, not merely by "something threw".
 */
export const CONSENT_REVOKE_MARKER_DEGRADED_MESSAGE =
  'The permission was removed and will not be granted again, but an already-open app session ' +
  'may keep using it for a few more minutes. Reload the app to be sure.';

/** The three states a marker read can be in. `unavailable` is NOT `none` — see `lookup`. */
export type ConsentRevocationVerdict =
  | { kind: 'none' }
  | { kind: 'revoked'; scopes: Set<string> }
  | { kind: 'unavailable' };

/**
 * Whether a marker read can change this request's outcome at all.
 *
 * 🔴 TWO SKIPS, EACH FOR ITS OWN REASON — and NEITHER of them is the route's declared
 * scope, which is what the first version tested and where its hole was.
 *
 *   - ANON subject: consent is per (user, app). An anon token has no user, so no marker can
 *     exist for it.
 *   - NO CONSENT-GATED SCOPE IN THE TOKEN: `partitionByConsent` signs a
 *     `CONSENT_EXEMPT_SCOPES` member on the exempt test ALONE, before it consults the grant,
 *     and `blocks.revokeScopes` refuses to record a suppression for one — so a marker can
 *     never name a scope such a token carries. An app whose whole manifest is exempt
 *     (`apps:storage:*`, shared storage, `collections:read:self`) never reads the marker.
 *
 *     ⚠️ NO ROUTE FIGURE HERE. "20 of the 29 scope-bound REST routes" was retracted in this
 *     file's header and again in the middleware, and survived in THIS docblock — the one both
 *     retractions tell the reader to consult. It is a true statement about ROUTES and a wrong
 *     attribution for this predicate, which never reads a route: the mint signs the app's whole
 *     effective set, so an app declaring any gated scope is looked up on its exempt-scope routes
 *     too. The population is per-APP; sizing it means grepping the manifests, not the routes.
 *
 * Both are also what keeps those populations out of the fail-closed availability coupling,
 * which is a welcome consequence and not the reason either exists.
 */
export function shouldConsultMarker(opts: {
  userId: number | null;
  scopes: readonly string[];
}): boolean {
  if (opts.userId === null) return false;
  return opts.scopes.some((s) => !isConsentExemptScope(s));
}

/**
 * The scopes to treat as revoked for a token, given a verdict — the ONE place "unknown"
 * becomes a decision.
 *
 * 🔴 `unavailable` FAILS CLOSED BY NAMING EVERY REVOKABLE SCOPE THE TOKEN CARRIES, not by
 * naming all of them. Stripping a consent-EXEMPT scope during a Redis incident would refuse
 * `apps:storage:*` and `collections:read:self` traffic that no revoke could ever have
 * touched — a self-inflicted outage on a population the feature does not apply to. Exempt
 * scopes are signed without a grant, so there is nothing about them for a marker to be
 * unknown about.
 */
export function revokedScopesForToken(
  verdict: ConsentRevocationVerdict,
  scopes: readonly string[]
): Set<string> {
  // 🔴 THE EXEMPT FILTER IS APPLIED TO **BOTH** ARMS, AND IT USED TO GUARD ONLY THE
  // HYPOTHETICAL ONE. The `unavailable` arm — a set this function invents — was filtered,
  // while the `revoked` arm — a set read from EXTERNALLY WRITTEN Redis data — was returned
  // verbatim. That is backwards: the arm carrying untrusted input was the unguarded one.
  //
  // Unreachable today only because `blocks.revokeScopes` refuses an exempt scope before
  // storage, and `revokeScopes`' own docblock says in words that the service does not filter
  // and "THE CALLER MUST REFUSE AN EXEMPT ONE FIRST". One new caller of that exported
  // function, or one hand-written `revoked_scopes` row — and this table has a committed
  // precedent for exactly that — and exempt scopes would be stripped at both seams, which the
  // same file calls "explicitly NOT the design". Filtering once, ahead of the switch, costs
  // nothing and makes it unrepresentable.
  const revokable = (set: Iterable<string>) =>
    new Set([...set].filter((s) => !isConsentExemptScope(s)));
  if (verdict.kind === 'none') return new Set();
  if (verdict.kind === 'revoked') return revokable(verdict.scopes);
  return revokable(scopes);
}

/**
 * Removes every revoked scope from a verified token's scope array.
 *
 * 🔴 THIS IS THE WHOLE ENFORCEMENT MECHANISM, AND IT IS A STRIP RATHER THAN A LIST OF
 * GATES ON PURPOSE. Every consumer of a block token authorizes off `claims.scopes` — the
 * REST middleware's `requiredScope` check, the in-handler `claims.scopes.includes(...)`
 * sub-checks that gate `collections:read:private`, and every one of the bridge procedures.
 * Removing the revoked members once, where the token is verified, makes all of them honour
 * the revoke with no per-gate enumeration to keep current. The first version enumerated,
 * and missed the two most sensitive scopes.
 *
 * Returns the SAME object when nothing was revoked, so the common path allocates nothing.
 *
 * 🔴 THAT IDENTITY IS LOAD-BEARING AND IS A CONTRACT: `kept.length === claims.scopes.length` must
 * keep returning `claims` itself, not a clone. ⚠️ The `revoked.size === 0` line above it is a pure
 * FAST PATH, not a second guard — an empty revocation set produces `kept.length ===
 * claims.scopes.length`, so deleting it changes nothing observable and no test can kill it
 * (measured: 75 tests green without it). Do not read it as belt-and-braces for the contract.
 *
 * ⚠️ THE PREVIOUS PARAGRAPH SAID THE OPPOSITE AND IS RETRACTED, VERBATIM SO NOBODY RE-DERIVES IT:
 * *"DO NOT BUILD ON THAT IDENTITY. This used to promise 'a caller can use identity to tell whether
 * anything changed', and the one caller that did (`narrowed !== claims` in the REST middleware) is
 * gone — the middleware now assigns unconditionally. So the guarantee is an allocation
 * optimisation with no consumer, not a contract: a future refactor is free to return a fresh
 * object, and nothing should start depending on reference equality here."* The REST half of that
 * is true; the conclusion is not, because it enumerated one seam and the BRIDGE is a second one.
 *
 * THE CONSUMERS, named so the claim is checkable rather than asserted:
 *   - `src/server/services/blocks/block-bridge-auth.service.ts` — `if (narrowed !== claims)`, whose
 *     own comment says identity is the cheap test for "did this request lose a scope". It gates
 *     `recordConsentStrip('bridge', …)`.
 *   - `consent-revocation.service.test.ts` — pins it with `toBe`, and that test KILLS the mutant
 *     that drops the `kept.length === claims.scopes.length` early return.
 *
 * 🔴 WHAT ACTING ON THE OLD LICENCE WOULD HAVE COST: returning a fresh object makes
 * `narrowed !== claims` true on every consulted bridge request, so `recordConsentStrip('bridge', …)`
 * fires whether or not anything was stripped — inflating the very series whose help text tells the
 * operator that a non-zero value means viewers are withdrawing permissions. A metric that reports
 * a withdrawal on every request is worse than no metric.
 */
export function applyRevocations<T extends { scopes: string[]; buzzBudget?: number }>(
  claims: T,
  revoked: Set<string>
): T {
  if (revoked.size === 0) return claims;
  const kept = claims.scopes.filter((s) => !revoked.has(s));
  if (kept.length === claims.scopes.length) return claims;
  // 🔴 THE PER-CALL BUZZ CEILING GOES WITH THE SPEND SCOPE, AND IT LIVES HERE SO NEITHER SEAM
  // CAN FORGET IT. The REST middleware did this itself and the bridge did not — so
  // `blocks.getMyViewer`, the surface the REST comment CITED as harmed, kept publishing a ceiling
  // for a scope it would now 403. The same "only one of the two seams got it" shape as the defect
  // that comment was describing. Not a spend hole (every spend gate checks the scope first), but
  // `enforceContextBinding` treats a positive `buzzBudget` AS the `ai:write:budgeted` binding,
  // which is what turns it into one on the next edit.
  return revoked.has(CONSENT_SPEND_SCOPE) && claims.buzzBudget !== undefined
    ? { ...claims, scopes: kept, buzzBudget: undefined }
    : { ...claims, scopes: kept };
}
