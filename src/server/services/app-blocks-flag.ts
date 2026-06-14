import type { SessionUser } from 'next-auth';
import { isFlipt } from '~/server/flipt/client';
import { buildFliptContext } from '~/server/services/feature-flags.service';

const APP_BLOCKS_FLAG = 'app-blocks-enabled';

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
