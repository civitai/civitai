import type { SessionUser } from '~/types/session';
import { isFlipt, isFliptSync } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import {
  recordStoreScopeDivergence,
  recordStoreScopeResolution,
} from '~/server/prom/store-scope.metrics';
import { buildFliptContext } from '~/server/services/feature-flags.service';
import type { ListingAudienceFloor } from '~/shared/utils/app-listing-visibility';
import {
  narrowStoreScope,
  type StoreVisibilityScope as StoreVisibilityScopeValue,
} from '~/shared/utils/store-visibility-scope';

const APP_BLOCKS_FLAG = 'app-blocks-enabled';

/**
 * 🔴 GLOBAL-EVAL SEMANTICS — read this before writing "fail-closed" anywhere in
 * this file. Several docblocks below used to say, in one wording or another:
 *
 *     "no user → a global eval that can never match a segment → fail-closed"
 *
 * The premise is TRUE and the conclusion DOES NOT FOLLOW FROM IT. A no-user call
 * reaches Flipt as entityId `'global'` with an empty context, and every identity
 * / tier / cohort segment we have is a `STRING_COMPARISON_TYPE` constraint that
 * reads the CONTEXT, so none of them can match — that much is right. But when no
 * rollout matches, Flipt answers with the flag's own base `enabled` value. The
 * denial therefore comes from the BASE BEING FALSE, not from the segment miss.
 *
 * MEASURED against the real `@flipt-io/flipt-client-js` wasm engine over a real
 * evaluation snapshot (`app-blocks-flag.base-enabled-flip.test.ts`):
 *
 *   base `enabled: true`  + a non-matching SEGMENT_ROLLOUT, no entityId/context → **true**
 *   base `enabled: false` + the same rollout,                no entityId/context → **false**
 *   unknown flag key,                                        no entityId/context → **false**
 *
 * So the two claims that ARE unconditional, and the only ones worth calling
 * fail-safe without a qualifier, are:
 *   - an ABSENT flag evaluates `false` (the eval throws; `isEnabled` catches → `false`), and
 *   - an UNREACHABLE Flipt evaluates `false` (`isEnabled` returns `false` on a null client).
 * A "the segment can't match, so it's closed" claim is conditional on the base
 * value and must say so. (`FLIPT_LOCAL_OVERRIDES` is a third route to `true` with
 * no user, but it is hard-disabled when `NODE_ENV === 'production'`.)
 *
 * Practical consequence for every no-user branch in this file: it is a request to
 * read the flag's BASE, nothing more. Where that is what the caller means (the
 * machine/pipeline/runtime gates, the deliberate anonymous-public widening on
 * `app-listings-public-external`) the branch is correct and load-bearing. Where
 * the caller means "deny — there is no subject", the branch must say `false`
 * itself; `isAppBlocksAuthorEnabled` is the one that does.
 *
 * ⚠️ SECOND, UNRELATED READING TRAP IN THIS FILE: most docblocks below carry a
 * sentence of the form "the flag does NOT exist in Flipt at merge time / yet".
 * Each was an AS-MERGED note written by the PR that added that flag, so each is a
 * claim about the day it was written — and flags get created and widened after
 * merge, which is the whole point of shipping dark. Those sentences are history,
 * not live state, and the "so the as-merged posture is dark" conclusions they
 * support expire with them. Never plan on one, and do not replace one with a
 * fresher enumeration here — this file cannot hold live flag state without
 * becoming the same trap. Read the definitions from `civitai/flipt-state`
 * (`civitai-app/default/features.yaml`); the live answer is Flipt itself.
 */

/**
 * Dedicated App Store VISIBILITY flag (W13 — PR-W1a / D8).
 *
 * DECOUPLES the App Store *catalog visibility* from `app-blocks-enabled`, which
 * doubles as the BLOCK-RUNTIME kill-switch. The store-visibility surfaces (the
 * `/apps` store SSR gate + landing, the store DETAIL page, the store grid query,
 * and the PUBLIC store read procs) key off THIS flag so the catalog can widen to
 * `public` INDEPENDENTLY of the deliberately-held block-runtime GA — a future
 * true-public flip widens ONLY `app-listings`, while `app-blocks-enabled` (the
 * runtime gate) stays mod-segmented.
 *
 * Mirrors the `appListings` entry in feature-flags.service.ts
 * (`availability: ['mod']`, `fliptKey: 'app-listings'`). The flag does NOT exist
 * in Flipt at merge time — it is created AFTER (a companion `flipt-state` PR)
 * with the SAME mods + `app-dev-testers` segment `app-blocks-enabled` uses.
 */
export const APP_LISTINGS_FLAG = 'app-listings';

/**
 * Dedicated flag for the App Blocks AUTHOR capability (developer soft-launch,
 * Phase B). Grants the right to SUBMIT apps + use `dev:live` (mint a dev token,
 * generate/spend from your own block) to a curated cohort — INDEPENDENT of the
 * mod-only marketplace-visibility flag (`app-blocks-enabled`).
 *
 * WHY A SEPARATE FLAG: `app-blocks-enabled` gates marketplace VISIBILITY and
 * widens to `public` at GA. Authoring must stay independently gated (we do NOT
 * want every user able to author when the marketplace goes public), so the
 * author authz decision keys off THIS flag, never `app-blocks-enabled`.
 *
 * Mirrors the `appBlocksAuthor` entry in feature-flags.service.ts
 * (`availability: ['mod']`, `fliptKey: 'app-blocks-author'`). Create it in Flipt
 * as base `enabled: false` with the `moderators` segment PLUS the author cohort
 * segment (e.g. `app-dev-testers`), exactly like `app-blocks-enabled`, so mods +
 * the cohort resolve `true` and everyone else `false`.
 */
export const APP_BLOCKS_AUTHOR_FLAG = 'app-blocks-author';

/**
 * Dedicated GLOBAL flag for the build/publish/deploy PIPELINE (Decision 1).
 *
 * The user-facing `app-blocks-enabled` flag is base `enabled: false` with a
 * `moderators` segment, so it only ever resolves `true` when evaluated WITH a
 * moderator's context. The machine/pipeline webhooks have no user context and
 * eval globally, so they could never pass that flag — the build/publish chain
 * was permanently dark (build-callback 503, no mod-approved block could deploy).
 *
 * This separate global flag lets "can the pipeline run" move independently of
 * "can users see blocks". It is evaluated globally (entityId='global', empty
 * context), so it must be a plain base-`enabled` boolean (NOT segmented) to turn
 * on. The flag does not exist yet — it is created in Flipt AFTER this merges, so
 * the as-merged behaviour is unchanged: a missing flag → `isFlipt` returns
 * `false` → the pipeline stays dark (the fail-safe invariant below).
 */
export const APP_BLOCKS_PIPELINE_FLAG = 'app-blocks-pipeline-enabled';

/**
 * Dedicated GLOBAL flag for the RUNTIME token-verification surface (Decision 4).
 *
 * Two runtime sites verify ALREADY-MINTED block JWTs for *deployed* blocks:
 *   - the JWKS public-key endpoint (`/api/v1/block-tokens/jwks`), and
 *   - the `withBlockScope` middleware (verifies a block JWT on scoped REST calls).
 *
 * Both used to call the no-arg (global) `isAppBlocksEnabled()` → the GLOBAL eval
 * of the mod-segmented `app-blocks-enabled` user flag, which can never match the
 * `moderators` segment without a user context → resolves `false` globally → the
 * verification surface was permanently dark. So even with builds/deploys lit, a
 * deployed block's issued JWTs could not be verified at runtime.
 *
 * ## Why a GLOBAL runtime flag is correct AND safe (no widening)
 *
 * VERIFICATION confers NO authority — it only re-validates a token the
 * independently-gated MINT endpoint already issued, reproducing exactly the
 * scopes mint embedded (after the manifest / approved-snapshot / consent /
 * anon-strip pipeline). `verifyBlockToken` is kid-pinned, RS256-only,
 * iss/aud-checked, max-age-bounded, and the signing key is server-private, so a
 * token cannot be forged or scope-inflated. The ONLY production caller of the
 * signer is the mint endpoint (`POST /api/v1/block-tokens`), which is the real
 * authorization boundary: it gates per-user on `app-blocks-enabled` WITH the
 * request user's context and decides which scopes (if any) a caller gets.
 * Therefore turning verification on globally CANNOT let an unauthorized party in
 * — there is no unauthorized path to obtain ANY verifiable token in the first
 * place. The runtime flag only says "the block-JWT verification subsystem is
 * active." (NB: do NOT rely on "only mods can mint" — the mint path has an
 * anonymous-conversion branch that issues a `sub:'anon'` token with the
 * consent-EXEMPT scope subset when the mint flag is on for anon. The safety
 * property is "verification grants nothing mint didn't already grant," NOT
 * "mod-only minting" — keep that distinction if the mint flag is ever widened.)
 *
 * ## Why NOT reuse the pipeline (build) flag
 *
 * Pausing builds — flipping `app-blocks-pipeline-enabled` off — must NOT kill
 * live blocks' runtime token verification. Decoupling runtime onto its own flag
 * means "stop the build/publish machine" and "stop verifying deployed blocks'
 * tokens" are independent levers.
 *
 * Fail-safe: if `app-blocks-runtime-enabled` does not exist (it is created in
 * Flipt only AFTER this merges) or Flipt is unreachable, `isFlipt` returns
 * `false` → the runtime sites stay dark (JWKS 503; `withBlockScope` treats a
 * present block JWT as ABSENT and falls through to legacy auth). That is the
 * SAME dark behaviour these sites already have on the user flag today, so the
 * as-merged change cannot regress the gate open.
 */
export const APP_BLOCKS_RUNTIME_FLAG = 'app-blocks-runtime-enabled';

