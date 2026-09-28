import {
  isKnownBlockScope,
  validateBlockScopesAgainstOauthClient,
} from '~/shared/constants/block-scope.constants';
import { domainBrowsingCeiling } from '~/shared/constants/browsingLevel.constants';
import { isPageSlot, PAGE_FORBIDDEN_SCOPES, PAGE_SLOT_ID } from '~/shared/constants/slot-registry';
import { BlockTokenService } from '~/server/services/block-token.service';

/**
 * SHARED dev-scoped block-token mint belt (App Dev Tunnel).
 *
 * This is the AUDITED clamp + budget + sign belt extracted VERBATIM from the
 * `POST /api/v1/blocks/dev-token` handler so BOTH mint entrypoints reuse the
 * identical, adversarially-reviewed logic instead of a parallel re-implementation
 * (where escalation defenses silently drift apart):
 *
 *   1. `/api/v1/blocks/dev-token`         — BEARER-authed (personal key / OAuth
 *                                            civitai-cli) dev:live harness mint.
 *                                            Uses `DEV_TOKEN_SCOPE_ALLOWLIST`
 *                                            (WITH apps:storage:*) and gates the
 *                                            spend scope on the bearer credential's
 *                                            AIServicesWrite bit (`spendEntitled`)
 *                                            AND the body's `requestBudgetedSpend`
 *                                            (`spendRequested`).
 *   2. `/api/v1/block-tokens` (Phase 2)   — COOKIE-authed author-own dev-tunnel
 *                                            branch, for the SSR dev host at
 *                                            `/apps/dev/<blockId>`. Uses
 *                                            `TUNNEL_HOST_MINT_SCOPE_ALLOWLIST`
 *                                            (WITHOUT apps:storage:* — Decision 1:
 *                                            App Storage stays 403 until approval)
 *                                            and passes `spendEntitled: true` +
 *                                            `spendRequested: true` because there is
 *                                            no bearer ceiling and no request body
 *                                            (the declaring manifest IS the
 *                                            request); SPEND is instead bounded at
 *                                            RUNTIME by the SELF-BOUND `sub`, the
 *                                            per-call `buzzBudget` claim and the
 *                                            aggregate per-user / per-app caps in
 *                                            `reserveBlockBuzzSpendForClaims`.
 *
 * 🔴 CORRECTION (2026-09-27): the four lines above used to name
 * `assertViewerIsAppDeveloper(sub)` as the runtime spend gate. THAT CALL DOES NOT
 * HAPPEN, and it has not for some time. There are two independent, module-PRIVATE
 * helpers of that name — `blocks/user-settings.service.ts` and
 * `apps/app-storage.service.ts` — with two call sites between them: a viewer
 * SETTINGS write, and the mod review "run for real" STORAGE branch. Neither is on
 * the workflow-submit or spend path, and `blocks.router.ts`'s own header records
 * that the settings write "was its LAST call site in this router" — the gate was
 * deliberately removed from the runtime procedures because an AUTHORING capability
 * blocked the entire non-author cohort from USING an app.
 *
 * 🔴 WHY THE STALE SENTENCE WAS DANGEROUS RATHER THAN MERELY WRONG. It reads as
 * "a non-author cannot spend here", so a reviewer asked to widen a mint to a
 * non-author would reasonably ask for that gate to be widened too — widening a
 * gate that does not exist, on a path where the real bound is the self-bound
 * `sub`. Anyone reasoning about who may spend on this path must read
 * `reserveBlockBuzzSpendForClaims`, not this comment's former claim.
 *
 * Every hard cap is IDENTICAL across both callers: forced-SFW ceiling, self-bound
 * `sub`, `dev:true` short (4h) TTL, DEV_BUZZ_BUDGET_CAP per-call budget, page ctx.
 * The synthetic, NON-RESOLVING appId/appBlockId (never an `appblk-<slug>` OauthClient
 * id nor a UUIDv4) is the caller's responsibility to construct — it guarantees
 * `recordSpendAttribution`'s `oauthClient.findUnique` MISSES (no forged attribution).
 */

// A LOWER dev budget cap than the prod 1000. The dev spends their OWN Buzz and the
// per-user daily cumulative cap is untouched; this just bounds a single submit's
// reservation.
export const DEV_BUZZ_BUDGET_CAP = 250;
export const DEV_BUZZ_BUDGET_DEFAULT = 50;

// Forced SFW — the dev mint NEVER reads the request host. localhost / the dev
// tunnel has no color domain, and even a color-localhost dev config must not widen
// maturity.
export const FORCED_SFW_CEILING = domainBrowsingCeiling(null);

/**
 * The BEARER dev-token allowlist (scope doc §4.1): read/catalog scopes + the page
 * spend scope + per-app storage. Used by `/api/v1/blocks/dev-token` only.
 * DELIBERATELY EXCLUDES `social:tip:self` (real money OUT). A requested /
 * approved scope outside this set is STRIPPED (defense-in-depth).
 */
