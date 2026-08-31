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
 *                                            request); SPEND is
 *                                            instead gated at RUNTIME by
 *                                            `assertViewerIsAppDeveloper(sub)` on
 *                                            the token subject (blocks.router
 *                                            submitWorkflow) plus the per-call /
 *                                            per-session / per-day Buzz caps.
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
 *   - `buzz:read:self`            private financial (balance / ledger / earnings)
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
 *   - `apps:storage:shared:read|write` cross-user shared datastore — NEVER (invariant #2)
 *   - `collections:read:private`      third-party-reachable private data
 *   - `collections:write:self`        write surface not needed to evaluate a page app
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
    granted = granted.filter((s: string) => validateBlockScopesAgainstOauthClient([s], ceiling).valid);
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
    // `spendEntitled: true` — the tunnel has no bearer ceiling; spend is gated at
    // RUNTIME by `assertViewerIsAppDeveloper(sub)` (the author-flag re-check) plus
    // the per-call / per-session / per-day Buzz caps.
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
