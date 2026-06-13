import type { SessionUser } from 'next-auth';
import { isFlipt } from '~/server/flipt/client';
import { buildFliptContext } from '~/server/services/feature-flags.service';

const APP_BLOCKS_FLAG = 'app-blocks-enabled';

/**
 * Server-side check for the App Blocks feature flag.
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
 *   evaluate a mod-segmented flag. The internal webhooks (`build-callback`,
 *   `git-push`, `workflow-completed`, the JOB_TOKEN-authed manifest registrar)
 *   and the JWKS public-key endpoint call this with no argument → the original
 *   GLOBAL eval (`entityId='global'`, empty context). They are deliberately
 *   left on the global path: the build/publish PIPELINE therefore still
 *   requires a GLOBAL enable of `app-blocks-enabled` to run. That is an
 *   intentional, separate decision — a future dedicated
 *   `app-blocks-pipeline-enabled` global flag should own the pipeline so the
 *   mod-segmented user flag and the machine pipeline flag can move
 *   independently. Until then, do NOT fabricate user context for the machine
 *   gates (the no-arg overload below preserves their existing behaviour).
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