export const DEV_TOKEN_SCOPE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'models:read:self',
  'user:read:self',
  'ai:write:budgeted',
  'apps:storage:read',
  'apps:storage:write',
  // collections:* — INCLUDED in the dev allowlists (both this bearer path and the
  // tunnel path below). Unlike apps:storage:shared:* (deliberately withheld pre-
  // approval because a pre-approval app's storage NAMESPACE is synthetic and could
  // collide across the approve boundary), the collections surface has NO per-app
  // namespace: read operates on the dev's OWN collections + PUBLIC collections and
  // is gated server-side by visibility/ownership + the maturity clamp; follow is
  // self-bound to the dev's account. There is no cross-approve-boundary state to
  // protect, so a developer iterating on a collections app in dev:live / dev-tunnel
  // can safely exercise discover/read/follow. `social:tip:self` stays EXCLUDED
  // (real money OUT — unchanged), so a collections app's TIP button is not
  // exercisable via a dev token (matches the existing "no real money in dev"
  // posture). `collections:read:private` (own private collections) is included:
  // in prod it's consent-gated, but the dev-token path is self-bound to the dev's
  // OWN account (no third-party data), so a dev iterating locally can read their
  // own private collections without a consent round-trip.
  'collections:read:self',
  'collections:write:self',
  'collections:read:private',
  // buzz:read:self (own ledger / balance / earnings) is included in BOTH dev
  // allowlists (this bearer path + the tunnel path below). In prod it's
  // consent-gated, but the dev-mint path is self-bound to the dev's OWN account
  // (the token `sub` is the authenticated dev via the mint's subject-user
  // resolution; the buzz-read bridge derives userId off `claims.sub`, never body
  // input), so it reads ONLY the dev's own ledger — no third-party financial data
  // and no consent round-trip. It's a pure READ (no money moves); the money-OUT
  // scope `social:tip:self` stays EXCLUDED everywhere. Consistent with these dev
  // allowlists ALREADY granting `ai:write:budgeted` (real Buzz SPEND) and
  // `collections:read:private` — forbidding a dev from READING their own balance
  // while permitting SPENDING it is incoherent.
  'buzz:read:self',
  // posts:write:self — INCLUDED in BOTH dev allowlists (this bearer path and the
  // tunnel path below), DELIBERATELY EXCLUDED from both review allowlists.
  //
  // WHY INCLUDED HERE: a dev token is SELF-BOUND to the author's OWN account, so
  // the only profile an app-under-development can post to is the author's, and
  // the author can delete the post. Omitting it would mean a developer building
  // a posting app iterates against a PERMANENTLY 403-ing endpoint with no way to
  // fix it — consent cannot help, because these allowlists strip the scope
  // BEFORE the token is signed (`resolveUngrantableConsentNotice`). Consistent
  // with these allowlists already granting `ai:write:budgeted` (real Buzz spend).
  //
  // 🔴 IT IS STILL A REAL PUBLIC POST. Unlike `apps:storage:*`, there is no
  // sandbox namespace — a dev-token post is indistinguishable from a production
  // one on the site. That is accepted for the AUTHOR'S OWN account and is the
  // reason the mod-review allowlists below withhold it: a moderator previewing
  // SOMEONE ELSE'S unapproved app must never be made to publish public content
  // under the MOD'S name, not even behind the run-for-real consent gate. The
  // full server-side gate (approval, revocation, write-trust, per-source
  // ownership, the host confirm, the dedicated Flipt flag) still applies to
  // every dev-token call.
  'posts:write:self',
  // goods:read:self — INCLUDED in BOTH dev allowlists (this bearer path and the
  // tunnel path below). A pure self-bound read of what the DEV owns from THIS
  // app; a pre-approval app has no rows, so it simply answers empty rather than
  // 403-ing a UI the developer is trying to build.
  //
  // 🔴 `goods:purchase:self` is DELIBERATELY EXCLUDED FROM ALL FOUR allowlists,
  // like `social:tip:self` — no real money OUT in dev. It would also be inert:
  // the purchase path refuses a buyer who owns the app, and a pre-approval app
  // has no AppBlock row to resolve a catalog from at all.
  'goods:read:self',
]);

/**
 * The COOKIE-authed dev-TUNNEL host-mint allowlist (Phase 2). IDENTICAL to
 * `DEV_TOKEN_SCOPE_ALLOWLIST` MINUS `apps:storage:read` / `apps:storage:write`
 * (Decision 1). App Storage is REFUSED pre-approval: a pre-approval app has a
 * synthetic, non-resolving appId, so its storage namespace is undefined and could
 * collide across the approve boundary — generation/Buzz work pre-approval, App
 * Storage does not. Stripping the scope from the clamp is defense-in-depth ON TOP
 * of the downstream `resolveStorageContext` 404 for a synthetic/non-approved appId
 * (so a minted tunnel token can NEVER carry a storage scope in the first place).
 */
