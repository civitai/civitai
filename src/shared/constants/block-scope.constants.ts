/**
 * Block Scope — string scopes carried in block JWT claims, mapped to the
 * existing OAuth bitmask scopes for forward-compatibility.
 *
 * Single source of truth for block-scope → OauthClient.allowedScopes bit mapping.
 *
 * Block manifests declare which scopes their iframe needs. Two gates:
 *   1. Registration: the manifest's scope set must be a strict subset of
 *      the OauthClient's allowedScopes bitmask (per-bit).
 *   2. Token issuance: at /api/v1/block-tokens, the same check runs again
 *      to defend against post-approval manifest swaps (audit H-1 + C2).
 *
 * Block JWT scopes are a different concept from the underlying OAuth bits:
 * they're per-block-instance and short-lived (15min). The OAuth bit on the
 * publisher's app is the policy ceiling. A scope with `SKIP_OAUTH_CHECK`
 * (e.g. apps:storage:*) gates elsewhere — see the per-op server-side checks
 * (resolveStorageContext / resolveSharedContext).
 *
 * Forward-extensibility contract:
 *   - New block scopes MUST be added here with their OAuth-bit relationship.
 *   - A scope that intentionally has no bitmask requirement (e.g.
 *     apps:storage:*) uses the `SKIP_OAUTH_CHECK` sentinel — NOT a 0
 *     value. The sentinel is explicit so a future maintainer doesn't
 *     accidentally type 0 and get OAuth-allowlist bypass by surprise.
 */

import { TokenScope } from './token-scope.constants';
// 🔴 `import type`, NOT a value import, and the distinction is load-bearing for this
// module. `app-capabilities.constants` itself imports from `~/server/services/blocks/…`,
// so a VALUE import would pull a server path into a module this file's own header keeps
// deliberately dependency-free and which client code imports. A type-only import is
// ERASED at compile time and creates no runtime edge at all, so it buys the compile-time
// binding described at `PrivateRunAudience` below at zero graph cost.
import type { AppRole } from './app-capabilities.constants';

/**
 * Sentinel value for scopes that intentionally do not require an OAuth-bitmask
 * bit. The validator treats this as "approval gate elsewhere" (e.g. the
 * per-op server-side checks for apps:storage:*).
 */
export const SKIP_OAUTH_CHECK = Symbol('SKIP_OAUTH_CHECK');
export type ScopeBitmaskRequirement = number | typeof SKIP_OAUTH_CHECK;