/**
 * Server-side check for the App Blocks feature flag.
 *
 * ## Three-axis flag model
 *
 * App Blocks is gated by THREE independent flags, each for a different surface:
 *   - `app-blocks-enabled` — USER VISIBILITY. Base `enabled: false` with a
 *     `moderators` segment; resolves `true` only when evaluated WITH a mod's
 *     context. Governs the UI mount, the tRPC gates, token ISSUANCE (mint), and
 *     listForModel. (This function — `isAppBlocksEnabled`.)
 *   - `app-blocks-pipeline-enabled` — BUILD/PUBLISH PIPELINE (Decision 1, #2536).
 *     Global flag for the machine webhooks (`build-callback`, `git-push`,
 *     `workflow-completed`). (`isAppBlocksPipelineEnabled`.)
 *   - `app-blocks-runtime-enabled` — RUNTIME TOKEN VERIFICATION (Decision 4).
 *     Global flag for verifying ALREADY-MINTED block JWTs for deployed blocks:
 *     the JWKS endpoint and the `withBlockScope` middleware.
 *     (`isAppBlocksRuntimeEnabled`.)
 *
 * The UI mount, the workflow-completed callback, every write endpoint, every
 * token-issuance path, and listForModel all gate on this flag. When the flag
 * is off:
 *   - BlockSlot renders nothing (handled in `useFeatureFlags()` path).
 *   - listForModel returns an empty list.
 *   - Token issuance returns 503.
 *   - JWKS returns 503 (no public key surface during pre-launch).
 *   - withBlockScope-wrapped routes treat a block JWT as if it weren't there
 *     (falls through to legacy auth path, never validates the token).
 *   - Mutations on the blocks router return UNAUTHORIZED.
 *
 * ## Per-user vs. global evaluation (H2)
 *
 * The live Flipt flag is base `enabled: false` with a `moderators` segment
 * (`isModerator == "true"`). To resolve `true` for a moderator, the eval MUST
 * carry that user's context — otherwise the segment can never match and the
 * flag is off for everyone, including mods.
 *
 * - **User-facing gates** (the tRPC `enforceAppBlocksFlag` middleware, the
 *   mod-only `submit-version` upload) have the request's SessionUser, so they
 *   pass `{ user }` here. The flag is then evaluated with the SAME entityId +
 *   context the client gate (`getFeatureFlags`/`buildFliptContext`) uses, so
 *   client and server can't diverge: a mod gets the feature server-side too,
 *   while a non-mod / anon user still resolves `false` (the no-widening
 *   invariant — the segment only matches `isModerator == "true"`, and we use
 *   the SERVER-side `user.isModerator`, never a client-supplied value).
 *
 * - **Machine-to-machine / anonymous gates have NO user** and genuinely cannot
 *   evaluate a mod-segmented flag. They eval globally (`entityId='global'`,
 *   empty context), which can never match the `moderators` segment. They split
 *   into two groups:
 *
 *   1. The build/publish **PIPELINE** webhooks (`build-callback`, `git-push`,
 *      `workflow-completed`) gate on the dedicated global
 *      `app-blocks-pipeline-enabled` flag via `isAppBlocksPipelineEnabled()`
 *      (Decision 1). This decouples "can the pipeline run" from the
 *      mod-segmented user flag, so a mod-approved block can actually build and
 *      deploy without globally enabling the user-facing feature.
 *
 *   2. The JWKS public-key endpoint and the `withBlockScope` token-verification
 *      middleware (RUNTIME, not build) gate on the dedicated global
 *      `app-blocks-runtime-enabled` flag via `isAppBlocksRuntimeEnabled()`
 *      (Decision 4). This decouples "verify deployed blocks' tokens" from both
 *      the mod-segmented user flag AND the build pipeline flag, so pausing
 *      builds can't kill live runtime verification.
 *      The JOB_TOKEN-authed manifest registrar (`block-manifests`) is DORMANT
 *      (no live caller) and stays on the no-arg `isAppBlocksEnabled()` for now
 *      (publish-adjacent, not runtime — out of Decision 4's scope).
 *
 *   For all machine gates, do NOT fabricate user context (the no-arg overload
 *   below, and the pipeline helper, preserve the global-eval behaviour).
 *
 *   🔴 The no-user branch here is a request for `app-blocks-enabled`'s BASE
 *   value, not a guaranteed deny. It is KEPT — unlike `isAppBlocksAuthorEnabled`,
 *   whose `user` parameter is REQUIRED — and the reason is SEMANTIC, not a head
 *   count of callers. This flag is a KILL-SWITCH: it answers "is the feature on
 *   at all", a question a subject-less machine path can legitimately ask, and the
 *   flag's base value IS that answer. `app-blocks-author` is a CAPABILITY: it
 *   answers "may THIS subject author", which is unanswerable without a subject,
 *   so there the absence of one is a type error rather than a `false`.
 *
 *   (The only no-arg call site is `pages/api/v1/developer/block-manifests.ts` —
 *   the JOB_TOKEN manifest registrar, which is DORMANT: nothing in this repo
 *   outside tests and docs invokes that endpoint. Do not rest the asymmetry on
 *   that caller existing; rest it on the kill-switch/capability distinction
 *   above, which survives the endpoint being deleted.)
 *
 *   The consequence to hold on to: at a base-`enabled: true` GA flip every
 *   no-user caller of THIS helper starts passing. That is the intended reading
 *   for a kill-switch, and it is why the identity-shaped callers must not route a
 *   missing subject through it — see GLOBAL-EVAL SEMANTICS at the top of this
 *   file, and `block-token-access.service.ts::assertAppBlocksEnabledForTokenUser`,
 *   which refuses an unhydratable subject before it gets here. (That helper lived
 *   in `blocks.router.ts` until 2026-09-18; it moved to a service so the REST
 *   route `/api/v1/blocks/me` could share the one implementation.)
 *
 * The FLAG_OVERRIDE/local-overrides env exists for unit tests + local dev that
 * need to flip the flag without standing up Flipt.
 */
export async function isAppBlocksEnabled(opts?: { user?: SessionUser }): Promise<boolean> {
  // No user supplied → preserve the original global eval for the machine /
  // anonymous gates (webhooks, JWKS). Their callers are unchanged. This returns
  // the flag's BASE value, so it opens at a base-`enabled` flip — deliberate for
  // a kill-switch, NOT a deny. See GLOBAL-EVAL SEMANTICS at the top of this file.
  if (!opts?.user) {
    return isFlipt(APP_BLOCKS_FLAG);
  }

  // Per-user eval: reuse the client gate's context builder so the two gates
  // share one context shape and can't drift. entityId is the user id (matching
  // `getFeatureFlags`'s `hasFeature` Flipt call); context carries the
  // server-side `isModerator` that the `moderators` segment keys on.
  const user = opts.user;
  return isFlipt(APP_BLOCKS_FLAG, String(user.id), buildFliptContext(user));
}

/**
 * Server-side check for the App Store VISIBILITY flag (W13 — PR-W1a / D8).
 *
 * Gates the STORE-VISIBILITY surfaces only — the public store read procs
 * (`appListings.listAvailable` / `getAppDetail`), reached via the
 * `enforceAppListingsReadFlag` middleware. This DECOUPLES store catalog
 * visibility from `app-blocks-enabled`, which doubles as the block-runtime
 * kill-switch, so the catalog can widen to public independently of the held
 * block-runtime GA.
 *
 * ## Eval shape mirrors `isAppBlocksEnabled`, WITH an OR-fallback (load-bearing)
 *
 * Same per-user Flipt eval as `isAppBlocksEnabled` (entityId = user id, context
 * from `buildFliptContext`) against the dedicated `app-listings` flag. The ONE
 * difference: if `app-listings` resolves `false`, this FALLS BACK to
 * `isAppBlocksEnabled(opts)`. That fallback is the whole point of the dark
 * decoupling:
 *   - The `app-listings` flag did NOT exist in Flipt when this merged (it was
 *     created AFTER, as a companion `flipt-state` PR). A bare eval of an absent
 *     flag resolves `false` for EVERYONE — which would have REGRESSED the
 *     then-visible cohort (mods + the `app-dev-testers` segment of
 *     `app-blocks-enabled`) the instant this merged. The OR-fallback to
 *     `app-blocks-enabled` preserved their store access verbatim through that
 *     transition window. (Past tense on purpose: this is an as-merged note, not
 *     live state — see the reading trap at the top of this file. The paragraph
 *     below says what closes this TODAY.)
 *   - Because `app-blocks-enabled` already grants the mods + app-dev-testers
 *     cohort today, `isAppListingsEnabled` grants EXACTLY that same set until the
 *     `app-listings` flag is created and later widened — so the as-merged change
 *     is a NO-OP on visibility (zero behavior change today).
 *
 * Remove the `|| isAppBlocksEnabled` fallback ONLY after the store widens past
 * the `app-blocks-enabled` cohort (i.e. once `app-listings` is the sole, wider
 * source of truth); until then the fallback is what keeps existing viewers in.
 *
 * No user → a global eval of `app-listings`, then a fall-through to the no-arg
 * `isAppBlocksEnabled()` global eval. That is byte-identical to the pre-existing
 * no-arg store-read behaviour, which is why it is kept. It is NOT unconditionally
 * fail-closed: both evals return their flag's BASE value, so a base-`enabled`
 * flip of either key opens the anonymous store read. Both are base-`false` today
 * with segment rollouts, which is the whole of what makes this dark. See
 * GLOBAL-EVAL SEMANTICS at the top of this file.
 */
export async function isAppListingsEnabled(opts?: { user?: SessionUser }): Promise<boolean> {
  const user = opts?.user;
  // Per-user eval of the dedicated visibility flag — same entityId + context
  // shape as isAppBlocksEnabled, so the `app-listings` segment resolves
  // identically to the client/hasFeature gate.
  const listingsOn = user
    ? await isFlipt(APP_LISTINGS_FLAG, String(user.id), buildFliptContext(user))
    : // No user → global eval, i.e. the flag's BASE value (not a guaranteed
      // `false` — see GLOBAL-EVAL SEMANTICS at the top of this file).
      await isFlipt(APP_LISTINGS_FLAG);
  if (listingsOn) return true;
  // OR-fallback: the `app-listings` flag doesn't exist yet (dark window) / hasn't
  // been widened, so defer to `app-blocks-enabled` to keep the existing
  // mods + app-dev-testers cohort's store access intact. Same opts (per-user or
  // no-user global) so the fallback eval matches the primary eval's shape.
  return isAppBlocksEnabled(opts);
}