export const TUNNEL_HOST_MINT_SCOPE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'models:read:self',
  'user:read:self',
  'ai:write:budgeted',
  // collections:* — INCLUDED here too (see DEV_TOKEN_SCOPE_ALLOWLIST rationale):
  // no per-app namespace, gated server-side by visibility/ownership/subject, so
  // there is no pre-approval collision to protect against (contrast
  // apps:storage:*, which this tunnel allowlist withholds until approval).
  'collections:read:self',
  'collections:write:self',
  'collections:read:private',
  // buzz:read:self — INCLUDED here too (see DEV_TOKEN_SCOPE_ALLOWLIST rationale):
  // self-bound to the dev's OWN ledger via the token subject, a pure READ, no
  // consent round-trip needed in the author's own dev-tunnel preview. Deliberately
  // WITHHELD from the mod-review sandbox below (a mod previewing another author's
  // app must not leak the mod's own balance).
  'buzz:read:self',
  // posts:write:self — INCLUDED here too (see the DEV_TOKEN_SCOPE_ALLOWLIST
  // rationale): self-bound to the AUTHOR'S OWN profile in their own dev tunnel,
  // and the only way a posting app is iterable pre-approval. Deliberately
  // WITHHELD from BOTH mod-review allowlists below — a mod previewing another
  // author's unapproved app must never publish under the MOD'S name.
  'posts:write:self',
  // goods:read:self — INCLUDED here too (see DEV_TOKEN_SCOPE_ALLOWLIST
  // rationale): self-bound, read-only, and empty for a pre-approval app.
  // `goods:purchase:self` stays excluded everywhere.
  'goods:read:self',
]);

/**
 * The MOD-REVIEW-SANDBOX host-mint allowlist (#2831 review preview). RENDER-ONLY:
 * the STRICTEST of the three allowlists. A mod runs UNAPPROVED, untrusted code
 * with their OWN session, so the review token must carry the minimum a block needs
 * to render — self-bound reads ONLY, NEVER money / private / cross-user / write.
 *
 * KEEP (render-only survivors, all self-bound reads):
 *   - `models:read:self`   the caller's own models (self-bound)
 *   - `user:read:self`     the caller's own identity (also force-granted post-clamp)
 *   - `collections:read:self` own-PUBLIC + any PUBLIC collection (no per-app namespace)
 *
 * WITHHELD (stripped regardless of what the pending manifest declares — the clamp
 * drops any scope not in this set, so none of these can EVER reach the review JWT):
 *   - `ai:write:budgeted`         real Buzz spend (ALSO stripped by spendEntitled:false)
 *   - `apps:storage:read|write`   per-user App Storage (synthetic appId → no namespace)
 *   - `apps:storage:shared:read|write` cross-user shared datastore (write = abuse)
 *   - `collections:read:private`  the caller's OWN private collections (consent-gated)
 *   - `collections:write:self`    a write surface
 *   - `social:tip:self`           real money OUT
 *   - `goods:purchase:self`       real money OUT (an app's own paid catalog)
 *   - `goods:read:self`           not needed to RENDER; answers empty pre-approval
 *   - `buzz:read:self`            private financial (balance / ledger / earnings)
 *   - `posts:write:self`          PUBLIC content published under the MOD'S name
 *
 * These strings are verified against block-scope.constants.ts. Modelled on
 * TUNNEL_HOST_MINT_SCOPE_ALLOWLIST but WITHOUT `ai:write:budgeted`,
 * `collections:write:self`, and `collections:read:private`: the dev tunnel is the
 * AUTHOR previewing their OWN app (spend on their own Buzz is intended); the review
 * sandbox is a MOD previewing SOMEONE ELSE'S un-approved app, so nothing that
 * spends, writes, or reads private/cross-user data is ever granted.
 */
export const REVIEW_MINT_SCOPE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'models:read:self',
  'user:read:self',
  'collections:read:self',
]);