export const BLOCK_SCOPE_TO_OAUTH_BIT: Record<string, ScopeBitmaskRequirement> = {
  'models:read:self': TokenScope.ModelsRead,
  // NOTE: there is intentionally NO `catalog:read` scope. The block catalog
  // endpoints (/api/v1/blocks/models, /api/v1/blocks/images) serve PUBLIC,
  // maturity-clamped data and accept ANY valid block token (withBlockScope with
  // no requiredScope) — they need the token only for its signed
  // `maxBrowsingLevel` claim, not for authorization. A `catalog:read` scope was
  // briefly added (#2671) and retired the next day: requiring a
  // declarable+grantable scope added friction (Go CLI manifest validator + each
  // app's OauthClient.allowedScopes bit) with no security value, since the
  // catalog is strictly MORE restricted than the public /api/v1/models.
  // NOTE: there is intentionally NO `media:read:owned` block scope. It was
  // declared/validated/mintable but had NO runtime consumer that ever checked
  // it (no block-token endpoint gated on it), so it was purely decorative and
  // was removed as part of the "every declared block scope is actually
  // enforced" hygiene pass. The underlying OAuth `TokenScope.MediaRead` bit is
  // UNCHANGED — it still backs ~80 tRPC media routes (image/post/comment/…) via
  // `requiredScope`; it simply no longer maps to a block scope.
  'user:read:self': TokenScope.UserRead,
  'ai:write:budgeted': TokenScope.AIServicesWrite,
  'buzz:read:self': TokenScope.BuzzRead,
  // NOTE: there is intentionally NO `block:settings:read` / `block:settings:write`
  // block scope. Both were declared/validated/mintable but NO runtime capability
  // ever verified them (the per-install settings read/write paths authorize on
  // valid-token + app-developer + installer-resolution, not on a token scope), so
  // they were purely decorative and were removed in the same hygiene pass. There is
  // no OAuth bit to orphan — they used SKIP_OAUTH_CHECK, not a TokenScope bit.
  'social:tip:self': TokenScope.SocialTip,
  // apps:storage:* — the W4 KV datastore. There is no OAuth bitmask bit for
  // per-app storage (it never touches the user's civitai resources via the
  // OAuth surface), so it uses SKIP_OAUTH_CHECK like block:settings:*. The
  // real gate is two-fold: (1) the scope must be in the block's
  // `approvedScopes` snapshot to be minted into the token, and (2)
  // `resolveStorageContext` asserts the scope is present on `claims.scopes`
  // per op (read vs write). Without this entry the scope was an *ambient*
  // capability — every approved block could read/write the KV store with no
  // declared/approved scope (audit A5 / design-gaps H4). Adding it here also
  // makes it a declarable manifest scope (the manifest validator rejects
  // unknown scopes, so previously a manifest *couldn't* even list it).
  'apps:storage:read': SKIP_OAUTH_CHECK,
  'apps:storage:write': SKIP_OAUTH_CHECK,
  // apps:storage:shared:* — the SHARED (app-global / cross-user) datastore. Same
  // no-OAuth-bit posture as apps:storage:* (never touches the user's civitai
  // resources via the OAuth surface). SKIP_OAUTH_CHECK; the real gate is
  // `resolveSharedContext` (apps-shared.router) which asserts the scope is present
  // per op AND runs the min-trust gate + the dedicated fail-closed Flipt flag.
  // DELIBERATELY kept OUT of BOTH dev-mint allowlists (DEV_TOKEN_SCOPE_ALLOWLIST,
  // TUNNEL_HOST_MINT_SCOPE_ALLOWLIST) — granted only to approved, mod-reviewed
  // apps that declare it, never to a pre-approval dev-tunnel/dev-token session.
  'apps:storage:shared:read': SKIP_OAUTH_CHECK,
  'apps:storage:shared:write': SKIP_OAUTH_CHECK,
  // collections:read:self / collections:write:self — the App Blocks Collections
  // surface (discover + read public collections and the viewer's OWN collections;
  // follow/bookmark a collection on the viewer's behalf). Same no-OAuth-bit
  // posture as apps:storage:* — these never touch the user's civitai resources
  // through the OAuth surface, so there is no bitmask bit; SKIP_OAUTH_CHECK makes
  // that explicit. The REAL gate is SERVER-SIDE and per-op:
  //   - read: collection VISIBILITY/OWNERSHIP — a private collection is 404 to a
  //     non-owner/contributor (existence-leak-safe), and item reads are clamped to
  //     the token's `maxBrowsingLevel` maturity ceiling;
  //   - write (follow): the token SUBJECT is the actor (self-bound), the block
  //     endpoint follows/unfollows on the caller's own behalf.
  // Both are additionally bound to a NON-ANON subject in the block-scope
  // middleware (self-scopes), and both are consent-exempt (server
  // visibility/ownership is the gate, not a per-scope consent prompt) — see
  // scope-grant.service.ts CONSENT_EXEMPT_SCOPES. Adding them here also makes them
  // declarable manifest scopes (the manifest validator rejects unknown scopes).
  'collections:read:self': SKIP_OAUTH_CHECK,
  'collections:write:self': SKIP_OAUTH_CHECK,
  // collections:read:private — the subject's OWN PRIVATE collections. Split out
  // from collections:read:self (which covers own-PUBLIC + any PUBLIC collection)
  // so that reading a user's PRIVATE collections requires an EXPLICIT per-user
  // consent grant. Same no-OAuth-bit posture (SKIP_OAUTH_CHECK; server enforces
  // ownership), and self-scope (non-anon subject) in the middleware. CRITICAL:
  // this scope is CONSENT-GATED — it is deliberately NOT in CONSENT_EXEMPT_SCOPES,
  // so it flows through partitionByConsent's gated set and the user must grant it
  // via the host consent gate before a token carries it (contrast read:self,
  // which is exempt and always mints). See scope-grant.service.ts.
  'collections:read:private': SKIP_OAUTH_CHECK,
  // posts:write:self — create a REAL Post on the VIEWER'S OWN profile from the
  // app's own generation outputs (`blocks.createPostFromApp` →
  // `CREATE_POST_FROM_APP`). This is the first block scope that writes PUBLIC,
  // feed-visible, reward-earning content under the viewer's name, so it is
  // deliberately the strictest-wired scope in the vocabulary:
  //
  //   - A REAL OAuth BIT, not SKIP_OAUTH_CHECK. `TokenScope.MediaWrite` is
  //     labelled "Upload media & create posts" and already backs the native
  //     `post.create` route, so the capability has a pre-existing bit and there
  //     is no reason to opt out of the ceiling. ⚠️ That ceiling is only a real
  //     gate for an OauthClient whose `allowedScopes` was DERIVED at approve
  //     (`deriveOauthBitmaskFromBlockScopes`); a client still carrying the DB
  //     default `33554431` (= TokenScope.Full) satisfies MediaWrite trivially.
  //     The load-bearing gates are the per-op server checks + the consent grant,
  //     exactly as for the SKIP_OAUTH_CHECK scopes — the bit is defence in depth.
  //   - SENSITIVE (see SENSITIVE_BLOCK_SCOPES) ⇒ a manifest declaring it MUST
  //     carry a non-empty `scopeJustifications` entry or submit is rejected.
  //   - CONSENT-GATED: deliberately NOT in CONSENT_EXEMPT_SCOPES
  //     (scope-grant.service.ts), so the user must grant it through the host
  //     consent modal before a token can carry it — same posture as
  //     `collections:read:private`, for a strictly more consequential capability.
  //   - :self ⇒ a non-anon subject is required in `enforceContextBinding`.
  //     There is no anonymous profile to post to.
  //
  // The scope is NOT the whole consent story: the host ALSO opens a per-post
  // chrome confirm rendering the host-resolved title / detail / tags / images /
  // gallery target, because the content differs every time and a blanket grant
  // cannot inform. See `createPostFromAppGate.ts`.
  'posts:write:self': TokenScope.MediaWrite,
  // goods:read:self — read the entitlements the VIEWER holds FROM THE CALLING
  // APP. Scoped to `claims.appBlockId` server-side, so an app can only ever see
  // what it sold: the reply is its own sales ledger filtered to one viewer, not
  // a view of the viewer's purchases elsewhere. CONSENT-EXEMPT for that reason
  // (the server-side app scoping is the gate, like the collections read
  // scopes), and :self ⇒ a non-anon subject.
  //
  // SKIP_OAUTH_CHECK: an app good is a platform-mediated entitlement that
  // touches none of the viewer's civitai resources through the OAuth surface,
  // so there is no bit to require. Same posture as `apps:storage:*` /
  // `collections:*`.
  'goods:read:self': SKIP_OAUTH_CHECK,
  // goods:purchase:self — SPEND the viewer's Buzz on a manifest-declared good.
  //
  //   - SENSITIVE ⇒ the manifest must justify it or submit is rejected.
  //   - CONSENT-GATED: deliberately NOT in CONSENT_EXEMPT_SCOPES. Money out of
  //     the viewer's balance always needs an explicit grant.
  //   - :self ⇒ non-anon subject; there is nobody to bill otherwise.
  //   - SKIP_OAUTH_CHECK for the same reason as the read half. Note this
  //     DIFFERS from `social:tip:self`, which maps to `TokenScope.SocialTip`:
  //     that bit is specifically "tip other users" and reusing it would let
  //     every app already approved to tip start selling goods. There is no
  //     app-goods bit, and minting one is a change to a bitmask persisted on
  //     every API key — out of proportion to a capability whose real gates are
  //     the approved-scope snapshot, the consent grant and the per-op check.
  //
  // PAGE-SAFE by BOUNDING, not by prohibition (so it stays off
  // PAGE_FORBIDDEN_SCOPES, like tipping): the price is review-gated and
  // hard-capped per purchase, and a per-user daily ceiling bounds the day.
  'goods:purchase:self': SKIP_OAUTH_CHECK,
  // apps:store:items:write — publish the VIEWER'S OWN app items into the App Store as
  // sub-listing cards under the calling app (`/api/v1/blocks/sub-listings/*`).
  //
  //   - SENSITIVE ⇒ the manifest must justify it: it writes something every store visitor
  //     sees, under the viewer's name.
  //   - CONSENT-EXEMPT, like `apps:storage:shared:write`: the real gates are server-side and
  //     per call, and a consent-gated scope would be dropped from tokens before any of them
  //     could run.
  //   - A non-anon subject is required (enforced in `enforceContextBinding`).
  //   - Minted by NO dev or review allowlist, so it only reaches an approved app's token.
  'apps:store:items:write': SKIP_OAUTH_CHECK,
} as const;