/**
 * AUTHZ check for the App Blocks AUTHOR capability (developer soft-launch).
 *
 * Governs who may SUBMIT apps + use `dev:live` (mint a dev token, generate +
 * spend Buzz from their own block). Used by the REST author endpoints
 * (submit-version, dev-token) and the block-token-authed runtime procs, which
 * evaluate it against the TOKEN's hydrated subject user (NOT a request session).
 *
 * ## Eval shape mirrors `isAppBlocksEnabled`, WITH a moderator floor
 *
 * Same per-user Flipt eval as `isAppBlocksEnabled` (entityId = user id, context
 * from `buildFliptContext`), so the `app-blocks-author` flag's segments match
 * exactly as the client/`hasFeature` gate sees them.
 *
 * The ONE difference: moderators are a STATIC floor (short-circuit `true`). This
 * is deliberate and load-bearing:
 *   - The `app-blocks-author` flag does NOT exist in Flipt at merge time (it is
 *     created AFTER, as the rollout). With a bare `isFlipt` eval, an absent flag
 *     resolves `false` for EVERYONE — mods included — which would REGRESS mods'
 *     existing author access the instant this merges. `isAppBlocksEnabled` has
 *     no such problem only because its flag already exists in prod.
 *   - The mod floor makes this helper consistent with the `appBlocksAuthor`
 *     entry's `availability: ['mod']`, which is what `hasFeature` falls back to
 *     when Flipt returns null (flag absent / Flipt down). So SSR/`ctx.features`
 *     gates and this helper agree in the fail-closed direction: mods only.
 *
 * ## Fail-closed — and what actually makes it so
 *
 * A non-mod with no `app-blocks-author` grant is denied, and that holds under
 * every flag state: an ABSENT flag and an unreachable Flipt both make `isFlipt`
 * return `false` unconditionally — see `createFliptClient().isEnabled`, which
 * returns `false` when the client is null and when the evaluation throws. That
 * half is independent of how the flag is configured.
 *
 * 🔴 THERE IS NO NO-USER BRANCH, AND THE COMPILER IS WHAT GUARANTEES THAT.
 * `user` is REQUIRED and non-nullable. That is the entire guard: a capability has
 * nothing to authorize without a subject, so a caller holding a nullable one
 * cannot reach this function until it has said, in code, what it wants to happen.
 *
 * This docblock used to say a vanished/undefined user was denied because of "no
 * floor + global eval (can never match a segment) → denied". The premise is true
 * — a no-user eval carries entityId `'global'` and an empty context, so no
 * `STRING_COMPARISON_TYPE` segment (which is every identity / tier / cohort
 * segment we have) can match it. The conclusion did NOT follow from it: it
 * followed from the flag's BASE VALUE being `false`. When no rollout matches,
 * Flipt answers with the flag's own base `enabled`, so under a base-`enabled:
 * true` flip that branch resolved TRUE and admitted a caller with no resolvable
 * subject through an AUTHZ gate. See GLOBAL-EVAL SEMANTICS at the top of this
 * file for the measurement and for the production-Flipt precedent.
 *
 * Why a REQUIRED parameter rather than a `if (!user) return false` branch: the
 * branch answers for the caller, silently, and every one of them wants to answer
 * for itself (refuse a vanished token subject / refuse an unauthenticated
 * request). A required parameter turns each of those into a compile error until
 * the intent is written down, and it cannot be walked by rewording — unlike the
 * branch, which reads as handled at every call site without any of them having
 * decided anything. Making it required errored at exactly 2 of the 10 call sites,
 * both bare `middleware(...)` whose `ctx.user` type is not narrowed by the
 * `protectedProcedure` they are attached to; both now refuse explicitly.
 *
 * 🔴 What this does NOT stop: a deliberate `user!` or `as SessionUser` cast. At
 * runtime such a call throws inside `buildFliptContext` / `String(user.id)`
 * rather than returning `true`, so it still cannot open the gate — but it is a
 * crash, not a refusal, and review is the only thing that catches the cast.
 */
export async function isAppBlocksAuthorEnabled(opts: { user: SessionUser }): Promise<boolean> {
  const user = opts.user;
  // Moderator floor — the `availability: ['mod']` static fallback. Keeps mods'
  // existing author access intact while the Flipt flag is absent (dark window)
  // and regardless of how the flag's segments are later configured.
  if (user.isModerator) return true;
  // Per-user eval — same entityId + context shape as isAppBlocksEnabled, so the
  // author cohort segment resolves identically to the client/hasFeature gate.
  return isFlipt(APP_BLOCKS_AUTHOR_FLAG, String(user.id), buildFliptContext(user));
}

/**
 * GLOBAL gate for the build/publish/deploy PIPELINE webhooks (Decision 1).
 *
 * Evaluates the dedicated `app-blocks-pipeline-enabled` flag with no user
 * context (entityId='global', empty context), mirroring how the machine
 * webhooks have always called Flipt — only the flag KEY changes. This is
 * decoupled from the mod-segmented user-facing `app-blocks-enabled` flag so the
 * pipeline can run for mod-approved blocks without enabling the feature for
 * users.
 *
 * Fail-safe: if `app-blocks-pipeline-enabled` does not exist (it is created in
 * Flipt only AFTER this merges) or Flipt is unreachable, `isFlipt` returns
 * `false` → the pipeline webhooks REFUSE (503) → the pipeline stays dark. So
 * this change is a no-op on as-merged behaviour and cannot regress the gate
 * open.
 */
export async function isAppBlocksPipelineEnabled(): Promise<boolean> {
  return isFlipt(APP_BLOCKS_PIPELINE_FLAG);
}

/**
 * GLOBAL gate for the RUNTIME token-verification surface (Decision 4).
 *
 * Evaluates the dedicated `app-blocks-runtime-enabled` flag with no user
 * context (entityId='global', empty context), mirroring how the runtime sites
 * have always called Flipt — only the flag KEY changes from the mod-segmented
 * `app-blocks-enabled` to this dedicated global flag.
 *
 * Used by:
 *   - the JWKS public-key endpoint (`/api/v1/block-tokens/jwks`), and
 *   - the `withBlockScope` middleware (block-JWT verification on scoped routes).
 *
 * Safe to be global because block JWTs are only ever MINTED for an authorized
 * verification confers no authority — it only re-validates a token the
 * independently-gated mint endpoint already issued (mint is per-user-gated on
 * `app-blocks-enabled` and is the real authorization boundary), so gating
 * verification globally does not widen visibility. (See APP_BLOCKS_RUNTIME_FLAG
 * for the full reasoning + the anon-mint caveat — do NOT rely on "mod-only
 * minting.") Decoupled from `app-blocks-pipeline-enabled` so pausing builds does
 * not kill live blocks' runtime verification.
 *
 * OPERATOR NOTE: create `app-blocks-runtime-enabled` in Flipt as a PLAIN GLOBAL
 * BOOLEAN (base `enabled`, NO segment) — this helper evals globally
 * (`entityId='global'`, empty context), so no segment can ever match it and the
 * answer is always the flag's BASE value. A base-`false` flag carrying a segment
 * rollout therefore resolves `false` for everyone, silently leaving runtime DARK
 * (blocks mysteriously fail to verify). ⚠️ The reverse misconfig is NOT
 * fail-safe: base `true` PLUS a segment resolves `true` globally — the segment
 * looks like a restriction and restricts nothing. Set the base, don't decorate
 * it. See GLOBAL-EVAL SEMANTICS at the top of this file.
 *
 * Fail-safe: if `app-blocks-runtime-enabled` does not exist (it is created in
 * Flipt only AFTER this merges) or Flipt is unreachable, `isFlipt` returns
 * `false` → the runtime sites stay dark (JWKS 503; withBlockScope treats a
 * present block JWT as absent). No-op on as-merged behaviour; cannot regress
 * the gate open.
 */
export async function isAppBlocksRuntimeEnabled(): Promise<boolean> {
  return isFlipt(APP_BLOCKS_RUNTIME_FLAG);
}

/**
 * Dedicated mod+cohort-segmented flag for the APP DEV TUNNEL (on-site dev via a
 * hardened sish tunnel — the `dev-<random16>.<APPS_DOMAIN>` generalization of the
 * mod review sandbox).
 *
 * When ON for the caller, an approved app developer may mint a tunnel credential
 * (`blocks.startDevTunnel`), get an ephemeral `dev-<random16>.<APPS_DOMAIN>` host
 * wired to their LOCAL dev server, and open `civitai.com/apps/dev/<blockId>` to
 * see their local code rendered inside the real production `PageBlockHost`. The
 * whole feature is DORMANT until this flag is on for the caller, so it ships dark
 * and enables per-cohort without touching the user-facing `app-blocks-enabled`
 * rollout or the build pipeline.
 *
 * This is a USER-VISIBILITY / capability gate (the `startDevTunnel` / `stop` /
 * `status` tRPC procedures + the `/apps/dev` SSR route + the entry-token mint), so
 * — exactly like `app-blocks-review-sandbox-enabled` — it is segment-gated and
 * MUST be evaluated WITH the caller's context. Create it in Flipt as base
 * `enabled: false` with the `moderators` segment PLUS the `app-dev-testers` cohort
 * segment (mirror `app-blocks-pages-enabled` / `app-blocks-review-sandbox-enabled`
 * exactly) so mods + the dev-testers cohort resolve `true` and everyone else
 * `false`.
 *
 * NB: this flag gates only the CONTROL PLANE (mint / route / entry-token). The
 * public SSH exposure of the sish tunnel is a separate, deliberately-windowed
 * infra change (P3) — enabling this flag alone can never expose a dev's machine,
 * because with no public `ssh -R` reachability there is no tunnel to serve.
 *
 * Fail-safe: the flag does NOT exist in Flipt yet (created only AFTER this merges)
 * → `isFlipt` returns `false` → `startDevTunnel` throws FORBIDDEN and the
 * `/apps/dev` route 404s. So the as-merged behaviour is fully dark and cannot
 * regress the gate open.
 */
export const APP_BLOCKS_DEV_TUNNEL_FLAG = 'app-blocks-dev-tunnel';

/**
 * Segment-gated gate for the APP DEV TUNNEL. Evaluated WITH the caller's context
 * (entityId = user id, context carries server-side `isModerator`) so the
 * `moderators` / `app-dev-testers` segments can match — identical eval shape to
 * `isAppBlocksReviewSandboxEnabled`. No user → a global eval, which returns the
 * flag's BASE value; that is `false` today (base OFF + segment rollout) and it is
 * the base, not the segment miss, that closes it — see GLOBAL-EVAL SEMANTICS at
 * the top of this file. An absent flag, and an unreachable Flipt, each evaluate
 * `false` unconditionally — that half IS fail-closed, whatever the base value.
 * See APP_BLOCKS_DEV_TUNNEL_FLAG.
 *
 * NOTE: unlike `isAppBlocksAuthorEnabled`, there is NO moderator static floor —
 * the flag is created as the rollout, so an absent flag resolves `false` for
 * EVERYONE (mods included). That is intentional and load-bearing: the dev tunnel
 * is a brand-new surface (no existing mod access to preserve), so denying
 * everyone whenever the flag cannot be evaluated is the safe posture.
 */