/**
 * The MOD-REVIEW-SANDBOX "RUN FOR REAL" host-mint allowlist (#2831). Used ONLY
 * when a moderator EXPLICITLY opts in (per-preview, behind a loud consent gate)
 * to run an UNAPPROVED review app FOR REAL against THEIR OWN account, so they can
 * fully evaluate generation / storage / buzz before approving.
 *
 * It is the render-only `REVIEW_MINT_SCOPE_ALLOWLIST` PLUS the SELF-BOUND
 * capabilities needed to exercise a page app end-to-end — and NOTHING that could
 * move money OUT or touch another user:
 *
 * ADDED over render-only (all SELF-BOUND to the reviewing mod):
 *   - `ai:write:budgeted`   real Buzz SPEND-IN for generation (also gated by the
 *                           per-call budget AND the aggregate session cap below)
 *   - `apps:storage:read`   the mod's OWN per-app KV (see caveat *)
 *   - `apps:storage:write`  the mod's OWN per-app KV (see caveat *)
 *   - `buzz:read:self`      the mod's OWN balance/ledger (self-bound read)
 *
 * DELIBERATELY WITHHELD (clamped out regardless of what the pending manifest
 * declares — the clamp keeps only scopes IN this set, so a malicious manifest
 * declaring extra scopes gets NONE of these):
 *   - `social:tip:self`               real money OUT — NEVER granted (invariant #4)
 *   - `goods:purchase:self`           real money OUT — same invariant. A mod
 *                                     evaluating an app must never be charged for
 *                                     that app's catalog, and the purchase path
 *                                     has no pre-approval AppBlock row to price
 *                                     against anyway.
 *   - `goods:read:self`               nothing to read pre-approval (no entitlement
 *                                     rows exist for a synthetic appBlockId), so
 *                                     granting it would widen the token for no
 *                                     evaluable behaviour.
 *   - `apps:storage:shared:read|write` cross-user shared datastore — NEVER (invariant #2)
 *   - `collections:read:private`      third-party-reachable private data
 *   - `collections:write:self`        write surface not needed to evaluate a page app
 *   - `posts:write:self`              PUBLIC, feed-visible, reward-earning content
 *                                     published under the REVIEWING MOD'S name. The
 *                                     run-for-real gate consents the mod to SPEND
 *                                     their own Buzz; it does not consent them to
 *                                     become the author of an unapproved app's
 *                                     output on their public profile. A post also
 *                                     has no disposable preview namespace (contrast
 *                                     App Storage's `apprev_<pubreq>` schema) — it
 *                                     is indistinguishable from a real one and
 *                                     survives the approve/reject teardown.
 *
 * (*) App Storage WORKS under run-for-real via a dedicated preview namespace:
 * `resolveStorageContext` (apps.router), when the token carries the signed
 * `reviewRunForReal` claim, resolves a DISPOSABLE, per-publishRequest, ISOLATED
 * `apprev_<pubreq>` schema (provisioned on demand) instead of the un-approved
 * `app_<slug>` schema. Reads/writes are self-bound to the mod, cannot reach another
 * pending app's namespace, and never pollute the eventual approved app's schema; the
 * preview schema is dropped on the approve/reject teardown. Generation + own-Buzz-read
 * likewise work (self-bound; no approved AppBlock row required).
 *
 * Money-OUT (`social:tip:self`) is excluded SOLELY by its ABSENCE from this
 * allowlist: the clamp keeps only scopes in the allowlist (step b), so a manifest
 * declaring `social:tip:self` gets it dropped for a review mint. NOTE this is NOT
 * a page-wide rule — `PAGE_FORBIDDEN_SCOPES` is intentionally EMPTY because a
 * PROD page token legitimately CAN carry a bounded, consent-gated `social:tip:self`
 * (a page tip button, capped per-tip + per-day in /api/v1/blocks/tip). The
 * review-sandbox exclusion is therefore this allowlist ALONE — verified by a
 * regression test (a run-for-real mint never yields `social:tip:self`).
 */
export const REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'models:read:self',
  'user:read:self',
  'collections:read:self',
  'ai:write:budgeted',
  'apps:storage:read',
  'apps:storage:write',
  'buzz:read:self',
]);

/**
 * The AUDITED scope clamp belt (dev-token.ts steps 7a–7g), extracted verbatim.
 * Start from `scopeSource` (the app's approved snapshot, an owned pending request's
 * un-reviewed `manifest.scopes`, or the caller's self-declared body scopes) and:
 *   a) keep only KNOWN block scopes,
 *   b) keep only scopes within `allowlist` (excludes social:tip:self always;
 *      for the tunnel allowlist also apps:storage:*),
 *   c) keep only scopes within the app's OAuth ceiling (approved path only —
 *      `oauthAllowed !== null`); OMITTED for a pending / no-row / ephemeral app
 *      (no OauthClient — passing 0 would WRONGLY strip every non-skip scope),
 *   d) drop any PAGE_FORBIDDEN scopes — currently a NO-OP (PAGE_FORBIDDEN_SCOPES
 *      is intentionally EMPTY: every page-requestable money scope is now bounded).
 *      Retained as the deterministic re-forbid hook; it is NOT the money-out gate
 *      for the review sandbox — that is the allowlist (b), which omits social:tip:self,
 *   e) if the body narrowed, intersect with the requested subset,
 *   f) SPEND ceiling — strip `ai:write:budgeted` unless BOTH `spendEntitled` AND
 *      `spendRequested` (see the two-predicate note below),
 *   g) force-grant `user:read:self` (self-bound read of the caller's OWN identity).
 * Every step is a STRIP (no error). The belt is byte-identical across all callers
 * bar the allowlist + the OAuth-ceiling substitution.
 *
 * ─── Step (f): TWO independent predicates, never one (#3703 step 1) ───
 * The spend ceiling used to be a single `keyCanSpend: boolean`, which meant three
 * different things at its three call sites — ENTITLEMENT (bearer: the credential's
 * AIServicesWrite bit), entitlement DEFERRED to a runtime gate (tunnel), and INTENT
 * (mod review, via `runForReal`). Conflating "may this context spend?" with "did the
 * caller ask to spend on THIS mint?" is what makes budgeted spend an implicit grant.
 * They are now separate:
 *
 *   - `spendEntitled`  — MAY this context spend? (a credential bit, or a runtime gate)
 *   - `spendRequested` — DID the caller ask to spend on THIS mint?
 *
 * BOTH are REQUIRED and NEITHER is DEFAULTED, deliberately. A default of `false`
 * would silently strip spend from every dev tunnel — including already-PERSISTED
 * tunnel sessions, whose `grantedScopes` are clamped once at write
 * (`dev-tunnel.service.ts` `startDevTunnel`). A default of `true` would re-create the
 * implicit grant for any future caller. Required parameters make the compiler force
 * every present and future call site to answer both questions explicitly.
 *
 * Deny is a STRIP, never an error: a `spendRequested: true` from a context that is
 * not entitled mints successfully WITHOUT the scope — erroring would add a new
 * failure mode on the money path, and every other step in this belt is a strip.
 */