export type BlockScopeString = keyof typeof BLOCK_SCOPE_TO_OAUTH_BIT;

/**
 * The APP-STORAGE scope family — the one family whose runtime resolvers do NOT read
 * the claims `withBlockScope` already resolved, but re-verify the caller's RAW bearer
 * as a block JWS:
 *
 *   - `apps:storage:read` / `apps:storage:write`  → `resolveStorageContext`
 *     (`server/services/apps/app-storage.service.ts`) — `verifyBlockToken(blockToken)`.
 *   - `apps:storage:shared:read` / `…:shared:write` → `resolveSharedContext`
 *     (`server/routers/apps-shared.router.ts`) — `verifyBlockToken(blockToken)`, reached
 *     from eleven `/api/v1/blocks/shared-storage/*` routes that each pass `bearer(req)`
 *     back down after the middleware already verified it.
 *
 * `verifyBlockToken` requires a JWS with a `kid` it can pin, deliberately and strictly.
 * An `auth: "oauth"` app is minted an OPAQUE OAuth access token instead of a block JWT
 * (`/api/v1/block-tokens`, `mintOauthAppToken`), so that bearer is not a JWS and every
 * app-storage op 401s. `BlockManifestValidator` refuses the combination at submit time
 * for exactly this reason — see `oauthAppStorageConflictError`.
 *
 * DERIVED from the scope vocabulary above by prefix, never re-typed, so a fifth
 * `apps:storage:*` scope is covered the day it is added rather than silently exempt.
 * The derived membership is pinned (on growth AND shrink) by the
 * `APP_STORAGE_SCOPES (the auth:"oauth" conflict set)` suite in
 * `src/shared/constants/__tests__/block-scope.constants.test.ts` — if that ledger fails
 * because a new storage scope DOES read middleware-resolved claims, update the ledger and
 * this docblock in the same commit.
 *
 * The eleven routes and the four `verifyBlockToken` call sites have their OWN ledgers in
 * `src/server/middleware/__tests__/block-token-kind-app-storage-seam.test.ts`. When the
 * first of those empties out, this family stops needing the manifest refusal at all.
 */
export const APP_STORAGE_SCOPE_PREFIX = 'apps:storage:';
export const APP_STORAGE_SCOPES: readonly string[] = Object.keys(BLOCK_SCOPE_TO_OAUTH_BIT).filter(
  (scope) => scope.startsWith(APP_STORAGE_SCOPE_PREFIX)
);

/**
 * The app-storage scopes present in a manifest's declared `scopes`, in the order the
 * manifest declared them (so the error names them the way the author typed them).
 * Non-string entries are ignored — the per-element `scopes` validation upstream already
 * reports those, and this predicate must not turn one malformed entry into a second,
 * confusing error.
 */
export function appStorageScopesIn(scopes: readonly unknown[]): string[] {
  const storage = new Set(APP_STORAGE_SCOPES);
  return scopes.filter((scope): scope is string => typeof scope === 'string' && storage.has(scope));
}

/**
 * Does this manifest ask the host for an OAuth access token instead of a block JWT?
 * `auth` is optional and absent means `block-token` (see `RawManifest.auth`).
 *
 * 🔴 ONE definition, read by BOTH the runtime and the gate. The two mint paths branch on
 * this (`/api/v1/block-tokens` page mint at `manifestWantsOauthToken(block.manifest)`, and the
 * dev-tunnel mint), and `BlockManifestValidator` refuses `auth: "oauth"` alongside any
 * `APP_STORAGE_SCOPES` entry. If the gate and the mint ever disagreed about what
 * `auth: "oauth"` means, the gate would pass a manifest the runtime cannot serve — which is
 * the exact failure it exists to prevent.
 *
 * Lives HERE, in the client-safe shared module, rather than in
 * `~/server/services/blocks/block-oauth-scope` (which now RE-EXPORTS it, so its existing
 * callers and tests are untouched): `block-manifest-validator.service.ts` is imported by
 * `ManifestEditForm.tsx`, so everything it pulls in lands in the client bundle. Same reason
 * the SSRF hostname guards and the `repository` rule were extracted rather than imported
 * from a server module — see that file's import block.
 */
export function manifestWantsOauthToken(manifest: unknown): boolean {
  return (manifest as { auth?: unknown } | null | undefined)?.auth === 'oauth';
}

/**
 * MOD REVIEW SANDBOX "run for real" (#2831) — the AGGREGATE (session) Buzz
 * ceiling a moderator's OWN account can spend across ALL run-for-real
 * generations of ONE pending publish request. This is the number surfaced in
 * the loud consent copy ("…spends YOUR Buzz, capped at N…") AND the number the
 * server enforces as a per-(mod, publishRequestId) cumulative Redis reservation
 * in `blocks.router.ts` (see `reserveReviewRunForRealBuzzSpend`).
 *
 * SINGLE SOURCE OF TRUTH: defined HERE (a client-safe shared constants module)
 * so the server enforcement, the mint service, and the client consent dialog all
 * read the identical value — a low per-call `buzzBudget` alone is NOT sufficient
 * (a hostile app loops sub-budget calls; see `blocks.router.ts:594`), so this
 * cumulative ceiling is what actually bounds a run-for-real session.
 */
export const REVIEW_RUN_FOR_REAL_BUZZ_CAP = 5000;

/**
 * The audiences admitted to a PRIVATE RUN of a delisted / suspended app.
 *
 * 🔴 A CLOSED SET, AND THE ORDER OF POWER IS NOT THE ORDER LISTED. `moderator` has
 * full parity including capped spend; `owner` likewise (self-bound, as the existing
 * dev-tunnel precedent already is); `editor` — an ACCEPTED `AppCollaborator` seat —
 * is READ-ONLY by operator decision, delivered by stripping `ai:write:budgeted` in
 * `clampPrivateRunScopes`. Read that function, not this list, for what each audience
 * can actually do.
 *
 * Client-safe (this module is imported by client code), so the host chrome and the
 * server mint name the same three values.
 */
export const PRIVATE_RUN_AUDIENCES = ['owner', 'editor', 'moderator'] as const;