export async function isAppBlocksDevTunnelEnabled(opts?: { user?: SessionUser }): Promise<boolean> {
  if (!opts?.user) return isFlipt(APP_BLOCKS_DEV_TUNNEL_FLAG);
  const user = opts.user;
  return isFlipt(APP_BLOCKS_DEV_TUNNEL_FLAG, String(user.id), buildFliptContext(user));
}

/**
 * DEDICATED kill-switch for the HIGHEST-risk dev-tunnel surface: granting REAL
 * (self-capped) Buzz-spend (`ai:write:budgeted`) to an UNSUBMITTED app — one that
 * has NEVER been through review (no publish request). Deliberately SEPARATE from
 * `app-blocks-dev-tunnel` so ops can kill "real Buzz on an unreviewed app" WITHOUT
 * disabling all tunnel dev (render/HMR/pending-app testing stay up). When OFF, the
 * brand-new (no-pending-row) dev-tunnel mint + SSR strip `ai:write:budgeted` from
 * the granted set → the app resolves READ-ONLY (still renders, just can't spend).
 * The PENDING (submitted-but-unapproved) and APPROVED tunnel paths are unaffected.
 *
 * Evaluated WITH the caller's context (mod/cohort segments), identical eval shape
 * to `isAppBlocksDevTunnelEnabled`. Fail-closed: absent flag / Flipt-down → `false`
 * → no unsubmitted spend for anyone (mods included), so the as-merged posture is
 * dark until the flag is created in Flipt.
 *
 * SCOPE OF THE KILL (by design — kills NEW grants, not in-flight tokens): this is
 * checked at MINT time (block-token mint + `/apps/dev` SSR), NOT re-checked per
 * spend at `submitWorkflow`. A dev token minted while this flag was ON therefore
 * retains `ai:write:budgeted` for its ≤4h `dev` TTL after a flip to OFF. That window
 * is bounded by the self-bound spend (author's OWN Buzz only) + the per-call
 * (DEV_BUZZ_BUDGET_CAP) / per-session (DEV_TUNNEL_SESSION_BUZZ_CAP) / per-user-daily
 * caps, and `app-blocks-author` provides a RUNTIME full-kill for a bad actor (its
 * re-check runs at submit). If instant SURGICAL revocation of just this surface is
 * ever needed, add a per-spend re-check here in the `claims.dev` branch of
 * `submitWorkflow` (gated on a brand-new discriminator so pending/approved spend is
 * untouched). Accepted trade at ship: the caps + 4h TTL + author-flag kill suffice.
 */
export const APP_BLOCKS_DEV_TUNNEL_UNSUBMITTED_SPEND_FLAG =
  'app-blocks-dev-tunnel-unsubmitted-spend';

export async function isAppBlocksDevTunnelUnsubmittedSpendEnabled(opts?: {
  user?: SessionUser;
}): Promise<boolean> {
  if (!opts?.user) return isFlipt(APP_BLOCKS_DEV_TUNNEL_UNSUBMITTED_SPEND_FLAG);
  const user = opts.user;
  return isFlipt(
    APP_BLOCKS_DEV_TUNNEL_UNSUBMITTED_SPEND_FLAG,
    String(user.id),
    buildFliptContext(user)
  );
}