export function clampDevScopes(opts: {
  scopeSource: string[];
  oauthAllowed: number | null;
  requestedScopes?: string[];
  /** MAY this context spend? (credential bit, or a runtime gate.) Required. */
  spendEntitled: boolean;
  /** DID the caller ask to spend on THIS mint? Required. */
  spendRequested: boolean;
  allowlist: ReadonlySet<string>;
}): string[] {
  const { scopeSource, oauthAllowed, requestedScopes, spendEntitled, spendRequested, allowlist } =
    opts;

  const forbidden = new Set<string>(PAGE_FORBIDDEN_SCOPES);

  let granted: string[] = scopeSource
    .filter((s) => isKnownBlockScope(s))
    .filter((s) => allowlist.has(s))
    .filter((s) => !forbidden.has(s));

  // OAuth-ceiling clamp (approved path ONLY). validateBlockScopesAgainstOauthClient
  // treats SKIP_OAUTH_CHECK scopes as always-allowed. SKIPPED when oauthAllowed is
  // null (pending / no-row / ephemeral — no client; passing 0 would wrongly strip
  // every non-skip scope).
  if (oauthAllowed !== null) {
    const ceiling = oauthAllowed;
    granted = granted.filter(
      (s: string) => validateBlockScopesAgainstOauthClient([s], ceiling).valid
    );
  }

  // Body narrowing — the caller may request a subset of the above.
  if (requestedScopes && requestedScopes.length > 0) {
    const want = new Set(requestedScopes);
    granted = granted.filter((s: string) => want.has(s));
  }

  // SPEND ceiling: the budgeted-spend scope survives ONLY when the context is
  // ENTITLED to spend AND the caller REQUESTED spend for this mint. Either alone is
  // insufficient — `&&`, never `||`. Read/catalog scopes are unaffected, and a
  // denied request is a silent strip (the mint still succeeds).
  if (!(spendEntitled && spendRequested)) {
    granted = granted.filter((s: string) => s !== 'ai:write:budgeted');
  }

  // Force-grant `user:read:self` (unconditional, post-clamp): a READ scope that
  // returns ONLY the self-bound caller's own profile. The token's `sub` is always
  // the authenticated caller (never the body), so this can only ever return the
  // caller's own identity — zero escalation, no new data surface.
  granted.push('user:read:self');

  // Dedup, deterministic order.
  return Array.from(new Set(granted)).sort();
}

/**
 * App Dev Tunnel — the SINGLE clamp for a dev-tunnel session's self-declared
 * (`block.manifest.json`) scopes: the fixed TUNNEL belt (no OAuth ceiling — a
 * pre-approval app has no OauthClient; `spendEntitled: true` / `spendRequested: true`
 * — see the PERMANENT note on the call below). Used by BOTH the SSR
 * `declaredScopes` surface (block-registry) AND the
 * on-site block-token mint, so the block's advertised `granted` set and the JWT's
 * actual scopes derive from ONE function and can NEVER drift apart. Idempotent —
 * safe to re-apply to an already-clamped stored set (defense-in-depth over the
 * clamp-at-write in `startDevTunnel`). NO `requestedScopes` narrowing: the tunnel
 * scope source is the AUTHENTICATED CLI's session, never a browser body, so there
 * is no legitimate browser-side narrowing input (and thus no body→source foot-gun).
 */
