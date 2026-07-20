import type { SessionUser } from '~/types/session';
import { isFlipt } from '~/server/flipt/client';
import { buildFliptContext } from '~/server/services/feature-flags.service';

const APP_BLOCKS_FLAG = 'app-blocks-enabled';

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
 * The FLAG_OVERRIDE/local-overrides env exists for unit tests + local dev that
 * need to flip the flag without standing up Flipt.
 */
export async function isAppBlocksEnabled(opts?: { user?: SessionUser }): Promise<boolean> {
  // No user supplied → preserve the original global eval for the machine /
  // anonymous gates (webhooks, JWKS). Their callers are unchanged.
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
 *   - The `app-listings` flag does NOT exist in Flipt at merge time (created
 *     AFTER, as a companion `flipt-state` PR). A bare eval of an absent flag
 *     resolves `false` for EVERYONE — which would REGRESS the currently-visible
 *     cohort (mods + the `app-dev-testers` segment of `app-blocks-enabled`) the
 *     instant this merges. The OR-fallback to `app-blocks-enabled` preserves
 *     their store access verbatim through the transition window.
 *   - Because `app-blocks-enabled` already grants the mods + app-dev-testers
 *     cohort today, `isAppListingsEnabled` grants EXACTLY that same set until the
 *     `app-listings` flag is created and later widened — so the as-merged change
 *     is a NO-OP on visibility (zero behavior change today).
 *
 * Remove the `|| isAppBlocksEnabled` fallback ONLY after the store widens past
 * the `app-blocks-enabled` cohort (i.e. once `app-listings` is the sole, wider
 * source of truth); until then the fallback is what keeps existing viewers in.
 *
 * No user → preserve a global eval of `app-listings` that can never match a
 * segment, then fall through to the no-arg `isAppBlocksEnabled()` global eval —
 * fail-closed, identical to today's no-arg store-read behaviour.
 */
export async function isAppListingsEnabled(opts?: { user?: SessionUser }): Promise<boolean> {
  const user = opts?.user;
  // Per-user eval of the dedicated visibility flag — same entityId + context
  // shape as isAppBlocksEnabled, so the `app-listings` segment resolves
  // identically to the client/hasFeature gate. No user → global eval (never
  // matches a segment).
  const listingsOn = user
    ? await isFlipt(APP_LISTINGS_FLAG, String(user.id), buildFliptContext(user))
    : await isFlipt(APP_LISTINGS_FLAG);
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
 * Fail-CLOSED: a non-mod with no `app-blocks-author` grant (flag absent, Flipt
 * down, or segment miss) → `isFlipt` false → denied. Only mods (floor) and the
 * flag-granted cohort pass. A vanished/undefined user → no floor + global eval
 * (can never match a segment) → denied.
 */
export async function isAppBlocksAuthorEnabled(opts?: { user?: SessionUser }): Promise<boolean> {
  const user = opts?.user;
  // Moderator floor — the `availability: ['mod']` static fallback. Keeps mods'
  // existing author access intact while the Flipt flag is absent (dark window)
  // and regardless of how the flag's segments are later configured.
  if (user?.isModerator) return true;
  // No user → preserve a global eval that can never match a segment (fail-closed).
  if (!user) return isFlipt(APP_BLOCKS_AUTHOR_FLAG);
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
 * (`entityId='global'`, empty context), so a segment-targeted flag would never
 * match and resolve `false`, silently leaving runtime DARK (blocks mysteriously
 * fail to verify). Fail-safe direction, but a confusing misconfig.
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
 * `isAppBlocksReviewSandboxEnabled`. No user → preserves a global eval that can
 * never match a segment (fail-closed). See APP_BLOCKS_DEV_TUNNEL_FLAG.
 *
 * NOTE: unlike `isAppBlocksAuthorEnabled`, there is NO moderator static floor —
 * the flag is created as the rollout, so an absent flag resolves `false` for
 * EVERYONE (mods included). That is intentional and load-bearing: the dev tunnel
 * is a brand-new surface (no existing mod access to preserve), so fail-closed for
 * all until the flag exists is the safe posture.
 */
export async function isAppBlocksDevTunnelEnabled(opts?: {
  user?: SessionUser;
}): Promise<boolean> {
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
 * boolean in Flipt (NOT segmented), or it would never resolve true.
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
 * `isAppBlocksEnabled({ user })`. No user → preserves a global eval that can
 * never match the segment (fail-closed). See APP_BLOCKS_REVIEW_SANDBOX_FLAG.
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
 * `isAppBlocksReviewSandboxEnabled({ user })`. No user → preserves a global eval
 * that can never match the segment (fail-closed), and an absent flag also
 * evaluates false (fail-closed). See APP_BLOCKS_AGENTIC_REVIEW_FLAG.
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
 * (`getSessionUserById`), not a session — anon reads pass no user → global eval
 * that can never match a segment → fail-closed (anon shared access is a GA-only
 * widening, safe to stay dark until a base-`enabled` flip).
 *
 * Create it in Flipt as base `enabled: false` with the `moderators` segment (+
 * any community-cohort segment) exactly like `app-blocks-dev-tunnel`. The flag
 * does NOT exist in Flipt at merge time — the companion `flipt-state` entry is a
 * SEPARATE follow-up PR — so the as-merged posture is fully dark and cannot
 * regress the gate open.
 */
export const APP_BLOCKS_SHARED_STORAGE_FLAG = 'app-blocks-shared-storage';

export async function isAppBlocksSharedStorageEnabled(opts?: {
  user?: SessionUser;
}): Promise<boolean> {
  if (!opts?.user) return isFlipt(APP_BLOCKS_SHARED_STORAGE_FLAG);
  const user = opts.user;
  return isFlipt(APP_BLOCKS_SHARED_STORAGE_FLAG, String(user.id), buildFliptContext(user));
}