/**
 * Dedicated kill-switch for the PRIVATE RUN of a DELISTED / SUSPENDED app — the
 * `/apps/run/<slug>` SSR route's private-run fallback plus the PHASE 3 page-token mint branch, which
 * together serve a taken-down app's ALREADY-DEPLOYED bundle to its owner, an accepted
 * listing collaborator, or a moderator. Never publicly: the public run route and the
 * public page mint keep their `status: 'approved'` requirement untouched.
 *
 * Ship BASE-OFF (`enabled: false`, no rules, no rollouts) and add a moderators-segment
 * rule at enable time. The flag row lives in `civitai/flipt-state`, NOT here, so the
 * code merging changes nothing until that row exists — which is the intended state.
 *
 * 🔴 `user` IS REQUIRED, AND THAT IS THE FAIL-CLOSED MECHANISM — not a convenience.
 * The sibling accessors spell `if (!opts?.user) return isFlipt(FLAG)`, and a no-user
 * global eval returns the flag's **BASE** value rather than denying (measured; see
 * GLOBAL-EVAL SEMANTICS at the top of this file). That is harmless for a flag whose
 * base is off today, but it makes the deny conditional on a value in another repo. A
 * private run is a status bypass on an app the platform has taken down, so the subject
 * is not optional: this mirrors `isAppBlocksAuthorEnabled`'s required-`user` shape,
 * which is the only one in this file that denies a missing subject BY TYPE.
 *
 * 🔴 NO MODERATOR STATIC FLOOR, unlike `isAppBlocksAuthorEnabled`. There is no
 * existing mod access to this surface to preserve (it does not exist yet), so an
 * absent or unreachable Flipt must deny EVERYONE, mods included — the same posture
 * and the same reasoning as `isAppBlocksDevTunnelEnabled`.
 *
 * 🔴 DO NOT COMPOSE THIS WITH `isAppBlocksAuthorEnabled`. That flag asks "is this
 * caller an app AUTHOR", which would refuse a moderator who has never published an
 * app — i.e. exactly the audience this surface exists for.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * 🔴 PRECONDITION BEFORE THIS FLAG IS SET TO ANYTHING OTHER THAN `false`.
 *
 * An operator decision on this feature is that a moderator's private run is FULLY
 * INVISIBLE TO THE APP'S OWNER — no moderation event, no play count, and nothing in
 * the owner's analytics. The first two are delivered (the private route deliberately
 * calls neither `recordAppListingOpen` nor any moderation-event writer). THE THIRD is
 * now delivered on all three rails a private run can WRITE to. Read the ✅/open marks,
 * not the count — and note item 4, which is a fourth owner-visible read with a stated
 * decision rather than a filter, so "three rails" is a claim about writers and not about
 * how many aggregates the owner's panel serves:
 *
 *   1. ✅ `block_spend_attribution` — CLOSED, BY A DIFFERENT MECHANISM THAN THIS ITEM
 *      ORIGINALLY DESCRIBED. A private run now writes **NO ROW AT ALL**: the exclusion is
 *      WRITE-side, an early return in `recordSpendAttribution` before the row is built.
 *      ⚠️ THIS LINE PREVIOUSLY READ "A private run's row is written VOIDED", which was
 *      true when written and was falsified by the write-side change. It is corrected
 *      here rather than in a later sweep because this ledger's own 🔴 rule below says to
 *      fix THIS summary in the same commit that satisfies an item — and the rot it
 *      warns about is exactly what happened: the mechanism changed and the description
 *      did not, in the one file the Flipt description points a widener at.
 *      The owner-visible reads in `app-analytics.service.ts` still exclude
 *      `status = 'voided'` (the aggregate spreads `OWNER_VISIBLE_SPEND_FILTER`; the raw
 *      series binds the same constant as a parameter), measured both directions in
 *      `blocks/__tests__/app-analytics.void-exclusion.test.ts`. 🔴 THOSE FILTERS WERE
 *      DELIBERATELY KEPT and are NOT dead code — but for ONE reason, not three: they
 *      exclude `self_spend` and `internal_owner`, which are the entire live voided
 *      population (the 582 rows below, every one `self_spend`).
 *      ⚠️ THIS SENTENCE CLAIMED THREE REASONS AND TWO WERE FALSE. It said the filters
 *      "still exclude the historical private-run rows written before the change" and that
 *      "`'manual_review'` has a SECOND live producer in `backpay.service.ts` (held rows)".
 *      There are no historical rows — the flag never shipped, so no private run ever wrote
 *      one. And `backpay.service.ts` writes `blockSubscriptionAttribution`, a DIFFERENT
 *      TABLE, with `status: 'held'`, which a `status = 'voided'` filter does not exclude
 *      in any case. 🔴 THIS COPY SURVIVED THE SWEEP THAT RETRACTED THE OTHER FOUR — in
 *      the one file this ledger itself calls the one a widener opens. A retraction is a
 *      tree-wide sweep or it is nothing.
 *      ⚠️ IT SHIPPED AS A DELIBERATE CHANGE TO EXISTING DISPLAYED NUMBERS, which is the
 *      part an operator should know rather than discover: 639 rows to 57 (91.08%), 4,738
 *      Buzz to 268 (94.34%). The two reasons it had been HELD were both settled by
 *      measurement — the drop is entirely owners' own self-testing (every voided row is
 *      `self_spend` with `app_owner_user_id = user_id`, and no real third-party usage row
 *      is voided at all), and the unnamed "second consumer outside this repo" turned out to
 *      be an OPERATOR-facing analytics digest job outside this repo, which is not
 *      owner-facing and was fixed in the same sweep, as an independent change in that
 *      repo. No money moved: `spendSharePct` and `appOwnerShareCents` are hardcoded 0.
 *      (Kept unspecific on purpose — this repo is public.)
 *      🔴 STILL OWED, AND NOT CLOSED BY THE CODE: the acceptance check. One private run
 *      against a delisted app, then read that app's own analytics panel and confirm `runs`
 *      / `runs.buzzSpent` did not move. A unit test is not that claim.
 *   2. ✅ `block_scope_invocations` — CLOSED. Written by `withBlockScope` for every
 *      scoped call with the real `app_block_id` and the VIEWER's `user_id`. The rows
 *      now carry a `source` marker on an EXISTING column — no migration was needed — and
 *      all five owner-visible reads exclude it: four Prisma reads spread
 *      `OWNER_VISIBLE_INVOCATION_FILTER`, and the raw `count(DISTINCT user_id)` spells the
 *      same constant as `"source" <> $n`. ⚠️ Editing that filter moves FOUR of the five;
 *      the distinct-user count is the one that does not follow.
 *   3. ✅ `blockRenders` (owner-visible IMPRESSIONS: `views.count` /
 *      `views.uniqueViewers`) — CLOSED AT THE WRITERS. A private run mounts the host, so
 *      it emitted a row like any other view and the reviewer landed as an identifiable
 *      unique viewer. Both writers now consult `blocks/private-run-impression.service`
 *      and skip the insert; the canonical reasoning is at `blocks/app-views.service.ts`.
 *      🔴 BUT IT LEAVES ONE THING FOR WHOEVER WIDENS THIS FLAG, and this is the reason
 *      the item stays here rather than only at the read site:
 *        (a) ✅ SATISFIED. The key EXISTS in `flipt-state`, base-off with no rollout
 *            (`civitai/flipt-state` PR #100, squash `c94c807`; verified present at
 *            `enabled: false`). It had to, because an ABSENT key makes the evaluation
 *            throw — bypassing the eval cache and logging on every reaching call — and
 *            that gate sits on the `/api/track/block-render` beacon. Left here as a
 *            SATISFIED entry rather than deleted: the requirement still binds if anyone
 *            ever removes that row, and a deleted line cannot say so.
 *        (b) 🔴 NOTHING ON THIS SURFACE IS RATE-LIMITED, AND THE POPULATION IS THREE
 *            DOORS, NOT TWO. Once this flag admits anyone, each door can reach the
 *            private-run access predicate — which touches the write primary — on a
 *            caller-chosen app id.
 *            ⚠️ THIS ITEM READ "NEITHER OF THE TWO WRITERS IS RATE-LIMITED … Settle it
 *            for BOTH writers, not one … Both writers are enumerated in
 *            `blocks/__tests__/block-render-writer.call-site-ledger.test.ts`, so 'both'
 *            is followable." That enumeration is now INCOMPLETE and following it would
 *            leave a door open: it covers the two `blockRenders` beacon writers, and the
 *            THIRD door is the SSR run route `src/pages/apps/run/[slug]/[[...path]].tsx`,
 *            which reaches the same predicate as a fallback and is PUBLIC, linked and
 *            crawlable. Note the subject also shifts — `blockRenders` WRITERS and callers
 *            of the ACCESS PREDICATE are different populations; the predicate's own
 *            enumeration is `blocks/__tests__/private-run-access.call-site-ledger.test.ts`
 *            (three callers), which is the one to follow for THIS item.
 *            🔴 SETTLING IT: the rate-limiter PR was closed unmerged — it bounded one of
 *            the beacon callers while the SSR route drove the same read unbounded — so the
 *            cost bound today is THE FLAG ITSELF, by decision. That is sound only while
 *            the flag admits trusted audiences. RE-PRICE BEFORE WIDENING TO ALL APP
 *            OWNERS: an owner is not an operator.
 *            (Keep this at the level of the missing control — this repo is public.)
 *   4. ⚖️ `block_buzz_attribution` (owner-visible `buzzPurchased`) — NOT FILTERED, BY
 *      DECISION, and recorded here so the enumeration is not mistaken for complete at
 *      three. `getMyAppAnalytics` aggregates this table into `buzzPurchased` with no
 *      private-run predicate, and its writer has no `privateRun` arm — its only void is
 *      `isSelfPurchase`. So a reviewer who completed a real CARD PURCHASE inside a
 *      delisted app during a private run would land in that owner's `buzzPurchased`.
 *      Left open because it costs the reviewer real money, which makes it a path nobody
 *      takes by accident rather than a leak a review run produces incidentally — every
 *      other rail here fires on an ordinary review with no spend at all. Revisit if a
 *      private run ever gets a test-mode or granted-Buzz purchase path, because that
 *      removes the only thing keeping it shut.
 *
 * 🔴 WHY THIS PARAGRAPH IS IN THIS FILE. The dependency was previously recorded only
 * in a docblock on the attribution arm and in a merged PR body — neither of which is
 * read by the person who opens Flipt, in a different repository, to widen a flag. The
 * condition is inert while the base value is `false`: with the flag off both surfaces
 * refuse before resolving anything, so no private-run row of either kind can exist.
 * It becomes live the moment this value is anything else.
 *
 * So, before widening on THIS count, exactly TWO things remain — item 1's filter has LANDED
 * and item 3's flag-key carry-over is SATISFIED:
 *   · item 3(b): 🔴 RESTATED — it is no longer "the two unrate-limited `blockRenders`
 *     writers". NOTHING on this surface is rate-limited: the limiter PR was closed
 *     unmerged (its limiter covered one of two callers of the access predicate while the
 *     SSR route drove the same read unbounded), and the rescope then wired the PUBLIC,
 *     linked, crawlable `/apps/run/<slug>` into that same predicate as a fallback. So the
 *     enumeration is THREE doors, not two, and the cost bound is now THE FLAG ITSELF
 *     rather than any limiter. That is a deliberate operator decision on the grounds that
 *     the flag admits only trusted audiences — and it is only sound while that holds.
 *     🔴 RE-PRICE THIS BEFORE WIDENING TO ALL APP OWNERS: an owner is not an operator,
 *     and `private-run-access.service.ts`'s `dbWrite.user.findUnique` ignores the
 *     `db: 'read'` argument it is passed, so a resolve that REACHES it hits the write
 *     primary. ⚠️ Not "every resolve": it sits behind the flag check, the session-level
 *     viewer check and the block resolve, so `flag-off`, anonymous, `no-app`, `approved`
 *     and `not-a-page` all return before it. The earlier wording overstated the reachable
 *     population — in the conservative direction, but this figure is the input to the
 *     re-price decision this paragraph triggers, so it should be the real one.
 *   · item 1's acceptance check: one real private run, read on the owner's own analytics panel.
 * ⚠️ THIS PARAGRAPH SAID "All three analytics rails now filter, so the void DOES deliver
 * the invisibility at the row level." Rail 1 no longer filters and there is no void — a
 * private run writes NO spend-attribution row at all. The other rails are unchanged. What
 * is still true is the part that mattered: none of it delivers the evidence that the
 * feature works end to end, which is what the acceptance check buys.
 *
 * ⚠️ THIS PARAGRAPH IS A COUNT, AND A COUNT IS THE THING THAT ROTS. It said "item 3's two
 * carry-overs (the flag key existing in `flipt-state`, …)" while that key had ALREADY been
 * created hours earlier — the same shape that has now bitten this feature four times: a
 * precondition true when written, satisfied by work that landed since, still reading as open
 * in the one file a widener opens. If you satisfy an item, fix THIS summary in the same commit,
 * not only the item above. Do not restate the count anywhere else; point here.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * 🔴 SECOND PRECONDITION, AND IT IS A PRODUCT QUESTION RATHER THAN A DELIVERY GAP:
 * A REVIEWER'S OWN CONSUMER-SIDE SCOPE REVOCATION SILENTLY NARROWS THEIR PRIVATE RUN.
 *
 * 🔴 A NEW PRECONDITION GOES BELOW THIS ONE, NEVER BETWEEN THE FIRST ONE'S NUMBERED ITEMS
 * AND ITS CLOSING PARAGRAPHS — inserting a section inside another silently re-points that
 * one's ending at the new content.
 *
 * Per-scope consent revocation landed while this surface was being built. Its
 * `shouldConsultMarker` keys on `{ userId, scopes }` alone — it cannot tell a private-run
 * review token from an ordinary install token — and a private-run token has a self-bound
 * subject and always carries a non-exempt scope — `user:read:self` is force-granted by the
 * clamp and is not consent-exempt, which alone is what makes this unconditional — so the
 * marker IS consulted for EVERY audience, editors included, keyed on the REVIEWER's id and
 * the app's real id. (Not `ai:write:budgeted`: that one the clamp can only ever STRIP —
 * `user:read:self` is its single force-grant — so a non-editor keeps the spend scope only
 * when the approved snapshot declares it, and an app with `approvedScopes: []` renders
 * read-only for everyone.) The rows it reads are therefore whatever that person expressed
 * as an ordinary CONSUMER of that app, at some earlier point, on a surface unrelated to
 * review.
 *
 * It cannot WIDEN — all three `revokedScopesForToken` arms produce a set to STRIP and none
 * can grant — which is why it was allowed to stand rather than exempted. ⚠️ But "narrows"
 * is not the worst case: an UNREADABLE marker fails CLOSED, as a retryable 503 on the
 * bridge and at REST for a non-exempt `requiredScope`, so a cache incident makes a private
 * run refuse outright rather than run read-only. Do not read the heading as bounding the
 * harm at read-only.
 *
 * What is NOT settled is what the reviewer sees: a moderator who once withdrew the spend
 * scope on this app gets a read-only private run and nothing on screen says why, and the
 * audience for this surface is exactly the population that files bugs about that. Deciding
 * whether the chrome should say so is a call for whoever widens this flag. Exempting
 * private-run tokens from the marker is the WRONG fix — it makes a review surface ignore a
 * withdrawal the viewer expressed.
 *
 * Pinned behaviourally in
 * `src/server/services/blocks/__tests__/block-bridge-auth.consent-revocation.test.ts`
 * (five rows, mutation-verified). ⚠️ Do not let this move back into a test docblock: that is
 * further from the person opening Flipt than either of the two places already ruled out for
 * the first precondition — a docblock on the attribution arm, and a merged PR body.
 * ────────────────────────────────────────────────────────────────────────────────
 */
export const APP_BLOCKS_PRIVATE_RUN_FLAG = 'app-blocks-private-run-enabled';

export async function isAppBlocksPrivateRunEnabled(opts: { user: SessionUser }): Promise<boolean> {
  const user = opts.user;
  return isFlipt(APP_BLOCKS_PRIVATE_RUN_FLAG, String(user.id), buildFliptContext(user));
}

/**
 * Dedicated GLOBAL fail-closed flag for the attribution BACKPAY reader
 * (W3 attribution back-half — Slice 4 read leg, see backpay.service.ts).
 *
 * The backpay reader transitions TRACK-ONLY attribution rows
 * (`status='tracked'`) to `confirmed` at a SIGNED-OFF rate, stamping the
 * computed author share. It moves NO money — a separate payout rail disburses
 * `confirmed` rows. Because it is the gate between "recorded but unrated" and
 * "confirmed for disbursement," it must be DARK until monetization sign-off.
 *
 * This is one half of the backpay's DOUBLE-DARK gate; the other half is a
 * `SIGNED_OFF_RATE_CARD_VERSION` constant (null today) checked in the service.
 * BOTH must pass for the reader to write — so even with this flag on, an
 * unsigned/mismatched rate version still refuses (the reader can never apply a
 * placeholder rate).
 *
 * Evaluated globally (entityId='global', empty context), mirroring
 * `isAppBlocksPipelineEnabled` exactly — so it must be a PLAIN base-`enabled`
 * boolean in Flipt. A segment can never match a global eval, so a segment is not
 * a way to turn this on, and — the half that matters more — it is not a way to
 * keep it off either: the global answer is the BASE value, so base `true` plus a
 * segment arms the reader for everyone. See GLOBAL-EVAL SEMANTICS at the top of
 * this file.
 *
 * Fail-safe: the flag does NOT exist in Flipt yet (it is created only AFTER
 * this merges, and only when leadership has signed off a rate), or Flipt is
 * unreachable → `isFlipt` returns `false` → the backpay reader REFUSES (writes
 * nothing, `skipped:'flag-disabled'`). So the as-merged behaviour is fully
 * dark and cannot regress open.
 */