export function clampTunnelDeclaredScopes(scopeSource: string[]): string[] {
  return clampDevScopes({
    scopeSource,
    oauthAllowed: null,
    // 🔴 PERMANENTLY true/true — do NOT wire either of these to a request field.
    //
    // `spendEntitled: true` — the tunnel has no bearer ceiling; spend is bounded at
    // RUNTIME by the SELF-BOUND `sub` (a tunnel token can only ever spend its own
    // author's Buzz), the per-call `buzzBudget` claim, and the aggregate per-user /
    // per-app caps in `reserveBlockBuzzSpendForClaims`.
    //
    // 🔴 CORRECTED 2026-09-27 — this line used to name `assertViewerIsAppDeveloper(sub)`
    // as "the author-flag re-check" bounding spend here. No such call is on the
    // submit path; see the module header for the full correction. Do not restore it,
    // and do not treat it as an existing gate that a new mint path could widen.
    //
    // `spendRequested: true` — this path has NO request body to carry a per-mint
    // request. Starting a dev tunnel with a manifest that DECLARES
    // `ai:write:budgeted` *is* the request; `scopeSource` already carries that
    // declaration, so a manifest that does not declare the scope never reaches the
    // spend ceiling at all.
    //
    // Getting this wrong is not merely a future-mint bug: `startDevTunnel`
    // (dev-tunnel.service.ts) clamps ONCE at WRITE and PERSISTS the result as the
    // session record's `grantedScopes`. A `false` here would silently strip spend
    // from ALREADY-STORED live tunnel sessions, and no re-clamp could restore them.
    spendEntitled: true,
    spendRequested: true,
    allowlist: TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
  });
}

/**
 * Scopes never granted on the PRIVATE-RUN surface, whatever the audience.
 *
 * 🔴 `social:tip:self` IS THE THIRD BUZZ RAIL, AND IT IS THE REASON THIS SET EXISTS.
 * The private-run feature closes two money rails with signed-claim arms — the
 * `block_spend_attribution` void and the author-fee refusal. `social:tip:self` is
 * neither: `pages/api/v1/blocks/tip.ts` moves IRREVERSIBLE Buzz from the viewer to
 * any `toUserId` the block's OWN code names, performs no status check of its own, and
 * is not in `PAGE_FORBIDDEN_SCOPES` (which is empty). On a delisted app it is refused
 * today by exactly one thing: `resolveAppBlockApprovalVerdict` returning
 * `not_approved`. A private run has to widen that verdict to render at all — and that
 * widening admits this route in the same move. So the scope is stripped here, at the
 * mint, which is the belt the widening requires.
 *
 * ⚠️ IT IS ALREADY ABSENT FROM `TUNNEL_HOST_MINT_SCOPE_ALLOWLIST`, AND THAT IS NOT A
 * REASON TO DROP THIS STRIP. The private-run clamp composes the tunnel belt, so today
 * the strip is redundant — and a redundant guard that is the ONLY thing standing
 * between a delisted app and irreversible Buzz is the one to keep, because the
 * property it protects is not stated anywhere in the tunnel allowlist. Adding
 * `social:tip:self` to that allowlist for a dev-tunnel reason would otherwise silently
 * hand tipping to every private run, on apps the platform has taken down. The
 * redundancy is pinned by a test that asserts the strip survives even when the inner
 * clamp is mutated to pass the scope through.
 *
 * 🔴 `goods:purchase:self` is deliberately NOT listed: the sibling owner-crediting
 * rail is already closed on its own terms (it requires an approved block), so listing
 * it here would imply a protection this set is not providing.
 */
export const PRIVATE_RUN_FORBIDDEN_SCOPES: ReadonlySet<string> = new Set(['social:tip:self']);

/**
 * PRIVATE RUN — the SINGLE clamp for a private run of a delisted / suspended app.
 *
 * Three steps, in this order, and each is a STRIP rather than an error (a refusal
 * would be an existence oracle; a narrower token is not):
 *
 *   1. `clampTunnelDeclaredScopes(approvedScopes)` — VERBATIM, and the source is the
 *      `approved_scopes` COLUMN, never the re-published manifest. 🔴 THE LOAD-BEARING
 *      INVARIANT IS THE SAME ONE THE DEV-TUNNEL BRANCH RESTS ON: `approvedScopes` is
 *      written ONLY by the mod-approval flow, so a non-empty value means a moderator
 *      signed those scopes off at some point, and an app with `approvedScopes: []`
 *      mints a VALID token that can spend NOTHING — `clampTunnelDeclaredScopes([])`
 *      cannot invent `ai:write:budgeted`. A suspended publisher editing their manifest
 *      therefore cannot widen their own private-run token. Zero-scope is a legitimate
 *      state, not an error: such an app renders read-only rather than 403ing.
 *   2. `PRIVATE_RUN_FORBIDDEN_SCOPES` — the third-rail strip. See that set.
 *   3. The EDITOR read-only strip — see below.
 *
 * 🔴 STEP 3 IS AN OPERATOR DECISION TAKEN AGAINST THE ORIGINAL RECOMMENDATION, ON
 * REVERSIBILITY GROUNDS, AND IT IS THE ONE THING IN THIS FUNCTION MOST LIKELY TO BE
 * "TIDIED" BY SOMEONE WHO THINKS IT IS AN OVERSIGHT. An accepted collaborator
 * (`audience: 'editor'`) is READ-ONLY: `ai:write:budgeted` is stripped for them.
 * Moderators were granted full parity including capped spend with a stated reason —
 * reproduce generation-path abuse on a takedown. No equivalent reason was found for
 * collaborators, and the written product intent for the owner-iterating case is about
 * the OWNER. Parity is cheap to add later and expensive to remove later, so the narrow
 * option is the correct default until a concrete need appears. Widening is this one
 * branch plus one row in the access matrix.
 *
 * The failure mode is visible and reportable ("I can't run the generation"), never
 * silent — which is the other half of why the narrow option is safe to pick first.
 *
 * ⚠️ IF THIS STRIP IS EVER FORGOTTEN, AN EDITOR IS STILL REFUSED — but by the
 * author-fee arm, downstream, and only for that rail. Do not read the existence of
 * that backstop as making this strip optional: it does not bound the editor's OWN
 * Buzz spend, which is what `ai:write:budgeted` authorises.
 */