/**
 * 🔴 EVERY DECLARATION OF THIS UNION MUST IMPORT THIS TYPE, NEVER SPELL IT INLINE.
 *
 * Six sites originally hand-spelled `'owner' | 'editor' | 'moderator'` — the two clamp
 * and signer signatures, the two claim declarations, and two page props. The failure
 * that shape produces is in the UNSAFE direction and is invisible: widening
 * `PRIVATE_RUN_AUDIENCES` immediately widens `isPrivateRunAudience`, so the verifier
 * starts ADMITTING a fourth value into fields still typed to three. Claims are a JWT
 * payload with no compile-time binding, so `claims.privateRunAudience === 'editor'` in
 * the read-only belt still type-checks — and the new audience silently receives
 * owner/moderator treatment. That is precisely the failure the claim's own docblock
 * says it is guarding against; the verifier guard closes the FORGED case, and importing
 * this type is what closes the WIDENED one.
 *
 * It IS derived from the tuple above — see the next docblock for why that beat the
 * alternative. The property the predicate's audience bridge depends on is not the spelling
 * of this line but `AppRole` being a SUBSET of it, which `_appRoleSubsetWitness` asserts at
 * compile time; a future third `AppRole` is a COMPILE ERROR there rather than being
 * silently collapsed into `'editor'` — a collapse that would under-grant (safe) while
 * mislabelling the audit line and the chrome copy (not safe to leave unnoticed).
 *
 * ⚠️ THIS PARAGRAPH USED TO SAY "It is NOT derived from the tuple above directly. It is
 * `AppRole | 'moderator'`". That declaration was tried and REVERTED in the round-2 fixes,
 * for the reasons argued below — but the paragraph describing it survived, one line above
 * the code contradicting it, so a reader met two adjacent docblocks giving opposite
 * accounts of the same type. Worth naming rather than quietly deleting: the retraction is
 * the interesting half, and a docblock that describes a reverted design is indistinguishable
 * from one that is merely out of date.
 */
export type PrivateRunAudience = (typeof PRIVATE_RUN_AUDIENCES)[number];

/**
 * 🔴 `AppRole` MUST REMAIN A SUBSET OF `PrivateRunAudience`, ASSERTED AT COMPILE TIME.
 *
 * ⚠️ THE TYPE WAS BRIEFLY DECLARED AS `AppRole | 'moderator'` INSTEAD, AND THAT WAS
 * UNSOUND IN THE DANGEROUS DIRECTION — review caught it. Decoupling the type from the
 * tuple bought a compile error when `AppRole` GREW, and paid for it by making
 * `isPrivateRunAudience`'s `value is PrivateRunAudience` predicate a LIE: it tests
 * membership of the tuple, so adding a fourth member to the TUPLE alone made the guard
 * admit a value the type says cannot exist. Nothing type-errored — the narrowing at the
 * verifier laundered it — and downstream `=== 'editor'` is false for the new value, so
 * it would have received owner/moderator power with full spend. That is verbatim the
 * failure the decoupling was introduced to prevent, one direction over.
 *
 * So the type is DERIVED from the tuple again (the predicate is sound by construction),
 * and the `AppRole`-growth property is bought separately by this assignability
 * assertion, which costs one unused type and no runtime bytes. Both directions are now
 * compile-time:
 *   - `AppRole` grows  → this line errors (the new role is not in the tuple).
 *   - the tuple grows  → `PRIVATE_RUN_AUDIENCE_WITNESS` below errors, and the runtime
 *     lockstep test compares the two.
 */
type _AppRoleIsAPrivateRunAudience = AppRole extends PrivateRunAudience ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _appRoleSubsetWitness: _AppRoleIsAPrivateRunAudience = true;

/**
 * The BIDIRECTIONAL LOCKSTEP between the type and the tuple.
 *
 * ⚠️ THE DOCBLOCK ABOVE CLAIMED "the lockstep test below pins the two against each
 * other" BEFORE THIS EXISTED. That was a comment asserting a guarantee nothing provided
 * — the one class of defect this feature's review found most of — so it is made true
 * here rather than softened. It matters because the two can drift in BOTH directions and
 * only one of them is loud:
 *
 *   - `AppRole` grows (it gains a third role): the tuple no longer covers it, so
 *     `isPrivateRunAudience` would REJECT a legitimate audience. Caught by
 *     `_appRoleSubsetWitness` above, not by this literal — since the type is derived from
 *     the tuple, this literal's keys move with the tuple and cannot see that case.
 *   - The TUPLE grows without the type: `isPrivateRunAudience` starts ADMITTING a value
 *     the type says cannot exist, which is the unsafe direction — the verifier lets it
 *     through and the read-only belt's `=== 'editor'` silently treats it as an owner.
 *     🔴 CAUGHT TWICE, AND NEITHER HALF IS REDUNDANT — DO NOT DELETE EITHER. (a) AT COMPILE
 *     TIME BY THIS LITERAL: the type is derived from the tuple, so growing the tuple moves
 *     the type and `Record<PrivateRunAudience, true>` fails — TS2741 for ONE added member,
 *     TS2739 only at two or more. The mirror edit (a witness key the tuple lacks) fails
 *     instead as an excess property, TS2353. Codes measured against this repo's tsc 5.9.2.
 *     (b) AT RUNTIME BY THE HARDCODED TUPLE LEDGER at
 *     `src/server/middleware/__tests__/block-scope.private-run-claims.test.ts`, which
 *     asserts `PRIVATE_RUN_AUDIENCES` equals the three members literally.
 *
 *     🔴 (b) IS THE ONLY THING THAT CATCHES A TUPLE **AND** WITNESS WIDENING — that edit is
 *     typecheck-clean, so (a) is blind to it, and a widened tuple makes
 *     `isPrivateRunAudience` admit a value the read-only belt's `=== 'editor'` then treats
 *     as an owner. (b) also fails on a one-line tuple REORDER or a duplicate member, both
 *     typecheck-clean and both behaviour-preserving, because `toEqual` on an array is
 *     order-sensitive — so the guarantee is about WIDENING, not about mutations in general.
 *
 * 🔴 IT LIVES IN PRODUCTION CODE, NOT IN A TEST, AND THAT PLACEMENT IS THE POINT.
 * `tsconfig.json` EXCLUDES `src/**` `__tests__` directories, so a compile-time
 * exhaustiveness witness written in the sibling test file would never be typechecked and
 * would provide exactly nothing. Here it is checked by `pnpm typecheck` on every run.
 *
 * Exported so the test can compare against it rather than hand-copying the members —
 * a hand-copied expectation is how the first version of the matrix's completeness check
 * went stale.
 */