export const APP_BLOCKS_BACKPAY_FLAG = 'app-blocks-backpay-enabled';

/**
 * GLOBAL fail-closed gate for the attribution BACKPAY reader (Slice 4).
 *
 * Evaluates the dedicated `app-blocks-backpay-enabled` flag with no user
 * context, mirroring `isAppBlocksPipelineEnabled`. See APP_BLOCKS_BACKPAY_FLAG
 * for the fail-safe + double-dark reasoning.
 */
export async function isAppBlocksBackpayEnabled(): Promise<boolean> {
  return isFlipt(APP_BLOCKS_BACKPAY_FLAG);
}

/**
 * Dedicated GLOBAL flag for the PER-GENERATION AUTHOR FEE.
 *
 * The fee is an additive, author-set, viewer-paid charge on each generation an
 * app runs — `max(flatBuzz, pctOfBase × base_generation_buzz)`. This flag is the
 * single switch over the whole rail: quoting, charging, accruing and daily
 * settlement all read it.
 *
 * GLOBAL (no user context), like `app-blocks-pipeline-enabled` /
 * `app-blocks-backpay-enabled`: the viewer identity is on the row rather than in
 * the gate, and the fee is uniform platform config rather than a per-cohort
 * rollout. ⚠️ Deliberately NOT a list of the readers — an earlier revision named
 * one ("the fire-and-forget spend-attribution writer") and it went stale.
 *
 * OPERATOR NOTE: `app-blocks-author-fee-enabled` is a PLAIN GLOBAL BOOLEAN — NO
 * segment, no variants, no rollouts. Keep it that shape. A global eval returns the
 * flag's BASE value, so a segment can neither match nor restrict: base `false` + a
 * rollout stays dark for everyone (safe but confusing), and base `true` + a rollout
 * is ON for everyone while looking restricted (not safe). See GLOBAL-EVAL SEMANTICS
 * at the top of this file.
 *
 * Fail-safe, code half: an unreachable Flipt — and an absent key — evaluates
 * `false` unconditionally, so no fee can be quoted or charged by accident.
 *
 * 🔴 BUT DO NOT DISABLE THE FEE BY DELETING THE KEY. An ABSENT key makes the
 * evaluation THROW: it bypasses the eval cache and logs a `console.error` on every
 * App Blocks generation submit, indefinitely. To turn the fee off, set it `false`.
 *
 * 🔴 THE RAIL IS LIVE, AND ITS STATE IS NOT IN THIS COMMENT. Earlier revisions said
 * the key did not exist, then that it was base `false` and the rail was dark; the
 * fee has been charging since 2026-09-25. Read the current value from Flipt
 * (`civitai-app` environment), never from a comment — one toggle flips the whole
 * rail in either direction, with no deploy and no review, so any value written here
 * is wrong the moment someone flips it. That is what went wrong twice already.
 */
export const APP_BLOCKS_AUTHOR_FEE_FLAG = 'app-blocks-author-fee-enabled';

/**
 * GLOBAL fail-closed gate for the per-generation AUTHOR FEE computation.
 * See APP_BLOCKS_AUTHOR_FEE_FLAG for the fail-safe reasoning, and
 * `~/server/services/blocks/author-fee` for what it gates.
 */
export async function isAppBlocksAuthorFeeEnabled(): Promise<boolean> {
  return isFlipt(APP_BLOCKS_AUTHOR_FEE_FLAG);
}

/**
 * Dedicated mod-segmented flag for the MOD REVIEW SANDBOX (#2831 second half).
 *
 * When a moderator reviews a PENDING publish request they can spin up the
 * pending version in a temporary, mod-gated preview at
 * `https://review-<sha>.<APPS_DOMAIN>/<slug>` before approving, torn down on the
 * approve/reject decision. The whole feature is DORMANT until this flag is on,
 * so it can ship dark and be enabled per-moderator without touching the
 * user-facing `app-blocks-enabled` rollout or the build pipeline.
 *
 * This is a USER-VISIBILITY gate (the Preview button + the previewRequest /
 * getReviewStatus tRPC procedures), so — like `app-blocks-enabled` — it is
 * mod-segmented and MUST be evaluated WITH the moderator's context. Create it in
 * Flipt as base `enabled: false` with the SAME `moderators` segment the
 * user-facing flag uses (`isModerator == "true"`); a plain-boolean global flag
 * would also work but the segment shape keeps it consistent + lets it be scoped
 * to a subset of mods during early dogfood.
 *
 * NB: the actual review BUILD/DEPLOY machinery (the review-build-callback
 * webhook, the apply Job) is machine-to-machine with no user context and gates
 * on the existing GLOBAL `app-blocks-pipeline-enabled` flag — the same fail-safe
 * as the production build path. So even with this flag on for a mod, the review
 * build only runs when the pipeline flag is also on, exactly like a real deploy.
 *
 * Fail-safe: the flag does NOT exist in Flipt yet (created only AFTER this
 * merges) → `isFlipt` returns `false` → previewRequest returns UNAUTHORIZED and
 * the Preview button never mounts. So the as-merged behaviour is fully dark and
 * cannot regress the gate open.
 */
export const APP_BLOCKS_REVIEW_SANDBOX_FLAG = 'app-blocks-review-sandbox-enabled';

/**
 * Mod-segmented gate for the MOD REVIEW SANDBOX (#2831). Evaluated WITH the
 * moderator's context (entityId = user id, context carries server-side
 * `isModerator`) so the `moderators` segment can match — identical eval shape to
 * `isAppBlocksEnabled({ user })`. No user → a global eval, which returns the
 * flag's BASE value — `false` today because the flag is base OFF with a segment
 * rollout, not because the segment cannot match. See GLOBAL-EVAL SEMANTICS at the
 * top of this file, and APP_BLOCKS_REVIEW_SANDBOX_FLAG (whose "a plain-boolean
 * global flag would also work" note is exactly the shape that would open this
 * branch).
 */
export async function isAppBlocksReviewSandboxEnabled(opts?: {
  user?: SessionUser;
}): Promise<boolean> {
  if (!opts?.user) return isFlipt(APP_BLOCKS_REVIEW_SANDBOX_FLAG);
  const user = opts.user;
  return isFlipt(APP_BLOCKS_REVIEW_SANDBOX_FLAG, String(user.id), buildFliptContext(user));
}

/**
 * Dedicated mod-segmented flag for the AGENTIC MOD CODE-REVIEW (App Blocks P1).
 *
 * When a moderator reviews a PENDING publish request they can dispatch an
 * ephemeral, sandboxed review agent that pulls the reviewed bundle, produces a
 * structured code-review / security-audit / scope-verdict report, and reports it
 * back — decision-support for the mod, torn down on the approve/reject decision.
 *
 * This is a USER-VISIBILITY gate (the `startAgentReview` tRPC procedure — the
 * modal button + report rendering + chat are later phases), so — exactly like
 * `app-blocks-review-sandbox-enabled` — it is mod-segmented and MUST be evaluated
 * WITH the moderator's context. Create it in Flipt as base `enabled: false` with
 * the SAME `moderators` segment the user-facing flag uses (`isModerator ==
 * "true"`), so it can be scoped to a subset of mods during early dogfood.
 *
 * The machine-to-machine half (the report callback) has NO user context and
 * additionally gates on the existing GLOBAL `app-blocks-pipeline-enabled`
 * kill-switch — the same fail-safe as the review-sandbox build path.
 *
 * Fail-safe: the flag does NOT exist in Flipt yet (created only AFTER this
 * merges) → `isFlipt` returns `false` → `startAgentReview` returns UNAUTHORIZED
 * and no provisioning ever runs. So the as-merged behaviour is fully dark and
 * cannot regress the gate open.
 */
export const APP_BLOCKS_AGENTIC_REVIEW_FLAG = 'app-blocks-agentic-review';

/**
 * Mod-segmented gate for the AGENTIC MOD CODE-REVIEW (App Blocks P1). Evaluated
 * WITH the moderator's context (entityId = user id, context carries server-side
 * `isModerator`) so the `moderators` segment can match — identical eval shape to
 * `isAppBlocksReviewSandboxEnabled({ user })`. An absent flag, and an unreachable
 * Flipt, each evaluate `false` unconditionally — that half IS fail-closed. No user
 * → a global eval, which returns the flag's BASE value; base OFF plus a segment
 * rollout is what keeps that closed, not the segment miss. See GLOBAL-EVAL
 * SEMANTICS at the top of this file, and APP_BLOCKS_AGENTIC_REVIEW_FLAG.
 */
export async function isAppBlocksAgenticReviewEnabled(opts?: {
  user?: SessionUser;
}): Promise<boolean> {
  if (!opts?.user) return isFlipt(APP_BLOCKS_AGENTIC_REVIEW_FLAG);
  const user = opts.user;
  return isFlipt(APP_BLOCKS_AGENTIC_REVIEW_FLAG, String(user.id), buildFliptContext(user));
}

/**
 * Dedicated fail-closed flag for App Blocks SHARED (app-global / cross-user)
 * storage — the FIRST surface that opens the per-app datastore to PUBLIC
 * cross-user writes (previously mod + app-dev-tester only). Mirrors
 * `app-blocks-dev-tunnel`: a brand-new surface with NO existing access to
 * preserve, so there is deliberately NO moderator static floor — an absent flag
 * resolves `false` for EVERYONE (mods included). This is the cluster-wide
 * kill-switch: flip it off and every shared read/write/vote refuses immediately
 * (the `resolveSharedContext` gate), independent of the block-runtime rollout.
 *
 * Evaluated WITH the caller's context (entityId = user id, context carries
 * server-side `isModerator`) so the `moderators` / community segments can match.
 * On the block-token path the "caller" is the HYDRATED TOKEN SUBJECT
 * (`getSessionUserById`), not a session — anon reads pass no user → global eval,
 * which returns the flag's BASE value. Closed today because the base is `false`;
 * a base-`enabled` flip DOES open anon shared reads, and that is the intended
 * GA widening rather than an accident — the qualifier this docblock already
 * carried ("safe to stay dark until a base-`enabled` flip") is the accurate half,
 * so do not read the word fail-closed into the segment miss. See GLOBAL-EVAL
 * SEMANTICS at the top of this file.
 *
 * Create it in Flipt as base `enabled: false` with the `moderators` segment (+
 * any community-cohort segment) exactly like `app-blocks-dev-tunnel`. The flag
 * did NOT exist in Flipt when this merged — the companion `flipt-state` entry was
 * a SEPARATE follow-up PR — so the as-merged posture was fully dark and could not
 * regress the gate open. (Past tense on purpose: this is an as-merged note, not
 * live state — see the reading trap at the top of this file. The paragraph above
 * says what closes this TODAY.)
 */
