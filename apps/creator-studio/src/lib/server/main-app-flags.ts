import type { SessionUser } from '@civitai/auth';
import { getFlipt, fliptContext } from '$lib/server/flipt';

/**
 * 🔴 For a Flipt key that also drives a main-app feature flag declared `availability: ['mod']` +
 * `fliptKey`. Must keep that flag's Flipt-down posture: one flag drives both apps, and an app that
 * fails to a different answer produces the half-visible state the single flag exists to prevent.
 *
 * The fallback keys on a null EVALUATION, not on the client being absent: `isEnabledSync` returns
 * null for an unreachable client and for a flag that does not exist yet, which is the normal state
 * of a feature that ships dark. `isEnabled` would collapse both to false and lock moderators out of
 * a page the main app is already showing them.
 */
export async function modFallbackFlagEnabled(flag: string, user: SessionUser): Promise<boolean> {
  const flipt = getFlipt();
  await flipt.ensureInitialized();

  const evaluated = flipt.isEnabledSync(flag, String(user.id), fliptContext(user));
  return evaluated ?? user.isModerator === true;
}