export const PRIVATE_RUN_AUDIENCE_WITNESS: Record<PrivateRunAudience, true> = {
  owner: true,
  editor: true,
  moderator: true,
};

/**
 * Membership test for the `privateRunAudience` token claim.
 *
 * 🔴 AN OWN-SET TEST OVER A FROZEN TUPLE, NOT an `in` on an object — the sibling
 * `isKnownBlockScope` used to use `in`, which walks the prototype chain and let 12
 * inherited `Object.prototype` keys through as "known". The claim arrives from a
 * VERIFIED token, but the verifier is what calls this, so it must not be the weak
 * link in its own guard.
 */
export function isPrivateRunAudience(value: unknown): value is PrivateRunAudience {
  return typeof value === 'string' && (PRIVATE_RUN_AUDIENCES as readonly string[]).includes(value);
}

/**
 * PRIVATE RUN — the AGGREGATE Buzz ceiling one viewer's OWN account can spend across
 * ALL private-run generations of ONE delisted app, over the reservation window
 * (~25h, re-armed on first write). Enforced as a per-(viewer, appBlockId) cumulative
 * Redis reservation in `blocks.router.ts` (see `reservePrivateRunBuzzSpend`).
 *
 * 🔴 TIGHTER THAN `REVIEW_RUN_FOR_REAL_BUZZ_CAP` (5000), ON PURPOSE. A run-for-real
 * review session is vetting an app the platform is deciding ABOUT; a private run is
 * of an app the platform has already TAKEN DOWN. The stricter posture is the correct
 * default for the second case, and it is cheap to widen later. The two values are
 * also deliberately DIFFERENT so a test asserting the private-run ceiling cannot
 * pass by accidentally reading the review one.
 *
 * SINGLE SOURCE OF TRUTH, defined in this client-safe module so the server
 * enforcement, the mint and any future consent copy read the identical value. A low
 * per-call `buzzBudget` alone is NOT sufficient — a hostile app loops sub-budget
 * calls — so this cumulative ceiling is what actually bounds a private-run session.
 */
export const PRIVATE_RUN_BUZZ_CAP = 2500;

/**
 * PLATFORM per-(USER, UTC-day) cumulative Buzz-spend ceiling across ALL the apps
 * a viewer has installed. The abuse ceiling nobody consents to — a per-call
 * `buzzBudget` alone cannot bound an app looping sub-budget submits, so this is
 * the aggregate that actually binds. Enforced in `blocks.router.ts`
 * (`reserveBlockBuzzSpend`, keyed WITHOUT appBlockId so N installed apps share
 * ONE ceiling rather than multiplying it).
 *
 * Lives HERE, in the client-safe shared module, because it is now read by three
 * places that must agree: the server enforcement, the `blocks.grantScopes` zod
 * bound on a user-set consent budget, and the consent dialog that shows the user
 * what the ceiling is. It is also the upper bound on
 * `app_user_scope_grants.buzz_budget_per_day` — a consent budget ABOVE the
 * platform cap could never bind, so storing one would be storing a number that
 * means nothing.
 */
export const BLOCK_BUZZ_CAP_PER_DAY = 50_000;

/**
 * Bounds for a user-set per-app consent budget
 * (`app_user_scope_grants.buzz_budget_per_day`). MIN is 1 rather than 0: a
 * budget of zero would be a way to consent to `ai:write:budgeted` and
 * simultaneously make it unusable, which is what DECLINING the scope already
 * expresses — so zero is rejected at the input rather than stored as a
 * confusing dead grant. Mirrored by the `app_user_scope_grants_buzz_budget_bounds`
 * CHECK constraint (migration 20260910120000).
 *
 * 🔴 MIN = 1 WAS RE-EXAMINED (audit round 1) AND DELIBERATELY KEPT. The objection
 * was that a floor of 1 lets a user store a budget that refuses every generation.
 * That is TRUE — 1 is below every registered per-engine ceiling — but it stopped
 * being a TRAP once the limit became editable: the budget is now rendered and
 * raise/lower/clearable on /apps/activity (`AppBudgetControl`), so a too-low value
 * is one click from recoverable IN the product, and the editor shows an explicit
 * warning below `BLOCK_CONSENT_BUDGET_LOW_WARN_PER_DAY` saying what a low number
 * does. Raising the floor instead would silently overrule a user who deliberately
 * wants a tiny allowance for a step-priced app (`convert-image` costs 1 Buzz), which
 * is a real and legitimate setting. Recoverability + a warning beats a floor that
 * decides for them.
 */
export const BLOCK_CONSENT_BUDGET_MIN_PER_DAY = 1;
export const BLOCK_CONSENT_BUDGET_MAX_PER_DAY = BLOCK_BUZZ_CAP_PER_DAY;