export function clampPrivateRunScopes(
  approvedScopes: string[],
  audience: 'owner' | 'editor' | 'moderator'
): string[] {
  // (1) The identical audited belt the dev-tunnel owned-non-approved branch uses.
  let granted = clampTunnelDeclaredScopes(approvedScopes);
  // (2) Third-rail strip — every audience, including the owner and moderators.
  granted = granted.filter((s) => !PRIVATE_RUN_FORBIDDEN_SCOPES.has(s));
  // (3) Editor read-only.
  if (audience === 'editor') {
    granted = granted.filter((s) => s !== 'ai:write:budgeted');
  }
  return granted;
}

/**
 * Extract a resolvable manifest page's declared per-generation Buzz budget
 * (`page.buzzBudgetPerGen`) for use as the DEV-token DEFAULT budget. Returns the
 * positive integer when the manifest declares a valid one, else `undefined` (the
 * caller then falls back to `DEV_BUZZ_BUDGET_DEFAULT`). Mirrors the host-mint's
 * manifest-budget read (`block-tokens/index.ts`): a fractional / NaN / Infinity /
 * non-positive / non-number value is IGNORED (→ undefined), never flowed through
 * as a budget. `resolveDevBuzzBudget` still clamps the result to
 * `DEV_BUZZ_BUDGET_CAP`, so a manifest can raise the dev default UP TO the cap but
 * never past it. Accepts the raw `manifest.page` value (already narrowed to a
 * non-null object by the dev-token endpoint's page-block gate, but re-guarded
 * here so this is safe to call on any input).
 */