export const APP_BLOCKS_SHARED_STORAGE_FLAG = 'app-blocks-shared-storage';

export async function isAppBlocksSharedStorageEnabled(opts?: {
  user?: SessionUser;
}): Promise<boolean> {
  if (!opts?.user) return isFlipt(APP_BLOCKS_SHARED_STORAGE_FLAG);
  const user = opts.user;
  return isFlipt(APP_BLOCKS_SHARED_STORAGE_FLAG, String(user.id), buildFliptContext(user));
}

/**
 * Dedicated fail-closed flag for App Blocks POST CREATION — `posts:write:self` /
 * `blocks.createPostFromApp` / `CREATE_POST_FROM_APP`, the first surface on which
 * a third-party block produces PUBLIC, feed-visible, reward-earning content under
 * the VIEWER'S own byline.
 *
 * 🔴 IT IS DELIBERATELY INDEPENDENT OF `app-blocks-enabled`, AND THAT IS THE
 * POINT. `app-blocks-enabled` is the block-RUNTIME gate and is expected to widen
 * toward GA. Post creation must not widen with it — a GA flip of the runtime flag
 * would otherwise arm public post creation for every user on the same day, with
 * no separate decision. This flag is the switch that keeps those two rollouts on
 * separate clocks, and it is also the per-capability kill switch: flip it off and
 * every create/preview call refuses immediately, independent of the runtime
 * rollout and without disabling any other block capability.
 *
 * Mirrors `app-blocks-shared-storage` exactly: a brand-new surface with NO
 * existing access to preserve, so there is deliberately NO moderator static floor
 * — an ABSENT flag resolves `false` for EVERYONE, mods included. Evaluated WITH
 * the TOKEN SUBJECT'S context (the hydrated `SessionUser`, never `ctx.user` and
 * never a client value) so the `moderators` / cohort segments resolve identically
 * to the client gate.
 *
 * 🔴 SHIPS OFF. The flag does NOT exist in Flipt when this merges — the
 * `flipt-state` entry is a separate follow-up — so `isFlipt` returns `false` and
 * the whole capability is dark as merged. Create it as base `enabled: false` with
 * the `moderators` (+ any cohort) segment, exactly like
 * `app-blocks-shared-storage`. There is no code path that can regress this open:
 * the gate is a plain `if (!enabled) throw`, checked on BOTH the preview read and
 * the create write.
 */
export const APP_BLOCKS_POST_CREATION_FLAG = 'app-blocks-post-creation';

export async function isAppBlocksPostCreationEnabled(opts?: {
  user?: SessionUser;
}): Promise<boolean> {
  if (!opts?.user) return isFlipt(APP_BLOCKS_POST_CREATION_FLAG);
  const user = opts.user;
  return isFlipt(APP_BLOCKS_POST_CREATION_FLAG, String(user.id), buildFliptContext(user));
}

/**
 * Dedicated fail-closed flag for the App Blocks `kind:'training'` workflow kind —
 * `blocks.prepareTrainingDataset`, the training estimate/submit arm of
 * `blocks.estimateWorkflow` / `blocks.submitWorkflow`, and the host's
 * `RUN_TRAINING` consent pair (`blocks.previewTrainingQuote` /
 * `blocks.consentTrainingQuote`).
 *
 * Same posture as `app-blocks-post-creation`: independent of the runtime flag so a
 * GA widening of `app-blocks-enabled` does not arm training on the same day; an
 * ABSENT flag resolves `false` for everyone. Evaluated with the TOKEN SUBJECT'S
 * hydrated `SessionUser`, never `ctx.user`.
 */
export const APP_BLOCKS_TRAINING_KIND_FLAG = 'app-blocks-training-kind';

export async function isAppBlocksTrainingKindEnabled(opts: {
  user: SessionUser;
}): Promise<boolean> {
  const user = opts.user;
  return isFlipt(APP_BLOCKS_TRAINING_KIND_FLAG, String(user.id), buildFliptContext(user));
}

/**
 * Dedicated flag for the EXTERNAL-ONLY App-store read scope — the mechanism that
 * lets the store serve `kind='offsite'` (external app) listings to a viewer while
 * `kind='onsite'` App Blocks stay hidden from them. This is a SEPARATE, ORTHOGONAL
 * axis from the `app-listings` catalog-visibility flag: `app-listings` gates WHO
 * sees the FULL catalog (all kinds); this flag opens ONLY the offsite subset.
 *
 * ## Audience: a SEGMENTED tester cohort FIRST, the anonymous public LATER
 *
 * The first audience is a curated tester cohort (logged-in users) who should see
 * external listings ONLY, with onsite apps held back until a later phase. A
 * segment can only match when the eval carries the viewer's context, so
 * {@link isExternalListingsPublicEnabled} is evaluated PER-USER when a user is
 * present (entityId = user id, context from `buildFliptContext`) — the identical
 * eval shape `isAppBlocksEnabled` / `isAppListingsEnabled` use.
 *
 * 🔴 That does NOT narrow the eventual anonymous-public flip. With NO user the
 * helper preserves the ORIGINAL global eval (entityId='global', empty context)
 * verbatim, and a flag created as a PLAIN base-`enabled` boolean (no rollout
 * rules) resolves `true` for every entityId/context — so a base-enabled flip still
 * lights the flag for everyone, logged-in or anon. Per-user context only ADDS the
 * ability to segment; it can never subtract from a base-enabled flag. The two
 * supported Flipt shapes are therefore:
 *   - segment rollout (`app-dev-testers` / `moderators` / any user property) →
 *     matches only for the in-segment logged-in cohort. Anon carries no context,
 *     so anon stays dark — intended for this phase.
 *   - plain base `enabled: true` (no rollouts) → matches for EVERYONE incl. anon.
 * ⚠️ A PERCENTAGE (threshold) rollout is the one shape to avoid: it hashes the
 * entityId, so the server's `'global'` anon eval and the client gate's
 * `'anonymous'` anon eval can land on opposite sides. See the SEAM note on
 * {@link isExternalListingsPublicEnabled}.
 *
 * ## Fail-closed / dark posture
 *
 * The flag does NOT exist in Flipt at merge time (it is created in a LATER phase,
 * base `enabled: false`, only when the external-only store is ready) or if Flipt is
 * unreachable → `isFlipt` returns `false` → `resolveStoreVisibilityScope` returns
 * `none` for a non-privileged viewer and `full` for a mod/tester — i.e.
 * BYTE-IDENTICAL to today. This flag NEVER upgrades a mod/tester away from `full`;
 * it only ever moves a non-privileged viewer from `none` → `public-external`.
 */
export const APP_LISTINGS_PUBLIC_EXTERNAL_FLAG = 'app-listings-public-external';

/**
 * Gate for the EXTERNAL-ONLY App-store read scope. Evaluates the dedicated
 * `app-listings-public-external` flag WITH the viewer's context when a user is
 * present (entityId = user id, context from `buildFliptContext`), so a `testers`
 * segment can actually match — identical eval shape to `isAppBlocksEnabled` /
 * `isAppListingsEnabled`. No user → the ORIGINAL global eval (entityId='global',
 * empty context), byte-identical to the pre-segmentation behaviour, so the machine
 * / anonymous callers are unchanged. Fail-closed: absent flag / Flipt-down →
 * `false`. See APP_LISTINGS_PUBLIC_EXTERNAL_FLAG.
 *
 * 🔴 SERVER/CLIENT SEAM — this flag is evaluated TWICE per request, and the two
 * evaluations must agree or a viewer passes the page gate and gets an empty store
 * (or the reverse):
 *   - HERE (server data path) → `isFlipt(FLAG, id, ctx)`, feeding
 *     `resolveStoreVisibilityScope` → the store read procs + REST endpoints.
 *   - `featureFlags.appListingsPublicExternal` (feature-flags.service.ts, same
 *     `fliptKey`) → `isFliptSync(FLAG, id, ctx)` → `ctx.features` / `useFeatureFlags()`
 *     → the shared `hasAppsStoreAccess` predicate → the `/apps` SSR + client gates.
 * They agree BY CONSTRUCTION for a logged-in viewer: same flag key, same entityId
 * (`String(user.id)`), same context object (both call the SHARED `buildFliptContext`).
 * They agree in the fail-closed direction too: an absent flag makes the async
 * `isFlipt` return `false` while the sync `isEnabledSync` returns `null` and falls
 * through to the client entry's STATIC availability — which is `[]` (deliberately,
 * not `['mod']`) precisely so that static answer is also `false`.
 * RESIDUAL, bounded, and PRE-EXISTING for every flag in this family: for an
 * ANONYMOUS viewer the entityId/context differ (`'global'`/`{}` here vs
 * `'anonymous'`/`{isLoggedIn:'false'}` in the client gate). Irrelevant for a plain
 * base-enabled boolean or a user-property segment (both sides resolve the same);
 * it bites only under a percentage rollout or an `isLoggedIn`-keyed rule — hence
 * the shape guidance on APP_LISTINGS_PUBLIC_EXTERNAL_FLAG. The whole seam — both
 * REAL sides against one fake Flipt config — is pinned by
 * `app-blocks-flag.external-scope.seam.test.ts`.
 */
export async function isExternalListingsPublicEnabled(opts?: {
  user?: SessionUser;
}): Promise<boolean> {
  // No user → preserve the ORIGINAL global eval verbatim (entityId='global', empty
  // context). Byte-identical to the pre-segmentation behaviour: a base-enabled flag
  // still resolves true, a segmented one still cannot match.
  if (!opts?.user) return isFlipt(APP_LISTINGS_PUBLIC_EXTERNAL_FLAG);
  // Per-user eval — reuse the client gate's context builder so the server data
  // path and the `/apps` page gate share one context shape and cannot drift.
  const user = opts.user;
  return isFlipt(APP_LISTINGS_PUBLIC_EXTERNAL_FLAG, String(user.id), buildFliptContext(user));
}

