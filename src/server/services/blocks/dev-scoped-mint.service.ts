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
 *                                            AIServicesWrite bit (`keyCanSpend`).
 *   2. `/api/v1/block-tokens` (Phase 2)   — COOKIE-authed author-own dev-tunnel
 *                                            branch, for the SSR dev host at
 *                                            `/apps/dev/<blockId>`. Uses
 *                                            `TUNNEL_HOST_MINT_SCOPE_ALLOWLIST`
 *                                            (WITHOUT apps:storage:* — Decision 1:
 *                                            App Storage stays 403 until approval)
 *                                            and passes `keyCanSpend: true` because
 *                                            there is no bearer ceiling; SPEND is
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
 * DELIBERATELY EXCLUDES `social:tip:self` (real money OUT) and
 * `block:settings:read` / `block:settings:write` (installer-only). A requested /
 * approved scope outside this set is STRIPPED (defense-in-depth).
 */
export const DEV_TOKEN_SCOPE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'models:read:self',
  'media:read:owned',
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
  'media:read:owned',
  'user:read:self',
  'ai:write:budgeted',
  // collections:* — INCLUDED here too (see DEV_TOKEN_SCOPE_ALLOWLIST rationale):
  // no per-app namespace, gated server-side by visibility/ownership/subject, so
  // there is no pre-approval collision to protect against (contrast
  // apps:storage:*, which this tunnel allowlist withholds until approval).
  'collections:read:self',
  'collections:write:self',
  'collections:read:private',
]);

/**
 * The MOD-REVIEW-SANDBOX host-mint allowlist (#2831 review preview). RENDER-ONLY:
 * the STRICTEST of the three allowlists. A mod runs UNAPPROVED, untrusted code
 * with their OWN session, so the review token must carry the minimum a block needs
 * to render — self-bound reads ONLY, NEVER money / private / cross-user / write.
 *
 * KEEP (render-only survivors, all self-bound reads):
 *   - `models:read:self`   the caller's own models (self-bound)
 *   - `media:read:owned`   the caller's own media
 *   - `user:read:self`     the caller's own identity (also force-granted post-clamp)
 *   - `collections:read:self` own-PUBLIC + any PUBLIC collection (no per-app namespace)
 *
 * WITHHELD (stripped regardless of what the pending manifest declares — the clamp
 * drops any scope not in this set, so none of these can EVER reach the review JWT):
 *   - `ai:write:budgeted`         real Buzz spend (ALSO stripped by keyCanSpend:false)
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
  'media:read:owned',
  'user:read:self',
  'collections:read:self',
]);

/**
 * The AUDITED scope clamp belt (dev-token.ts steps 7a–7g), extracted verbatim.
 * Start from `scopeSource` (the app's approved snapshot, an owned pending request's
 * un-reviewed `manifest.scopes`, or the caller's self-declared body scopes) and:
 *   a) keep only KNOWN block scopes,
 *   b) keep only scopes within `allowlist` (excludes social:tip:self +
 *      block:settings:* always; for the tunnel allowlist also apps:storage:*),
 *   c) keep only scopes within the app's OAuth ceiling (approved path only —
 *      `oauthAllowed !== null`); OMITTED for a pending / no-row / ephemeral app
 *      (no OauthClient — passing 0 would WRONGLY strip every non-skip scope),
 *   d) drop the PAGE_FORBIDDEN money/spend scopes (the page hard rule),
 *   e) if the body narrowed, intersect with the requested subset,
 *   f) BEARER-credential spend ceiling — strip `ai:write:budgeted` unless
 *      `keyCanSpend` (dev-token: the bearer's AIServicesWrite bit; host-mint:
 *      `true`, since spend is gated at runtime by the author-flag re-check),
 *   g) force-grant `user:read:self` (self-bound read of the caller's OWN identity).
 * Every step is a STRIP (no error). The belt is byte-identical across all callers
 * bar the allowlist + the OAuth-ceiling substitution.
 */
export function clampDevScopes(opts: {
  scopeSource: string[];
  oauthAllowed: number | null;
  requestedScopes?: string[];
  keyCanSpend: boolean;
  allowlist: ReadonlySet<string>;
}): string[] {
  const { scopeSource, oauthAllowed, requestedScopes, keyCanSpend, allowlist } = opts;

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

  // Bearer-credential (or runtime-author) spend ceiling: strip the budgeted-spend
  // scope unless the caller can spend. Read/catalog scopes are unaffected.
  if (!keyCanSpend) {
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
 * pre-approval app has no OauthClient; `keyCanSpend: true` — spend is gated at
 * RUNTIME by the author-flag re-check + the dev/session/day Buzz caps, not a bearer
 * here). Used by BOTH the SSR `declaredScopes` surface (block-registry) AND the
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
    keyCanSpend: true,
    allowlist: TUNNEL_HOST_MINT_SCOPE_ALLOWLIST,
  });
}

/**
 * BUDGET CAP (dev-token.ts step 8). Only meaningful when `ai:write:budgeted`
 * survived the clamp. Clamp the requested budget (or the default) to the LOWER dev
 * cap; `undefined` when no spend scope was granted.
 */
export function resolveDevBuzzBudget(
  granted: string[],
  requestedBudget?: number
): number | undefined {
  return granted.includes('ai:write:budgeted')
    ? Math.min(requestedBudget ?? DEV_BUZZ_BUDGET_DEFAULT, DEV_BUZZ_BUDGET_CAP)
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
  });
}