export function parseManifestBuzzBudget(page: unknown): number | undefined {
  if (typeof page !== 'object' || page === null || Array.isArray(page)) return undefined;
  const raw = (page as { buzzBudgetPerGen?: unknown }).buzzBudgetPerGen;
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

/**
 * BUDGET CAP (dev-token.ts step 8). Only meaningful when `ai:write:budgeted`
 * survived the clamp. Resolve the effective per-call budget and clamp it to the
 * dev cap; `undefined` when no spend scope was granted.
 *
 * Precedence: an EXPLICIT caller-supplied `requestedBudget` (the CLI/body can
 * always ask for a specific budget) > the RESOLVED app manifest's
 * `page.buzzBudgetPerGen` (`manifestDefaultBudget`, present for the approved +
 * pending modes where a manifest is resolvable) > `DEV_BUZZ_BUDGET_DEFAULT` (the
 * flat platform floor, used only for the ephemeral no-row mode). The
 * `DEV_BUZZ_BUDGET_CAP` hard ceiling clamps the final value in EVERY case, so a
 * manifest can only ever raise the dev default UP TO the cap. This is what lets a
 * recipe/app whose `page.buzzBudgetPerGen` exceeds 50 be dev-tested without a
 * manual `buzzBudget` request (the flat-50 default previously rejected it with
 * `ceiling N exceeds budget 50`).
 */
export function resolveDevBuzzBudget(
  granted: string[],
  requestedBudget?: number,
  manifestDefaultBudget?: number
): number | undefined {
  return granted.includes('ai:write:budgeted')
    ? Math.min(
        requestedBudget ?? manifestDefaultBudget ?? DEV_BUZZ_BUDGET_DEFAULT,
        DEV_BUZZ_BUDGET_CAP
      )
    : undefined;
}

/**
 * SIGN (dev-token.ts steps 10–11). Reuse BlockTokenService.sign VERBATIM with the
 * PAGE ctx (entity=none, no model binding — byte-identical to the prod page mint so
 * a dev page token can NEVER satisfy a model-bound check), the forced-SFW ceiling,
 * a self-bound `userId`, the dev-capped budget, and `dev: true` (4h lifetime + the
 * `dev` claim the verifier keys the 4h max-age cap off).
 *
 * The `isPageSlot(PAGE_SLOT_ID)` assertion is defense-in-depth on a compile-time
 * constant (PAGE_SLOT_ID is always a page slot); it throws only on a build
 * misconfiguration, which the callers translate into a 500.
 */
export async function signDevScopedPageToken(opts: {
  userId: number;
  signBlockId: string;
  signAppId: string;
  signAppBlockId: string;
  blockInstanceId: string;
  granted: string[];
  buzzBudget: number | undefined;
  /**
   * MOD REVIEW SANDBOX "run for real" (#2831) marker. When true, stamps a
   * signed `reviewRunForReal: true` claim so the runtime spend paths
   * (submitWorkflow / customComfy) enforce the TIGHT per-(mod, publishRequestId)
   * aggregate Buzz ceiling instead of the ordinary per-user daily cap. The flag
   * is only trustworthy because it is inside the RS256-signed payload. Absent
   * (default) → byte-identical to a normal dev-scoped page token.
   */
  reviewRunForReal?: boolean;
}): Promise<Awaited<ReturnType<typeof BlockTokenService.sign>>> {
  const ctx: Record<string, unknown> = {
    slotId: PAGE_SLOT_ID,
    entityType: 'none',
  };
  if (!isPageSlot(PAGE_SLOT_ID)) {
    throw new Error('page slot misconfigured');
  }
  return BlockTokenService.sign({
    userId: opts.userId,
    blockId: opts.signBlockId,
    appId: opts.signAppId,
    appBlockId: opts.signAppBlockId,
    blockInstanceId: opts.blockInstanceId,
    scopes: opts.granted,
    ctx,
    buzzBudget: opts.buzzBudget,
    domain: null,
    maxBrowsingLevel: FORCED_SFW_CEILING,
    dev: true,
    ...(opts.reviewRunForReal === true ? { reviewRunForReal: true } : {}),
  });
}

/**
 * SIGN a PRIVATE-RUN page token — a delisted / suspended app's already-deployed
 * bundle, for its owner, an accepted collaborator, or a moderator.
 *
 * Structurally the dev signer above with the same PAGE ctx, the same forced-SFW
 * ceiling and the same self-bound `sub`. Three deliberate divergences, each of which
 * is a safety property rather than a preference:
 *
 * 🔴 1. `dev` IS NOT SET, AND IT MUST NEVER BE — THIS IS THE SHARPEST HAZARD ON THE
 * WHOLE FEATURE. `reserveBlockBuzzSpendForClaims` takes an EARLY RETURN on
 * `claims.dev === true` and skips the per-app velocity reservation (`reserveAppSpend`,
 * the G8 cap). A `dev` private-run token would therefore hand EVERY admitted viewer
 * an UNCAPPED per-app spend surface on an app the platform has taken down — the exact
 * inverse of what a takedown is for. The combination is refused in two more places
 * (`BlockTokenService.sign` throws on it, and the verifier rejects the pair), so this
 * is the third of three independent layers; none of them is load-bearing alone.
 *
 * 🔴 2. `privateRun: true` IS STAMPED, and it is a MONEY-SAFETY claim, not a UX one.
 * It is the only input the two money arms have: `recordSpendAttribution` voids the
 * `block_spend_attribution` row it would otherwise write as `tracked`, and
 * `resolveBlockAuthorFeePayee` refuses so the viewer-paid author fee is never quoted,
 * reserved or debited — which is what stops a moderator's wallet paying a suspended
 * publisher for the privilege of reviewing their own takedown.
 *
 * 🔴 3. `privateRunAudience` IS STAMPED, AND IT HAS A REAL CONSUMER — do not read it
 * as decoration. `resolveAppBlockApprovalVerdict` keys the private-run status
 * exemption on the PAIR (`privateRun === true` AND a recognised audience), exactly as
 * it keys the review-sandbox exemption on the `dev && reviewRunForReal` pair, and the
 * runtime editor read-only belt branches on the `'editor'` value. A signed field that
 * nothing branches on is not a guard; this one is branched on in both places.
 *
 * The budget is the dev-capped value: the per-call ceiling is the same
 * `DEV_BUZZ_BUDGET_CAP`, because a private run is no more entitled to a large single
 * submit than an author dogfooding their own app. The AGGREGATE ceiling is separate
 * and lives in `blocks.router.ts` (`PRIVATE_RUN_BUZZ_CAP`).
 */
export async function signPrivateRunPageToken(opts: {
  userId: number;
  signBlockId: string;
  signAppId: string;
  signAppBlockId: string;
  blockInstanceId: string;
  granted: string[];
  buzzBudget: number | undefined;
  audience: 'owner' | 'editor' | 'moderator';
}): Promise<Awaited<ReturnType<typeof BlockTokenService.sign>>> {
  const ctx: Record<string, unknown> = {
    slotId: PAGE_SLOT_ID,
    entityType: 'none',
  };
  if (!isPageSlot(PAGE_SLOT_ID)) {
    throw new Error('page slot misconfigured');
  }
  return BlockTokenService.sign({
    userId: opts.userId,
    blockId: opts.signBlockId,
    appId: opts.signAppId,
    appBlockId: opts.signAppBlockId,
    blockInstanceId: opts.blockInstanceId,
    scopes: opts.granted,
    ctx,
    buzzBudget: opts.buzzBudget,
    domain: null,
    maxBrowsingLevel: FORCED_SFW_CEILING,
    // 🔴 NO `dev: true`. See divergence 1 above. This is not an omission.
    privateRun: true,
    privateRunAudience: opts.audience,
  });
}
