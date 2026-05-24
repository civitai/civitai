import { isFlipt } from '~/server/flipt/client';

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
 * The Flipt key is the canonical name; the FLAG_OVERRIDE env exists for unit
 * tests that need to flip the flag without standing up Flipt.
 */
export async function isAppBlocksEnabled(): Promise<boolean> {
  return isFlipt(APP_BLOCKS_FLAG);
}