/**
 * The scope the per-app daily Buzz budget governs.
 *
 * ⚠️ IT IS NOT THE ONLY SCOPE THAT CAN SPEND THE VIEWER'S BUZZ, AND THIS LINE SAID IT WAS. The
 * digital-goods rail added `goods:purchase:self`, which also debits the viewer's balance — so a
 * superlative here is simply false, and replacing it with a narrower superlative would be the same
 * mistake one step along. The honest distinction is not "the only spender" but WHICH rail the
 * per-app budget bounds: this scope's spend is reserved against the budget the viewer sets per app,
 * while a goods purchase is bounded by its own per-USER daily cap and a per-purchase price ceiling
 * and never consults that budget. Both are consent-gated and both are revokable; only this one is
 * budgeted, which is exactly what the three surfaces below coordinate on.
 *
 * 🔴 THE CLIENT-SIDE HOME, AND IT REPLACES THREE LOCAL CONSTS RATHER THAN ADDING A FOURTH. Before
 * this, the literal `'ai:write:budgeted'` was declared privately in
 * `src/pages/apps/activity.tsx` (the budget editor), `src/components/AppBlocks/BlockConsentModal.tsx`
 * (the grant modal) and — added by phase 3 and then moved here —
 * `src/components/Apps/scopeRevoke.tsx` (the revoke dialog). Two of those carried a BYTE-IDENTICAL
 * name and doc sentence and neither knew about the other. All three now import this; no alias or
 * re-export is left behind, because a rename is not a consolidation (round 1 left
 * `export const SPEND_SCOPE = BLOCK_SPEND_SCOPE` in `scopeRevoke.tsx`, which preserved the exact
 * dependency edge the move existed to cut — the budget editor reading its spend-scope identity out
 * of the revoke feature).
 *
 * 🔴 WHY HERE AND NOT `scope-grant.service.ts`, which already owns `CONSENT_SPEND_SCOPE` with a
 * docblock making exactly this argument ("a string literal repeated at N sites is a predicate that
 * will be wrong at N−1 of them the first time the vocabulary moves"). That module imports
 * `dbRead`/`dbWrite`, so it is server-graph and no client surface can import it. This file is
 * client-safe, already owns the scope vocabulary (`isKnownBlockScope`, `SENSITIVE_BLOCK_SCOPES`)
 * AND already holds viewer-facing consent copy (`BLOCK_CONSENT_BUDGET_LOW_WARNING_BODY`), so it is
 * the one place both sides can reach.
 *
 * ⚠️ THE SERVER SIDE IS DELIBERATELY NOT COLLAPSED INTO THIS ONE, AND **NO COUNT OF THE REMAINING
 * COPIES IS QUOTED HERE** — because two successive attempts to quote one were both wrong, in the
 * same direction, and the second was wrong after being "corrected".
 *   · First: *"server 1 + client 1 = 2, down from server 1 + client 3 = 4"*. RETRACTED — it counted
 *     only NAMED declarations.
 *   · Then, on the reuse lane's measurement: *"5 declarations that own the literal, down to 4"*.
 *     ALSO RETRACTED. A direct enumeration of `'ai:write:budgeted'` across `src/` (excluding tests)
 *     returns roughly THIRTY live production uses — registry keys, `requiredScope:` values,
 *     `includes()` checks on minted scope sets, telemetry labels, description-map keys — spread over
 *     ~20 files. Two named constants and two `filter` calls is not the population.
 *
 * 🔴 THE REPO ALREADY OWNS THE RIGHT ANSWER AND IT IS A DERIVATION, NOT A NUMBER.
 * `scope-grant.service.ts` states it on the docblock above `CONSENT_SPEND_SCOPE`:
 * *"`git grep "'ai:write:budgeted'"` is the authority on what remains"* — and, importantly, that the
 * `scope:` arguments handed to `recordScopeInvocation` are TELEMETRY LABELS rather than gate
 * predicates, so they are deliberately literal and must not be swept. Any future consolidation
 * starts from that grep and that distinction; a figure restated here would be stale before the next
 * reader trusts it, which has now happened twice in one phase.
 *
 * What is true without a count: the two NAMED constants are this one and `CONSENT_SPEND_SCOPE`,
 * they are asserted equal by `src/components/Apps/__tests__/scopeConsentRows.test.ts`, and that
 * guard exists only because `scope-grant.service.ts` reaches Prisma and so cannot be imported from
 * a client surface. It can be deleted the moment `CONSENT_SPEND_SCOPE` becomes a re-export of this.
 *
 * 🔴 THE THREE SURFACES MUST AGREE OR THE BUDGET SILENTLY DETACHES FROM THE SCOPE IT BOUNDS: the
 * grant modal decides whether to offer a budget field, the budget editor decides what to send, and
 * the revoke dialog has to say that withdrawing this scope CLEARS the stored budget. A disagreement
 * is not a rendering bug, it is a spend path that stops being capped.
 */
export const BLOCK_SPEND_SCOPE = 'ai:write:budgeted';

/**
 * Pre-filled suggestion when a user turns a limit ON (consent modal + the editor on
 * /apps/activity). Deliberately far below the platform ceiling: the default should be
 * a limit, not a formality.
 */
export const BLOCK_CONSENT_BUDGET_DEFAULT_PER_DAY = 1000;

/**
 * Below this, the UI warns that the limit is low enough to refuse ordinary
 * generations. NOT a validation bound — anything from MIN up is storable and
 * enforced exactly as given.
 *
 * The number is the LOWEST per-engine post-paid ceiling any registered recipe
 * declares today: `STARTER_BUDGET.maxBuzz` = 90 and `seamless-pano`'s cheapest engine
 * (`zimage-turbo`) = 90. A budget under it cannot fund a single customComfy
 * generation, so an app using one will appear broken. Registry steps can be far
 * cheaper (`convert-image` = 1 Buzz), which is why this warns instead of blocking.
 * If a cheaper recipe engine is ever registered this number is free to drop — it
 * changes copy, never enforcement.
 */
export const BLOCK_CONSENT_BUDGET_LOW_WARN_PER_DAY = 90;

/**
 * The HIGHEST per-engine post-paid ceiling any registered recipe declares
 * (`seamless-pano`'s `qwen-image` = 180). Pinned to the registry alongside LOW
 * by `recipes/__tests__/budget-bounds-parity.test.ts`; read by no enforcement
 * path.
 *
 * 🔴 NOT RENDERED, AND NEITHER IS ITS LOW SIBLING. See
 * `BLOCK_CONSENT_BUDGET_LOW_WARNING_BODY` below for why the warning quotes no
 * figure at all. This constant exists solely so the parity test notices a
 * widening of the RECIPE range.
 */
export const BLOCK_CONSENT_BUDGET_HIGH_CEILING_PER_DAY = 180;