/**
 * The store read-path VISIBILITY SCOPE. Re-exported from the dependency-free
 * `~/shared/utils/store-visibility-scope`, which owns the closed value set, the
 * runtime membership test and the ONE fail-closed narrowing rule — so the data
 * layer and the client can share them without importing this server module.
 * Existing `import type { StoreVisibilityScope } from '~/server/services/app-blocks-flag'`
 * call sites keep working unchanged.
 */
export type { StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';

/**
 * Resolve the {@link StoreVisibilityScope} for a store read request. The two flags
 * are INDEPENDENT axes and are checked in priority order so the mod/tester path is
 * NEVER narrowed by the public flag:
 *   1. `isAppListingsEnabled({ user })` (mods + app-dev-testers, OR-falling-back to
 *      `app-blocks-enabled`) → `full` — sees every kind, byte-identical to today.
 *   2. else `isExternalListingsPublicEnabled({ user })` (the external-only flag,
 *      segment-capable) → `public-external` — sees only offsite listings.
 *   3. else → `none` — dark.
 *
 * 🔴 PRIORITY ORDER IS THE "NEVER NARROW A MODERATOR" INVARIANT, not a style
 * choice. Axis 1 short-circuits, so a mod/tester resolves `full` WITHOUT the
 * external flag ever being evaluated. Swap the two checks and a moderator inside
 * the external cohort would silently be NARROWED from the whole catalog down to
 * offsite-only. Pinned by `app-blocks-flag.external-scope.test.ts`.
 *
 * 🔴 DARK-by-default invariant: with `app-listings-public-external` ABSENT in Flipt
 * (its as-merged state), a mod/tester still resolves `full` and everyone else
 * resolves `none` — ZERO observable change until the flag is created + enabled in a
 * later phase.
 *
 * 🔴 `opts` is threaded into BOTH axes. Dropping it on axis 2 (the pre-segmentation
 * shape) forces a global eval that no segment can ever match, so a `testers` segment
 * would resolve `false` for every member and the whole cohort would silently stay on
 * `none`.
 */
export async function resolveStoreVisibilityScope(opts?: {
  user?: SessionUser;
}): Promise<StoreVisibilityScopeValue> {
  const raw = (await resolveStoreVisibilityScopeUninstrumented(opts)) as unknown;
  // Instrumentation is deliberately at THIS choke point and nowhere else: it is the
  // single place both read paths (tRPC middleware + the REST handlers) and the SSR
  // store pages agree on, so one counter covers every entry point and cannot drift
  // the way per-call-site logging would.
  //
  // 🔴 RECORD THE RAW VALUE, BEFORE NARROWING. `civitai_app_store_scope_resolutions_total`
  // is the only instrument that can say what this function actually produced; if it
  // recorded the narrowed answer, a value that is not a scope at all would be
  // indistinguishable from a legitimately-resolved `none` and civitai#3983's central
  // observation (`{principal="anon", scope="undefined"}`) would have been erased by
  // the very change that closed the exposure.
  recordStoreScopeResolution(raw as string, opts?.user ? 'user' : 'anon');
  // 🔴 ENFORCE THE DECLARED CONTRACT AT RUNTIME, FAILING CLOSED. Every branch below
  // returns a literal, so this narrowing is unreachable by inspection — and in
  // production it is not: the counter above records `undefined` for the anonymous
  // principal on this exact build, and both REST entry points independently record
  // `absent` at their branch. Until that mechanism is identified, a declared return
  // type is a claim, not a guarantee, and the fail-open half of the split (the
  // listing service's `?? 'full'`) served the whole approved catalog — on-site apps
  // included — to unauthenticated callers. An uninterpretable value is not evidence
  // of an entitlement: it resolves to `none`.
  //
  // No extra log is emitted here on purpose. The counter above already carries the
  // discriminator — prom-client renders the raw label verbatim, so `scope="undefined"`,
  // `scope="[object Promise]"` and `scope="<unknown-string>"` are three different
  // series — and this runs on an unauthenticated, public endpoint where a per-request
  // log would be unbounded. Alert on
  // `store_scope_resolutions_total{scope!~"full|public-external|none"}`.
  const scope = narrowStoreScope(raw);
  if (scope === 'none' && opts?.user) reportSilentStoreGate(opts.user);
  return scope;
}

async function resolveStoreVisibilityScopeUninstrumented(opts?: {
  user?: SessionUser;
}): Promise<StoreVisibilityScopeValue> {
  // Axis 1 — the existing catalog-visibility gate (mods + app-dev-testers). MUST be
  // checked FIRST so a privileged viewer always gets `full`, never `public-external`
  // (the external flag can only ever LIFT a non-privileged viewer, never narrow a mod).
  if (await isAppListingsEnabled(opts)) return 'full';
  // Axis 2 — the external-only flag. Per-user eval when a user is present (so a
  // tester segment matches), global otherwise; a non-privileged viewer in the
  // cohort sees ONLY offsite listings.
  if (await isExternalListingsPublicEnabled(opts)) return 'public-external';
  // Fail-closed: neither flag → dark.
  return 'none';
}

/**
 * Resolve the viewer's LISTING AUDIENCE FLOOR — the narrowest per-listing visibility level
 * that still admits them.
 *
 * 🔴 THIS IS A SECOND AXIS, NOT A REPLACEMENT FOR {@link resolveStoreVisibilityScope}, and
 * the two are ANDed by the caller. The scope answers "may this viewer see the store at
 * all, and which KINDS" — a surface question. This answers "which per-listing levels admit
 * this viewer" — a cohort question. A listing at `public` is still invisible to a viewer
 * whose scope is `none`; nothing here can lift that.
 *
 * 🔴 THE TESTER COHORT IS READ OFF `app-blocks-enabled`, AND THAT CHOICE IS THE WHOLE
 * REASON THIS FEATURE NEEDS NO NEW FLAG. A level stores an ENUM and is mapped to a cohort
 * here, server-side, so no flag state is created, widened or referenced by key from the
 * database. The two existing flags already partition the population the way the levels
 * need:
 *   · `app-listings` is the SURFACE flag and is the one that widens to public at GA;
 *   · `app-blocks-enabled` is the runtime gate and stays mods + `app-dev-testers`
 *     segmented — this file says so where that flag is declared.
 * So post-GA a general viewer fails `app-blocks-enabled` and floors at `public`, while a
 * tester passes it and floors at `testers`, which is exactly the distinction the enum
 * draws.
 *
 * ⚠️ ALL FOUR LEVELS ARE ALREADY DISTINGUISHABLE — an earlier revision of this paragraph
 * claimed `testers` and `public` "admit the same population pre-GA", and that was false in
 * the REASSURING direction. A live floor-`public` population exists today: both public
 * `/api/v1/apps` endpoints pass `floor: 'public'` explicitly while
 * `resolvePublicAppsCatalogScope` grants an anonymous caller `full` SURFACE scope, so a
 * `testers` listing is hidden there while a `public` one is served. The two axes are
 * independent, which is the whole reason they are resolved separately.
 *
 * 🔴 FAIL-CLOSED IS `public`, WHICH READS BACKWARDS AND IS CORRECT. The floor is the
 * NARROWEST level that admits the viewer, so the least-privileged answer is the WIDEST
 * level — `public`, which admits them to nothing a level has restricted. An absent flag or
 * an unreachable Flipt makes `isFlipt` return `false`, so an unknown viewer floors at
 * `public` and sees only listings their owner marked public.
 *
 * Moderators short-circuit on the server-stamped session flag rather than on a flag eval,
 * for the same reason the private-run predicate does: a moderator is typically outside
 * every cohort segment, and requiring a flag for them would refuse the audience the
 * `moderators` level exists for.
 */
export async function resolveViewerAudienceFloor(opts?: {
  user?: SessionUser;
}): Promise<ListingAudienceFloor> {
  const user = opts?.user;
  if (user?.isModerator === true) return 'moderators';
  // Anonymous: no cohort to resolve, and a no-user eval would return the flag's BASE value
  // rather than denying (see GLOBAL-EVAL SEMANTICS at the top of this file). Answer the
  // least-privileged floor directly instead of asking a question that cannot refuse.
  if (!user) return 'public';
  return (await isAppBlocksEnabled({ user })) ? 'testers' : 'public';
}

/** The three flags a `full` / `public-external` scope can come from. */
const STORE_SCOPE_FLAGS = [
  APP_LISTINGS_FLAG,
  APP_BLOCKS_FLAG,
  APP_LISTINGS_PUBLIC_EXTERNAL_FLAG,
] as const;

/**
 * 🔴 DETECTION NET for the civitai#3983 failure mode: a store gate that denies
 * SILENTLY (empty grid, NOT_FOUND detail) and is therefore indistinguishable from an
 * empty catalog — to the viewer, to operators, and for the whole of that
 * investigation.
 *
 * The check is a RELATIONSHIP, not a component: the `/apps` page gate admits a viewer
 * on the SYNC evaluation of these same three flags (`isFliptSync` →
 * `featureFlags.appListings*` → `hasAppsStoreAccess`), while the read path admits them
 * on the ASYNC one. A logged-in viewer for whom the async side resolved `none` while
 * the sync side still says they hold a store flag is a state that should not exist —
 * it is exactly "reaches /apps, store is empty". Emitting it converts a silent
 * mis-gate into an alertable event.
 *
 * Deliberately narrow so it cannot become background noise: only a LOGGED-IN viewer
 * (anon has no page-gate pairing to contradict), only after the resolver already
 * answered `none`, and `isFliptSync` reuses the eval cache the awaited call above just
 * populated, so the re-read is a cache hit rather than three more wasm evaluations.
 * A `null` sync answer (client not initialized) is NOT a divergence — it is the
 * documented fall-through to static availability.
 */
function reportSilentStoreGate(user: SessionUser): void {
  try {
    const context = buildFliptContext(user);
    const entityId = String(user.id);
    const held = STORE_SCOPE_FLAGS.filter((flag) => isFliptSync(flag, entityId, context) === true);
    if (!held.length) return;
    for (const flag of held) recordStoreScopeDivergence(flag);
    logToAxiom({
      type: 'store-scope-divergence',
      message: 'store read scope resolved `none` for a logged-in viewer who holds a store flag',
      userId: user.id,
      heldFlags: [...held],
    }).catch(() => null);
  } catch {
    /* never throw from telemetry — a detection net must not break the read path */
  }
}