/**
 * The body of the low-budget warning, shared by the consent modal and the editor
 * on /apps/activity so the two cannot drift. The caller supplies the amount
 * before it and its own "you can change it" tail after it.
 *
 * 🔴 FIVE SUCCESSIVE WORDINGS OF THIS SENTENCE SHIPPED FALSE, EACH INTRODUCED BY
 * THE FIX FOR THE PREVIOUS ONE. In order: "this app will refuse to generate"
 * (false for step-priced apps) → "can cost up to 90 per run" (inverted the bound
 * over the engine set) → "the cheapest engine costs 90 per run" (quoted a
 * RESERVATION as a PRICE, 4.5–22.5× over) → "up to 180 on the priciest" (a CLOSED
 * bound the inline arm exceeds) → "and more on the other engines … step-based
 * actions still run" (two engines tie at 90, and steps do NOT always run).
 *
 * 🔴 SO THE RULE IS NOW STRUCTURAL, NOT A BETTER FORM OF WORDS: **this sentence
 * asserts no figure, and no claim about which actions still run.** Every such
 * claim was falsifiable because the reservation space has no short true
 * description —
 *   · recipe ceilings are 90, 90, 150, 180 (note the TIE — it falsified
 *     "more on the other engines", and the parity test cannot see it because
 *     `LOW === min(...)` holds for any number of ties);
 *   · the INLINE customComfy arm reserves an app-declared ceiling up to
 *     `INLINE_MAX_BUZZ` = 250, verbatim, un-dev-gated;
 *   · `textToImage` reserves its live whatIf quote, which can be far LOWER (the
 *     platform's own default per-generation budget is 10);
 *   · a STEP reserves `max(declaredBuzz, quotedBuzz)`, and `chat-completion`'s
 *     declared 1 is documented in `blocks.router.ts` as "that floor, not a
 *     price" — measured several times the constant, rising with `maxTokens`.
 *
 * ⚠️ A closed upper bound DOES exist, contrary to what an earlier revision of
 * this docblock asserted: every path gates the reservation against the token's
 * per-call budget, which `resolveBuzzBudget` clamps at `BUZZ_BUDGET_CAP` = 1000.
 * It is simply not renderable — it is per-app, ~4× the largest reservation any
 * path can actually take (INLINE_MAX_BUZZ = 250; 180 for recipes), and alarming
 * rather than informative. Do not "correct" the copy by naming it.
 *
 * What IS true on every consent-bearing path, and all this sentence claims:
 * the reservation is taken up front, before the run, and the request is refused
 * when the running per-UTC-day total exceeds the user's cap
 * (`consentBudgetExceeded`: `consent.total > consent.cap`).
 */
export const BLOCK_CONSENT_BUDGET_LOW_WARNING_BODY =
  'Buzz/day is a low limit. Each generation reserves Buzz up front, and is refused if that ' +
  'reservation exceeds your remaining limit for the day — so a low limit can make an app look ' +
  'broken.';

/**
 * Membership test against the authoritative scope vocabulary.
 *
 * 🔴 OWN-PROPERTY ONLY — deliberately `hasOwnProperty`, never `in`. `in` walks
 * the prototype chain, so `BLOCK_SCOPE_TO_OAUTH_BIT` being a plain object
 * literal made 12 inherited `Object.prototype` keys answer "known scope":
 * `__proto__`, `constructor`, `toString`, `valueOf`, `hasOwnProperty`,
 * `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, and the four
 * `__define*`/`__lookup*` accessors. Every caller treats a `true` here as
 * "this string is part of the fixed platform vocabulary" and several then read
 * `BLOCK_SCOPE_TO_OAUTH_BIT[scope]` expecting a number — for those keys that
 * read yields a FUNCTION.
 *
 * The registration-time manifest path was never reachable (its `SCOPE_RE`
 * requires at least one colon and rejects all 12 before this predicate runs),
 * so this is defense-in-depth for the paths that call the predicate on
 * untrusted runtime input WITHOUT a shape check first — notably the review
 * host's REQUEST_CONSENT notice, whose `payload.scopes` comes straight from
 * the reviewed app's own frame and whose filtered output is rendered into
 * moderator-facing text.
 *
 * `Object.prototype.hasOwnProperty.call(...)` rather than
 * `BLOCK_SCOPE_TO_OAUTH_BIT.hasOwnProperty(...)` so a future map that is
 * null-prototype or that ever declares its own `hasOwnProperty` key still works.
 */
export function isKnownBlockScope(scope: string): scope is BlockScopeString {
  return Object.prototype.hasOwnProperty.call(BLOCK_SCOPE_TO_OAUTH_BIT, scope);
}

/**
 * SENSITIVE block scopes — the subset of the vocabulary that carries elevated
 * privacy/financial risk to the VIEWER, and therefore warrants distinct,
 * warning-styled emphasis wherever scopes are surfaced (the mod review modal,
 * the consent/grant prompt, and the per-app "granted permissions" panels).
 *
 * A scope is sensitive when granting it lets the app do one of:
 *   - spend the viewer's Buzz          (`ai:write:budgeted`, `social:tip:self`)
 *   - read the viewer's Buzz balance   (`buzz:read:self`)
 *   - read the viewer's PRIVATE data   (`collections:read:private`)
 *   - write data OTHER users see       (`apps:storage:shared:write`,
 *                                       `posts:write:self`,
 *                                       `apps:store:items:write`)
 *
 * This set does two things. (1) PRESENTATION — it drives the distinct,
 * warning-styled emphasis wherever scopes are surfaced. (2) ENFORCEMENT — it
 * now also gates MANIFEST VALIDITY: at submit time the manifest validator
 * REQUIRES a non-empty `scopeJustifications` entry for every declared sensitive
 * scope (see `block-manifest-validator.service.ts`), so a moderator always sees
 * WHY an elevated-risk permission was requested. It does NOT change whether a
 * granted scope is enforced at call time — that stays with the server-side
 * per-op gates + consent grant. Keeping it a set (not a per-scope flag on the
 * map) keeps the enforcement map and this classification decoupled.
 *
 * INVARIANT (guarded by a test): every entry must be a currently-known scope in
 * `BLOCK_SCOPE_TO_OAUTH_BIT`. If a scope is renamed/removed (as
 * `media:read:owned` / `block:settings:*` were in #3212) it must be updated
 * here too, so a sensitive scope can never silently drop out of the set.
 */
export const SENSITIVE_BLOCK_SCOPES: ReadonlySet<string> = new Set([
  'ai:write:budgeted',
  'social:tip:self',
  'buzz:read:self',
  'collections:read:private',
  'apps:storage:shared:write',
  // Writes PUBLIC, feed-visible, reward-earning content under the VIEWER'S name.
  // The most consequential entry in this set: `apps:storage:shared:write` is
  // visible to other viewers OF THAT APP, this one is visible to the whole site
  // and carries the viewer's byline.
  'posts:write:self',
  // Spends the viewer's Buzz on an app's own catalog. The read half
  // (`goods:read:self`) is not sensitive — it returns only what the calling app
  // already sold to this viewer.
  'goods:purchase:self',
  // Writes store cards every visitor sees, under the viewer's name.
  'apps:store:items:write',
]);

export function isSensitiveBlockScope(scope: string): boolean {
  return SENSITIVE_BLOCK_SCOPES.has(scope);
}

/**
 * Manifest-shaped input for the sensitive-scope-justification gate. Only the two
 * fields the rule actually reads are needed, and both are `unknown` because
 * callers pass raw, not-yet-fully-validated manifests — the ZIP-extracted blob
 * at submit (`submitVersion`) and the stored/deep-validated manifest at
 * `validate`. Keeping the shape this loose is what lets ONE helper back both
 * enforcement sites.
 */
export type SensitiveScopeManifestInput = {
  scopes?: unknown;
  scopeJustifications?: unknown;
};

/**
 * Returns the DECLARED sensitive scopes that lack a non-empty
 * `scopeJustifications` entry (deduped, in declaration order). Empty when the
 * manifest is compliant, declares no sensitive scope, or has a non-array
 * `scopes`. A justification "counts" only when it is a string with non-whitespace
 * content — an empty/whitespace value, a non-string value, or a missing key all
 * leave the sensitive scope unjustified.
 *
 * SINGLE SOURCE OF TRUTH for the "sensitive scopes must be justified" rule: the
 * manifest validator (`validate`) and the submit path (`submitVersion`) both
 * call this so the two enforcement sites can never drift. Pure + client-safe.
 */
export function unjustifiedSensitiveScopes(manifest: SensitiveScopeManifestInput): string[] {
  if (!Array.isArray(manifest.scopes)) return [];
  const justifications =
    manifest.scopeJustifications &&
    typeof manifest.scopeJustifications === 'object' &&
    !Array.isArray(manifest.scopeJustifications)
      ? (manifest.scopeJustifications as Record<string, unknown>)
      : {};
  return [
    ...new Set(
      (manifest.scopes as unknown[])
        .filter((s): s is string => typeof s === 'string')
        .filter((scope) => isSensitiveBlockScope(scope))
        .filter((scope) => {
          const raw = justifications[scope];
          return !(typeof raw === 'string' && raw.trim().length > 0);
        })
    ),
  ];
}

/**
 * The exact operator-facing message both enforcement sites raise for an
 * unjustified sensitive scope. Single-sourced so the validator's
 * `errors.push(...)` string and `submitVersion`'s `throw` stay byte-identical.
 */
export function sensitiveScopeJustificationError(unjustifiedScopes: string[]): string {
  return `sensitive scopes require a justification — add a non-empty scopeJustifications entry for: ${unjustifiedScopes.join(
    ', '
  )}`;
}

/**
 * Throws (with `sensitiveScopeJustificationError`) when any declared sensitive
 * scope lacks a justification; a no-op when the manifest is compliant. This is
 * the imperative form used by `submitVersion` at submit time — the validator
 * uses `unjustifiedSensitiveScopes` directly so it can accumulate the message
 * into its `errors[]` alongside the other checks.
 */
export function assertSensitiveScopesJustified(manifest: SensitiveScopeManifestInput): void {
  const unjustifiedScopes = unjustifiedSensitiveScopes(manifest);
  if (unjustifiedScopes.length > 0) {
    throw new Error(sensitiveScopeJustificationError(unjustifiedScopes));
  }
}

/**
 * Validates that every requested block scope either declares no OAuth-bit
 * requirement (SKIP_OAUTH_CHECK) or has its OAuth bit set in the
 * OauthClient.allowedScopes bitmask.
 *
 * Returns `{ valid: true }` when all scopes pass, otherwise the list of
 * rejected scopes (unknown scopes plus scopes whose required bit is missing).
 */
export function validateBlockScopesAgainstOauthClient(
  blockScopes: string[],
  oauthClientAllowedScopes: number
): { valid: boolean; rejectedScopes: string[] } {
  const rejected: string[] = [];
  for (const scope of blockScopes) {
    if (!isKnownBlockScope(scope)) {
      rejected.push(scope);
      continue;
    }
    const requirement = BLOCK_SCOPE_TO_OAUTH_BIT[scope];
    if (requirement === SKIP_OAUTH_CHECK) continue;
    if ((oauthClientAllowedScopes & requirement) !== requirement) {
      rejected.push(scope);
    }
  }
  return { valid: rejected.length === 0, rejectedScopes: rejected };
}

/**
 * Deterministic id prefix every App-Blocks-provisioned OauthClient carries
 * (`appblk-<slug>`, set in publish-request.service.ts approveRequest). Genuine
 * developer-registered OAuth-apps clients use a uuidv4 id (oauth-client.router
 * create), so the prefix is a mutually-exclusive, migration-free discriminator
 * between the two client populations.
 *
 * SECURITY (audit A1/A2): App-block clients exist ONLY to be the policy ceiling
 * for block-token minting — they must never participate in the interactive
 * authorization_code / device OAuth flows (that path mints a real account
 * Bearer token). Every OAuth-provider surface that could turn one of these rows
 * into an account-takeover primitive gates on this predicate. The gate is
 * scoped to `appblk-` rows ONLY — the legitimate OAuth-apps feature
 * (uuid-id `oauth_app` clients) is left byte-for-byte unaffected.
 */
export const APP_BLOCK_OAUTH_CLIENT_ID_PREFIX = 'appblk-';

export function isAppBlockOauthClientId(clientId: string | null | undefined): boolean {
  return typeof clientId === 'string' && clientId.startsWith(APP_BLOCK_OAUTH_CLIENT_ID_PREFIX);
}

/**
 * Derive the OAuth-bitmask ceiling an app-block OauthClient should carry from
 * its manifest's declared block scopes. App-block clients must NOT default to
 * `TokenScope.Full` (audit A1/A3/A4) — that made the auto-provisioned client a
 * Full-scope authorization_code client and rendered the manifest scope gate
 * inert (any manifest scope was always within the all-bits ceiling).
 *
 * The bitmask is the OR of the OAuth bits each known scope maps to. Scopes
 * with `SKIP_OAUTH_CHECK` (apps:storage:*) and unknown
 * scopes contribute nothing — they are gated by other mechanisms, not the
 * OAuth bitmask. Result is therefore the *intersection* of the manifest with
 * the OAuth-eligible scope set, exactly what the validator / token-mint path
 * expects as the per-client ceiling.
 */
export function deriveOauthBitmaskFromBlockScopes(blockScopes: string[]): number {
  let bitmask = 0;
  for (const scope of blockScopes) {
    if (!isKnownBlockScope(scope)) continue;
    const requirement = BLOCK_SCOPE_TO_OAUTH_BIT[scope];
    if (requirement === SKIP_OAUTH_CHECK) continue;
    bitmask |= requirement;
  }
  return bitmask;
}
