import { env } from '$env/dynamic/private';
import { apprenticeSettings } from '../apprenticeship/config';
import { storedSettings } from '../settings/runtime';
import { resetPlayerInMainApp } from './main-app';
import type { ResetDeps } from './smites.service';

export const resetDeps: ResetDeps = {
  resetPlayer: resetPlayerInMainApp,
  // Read per call so a changed environment or a saved switch is picked up without a rebuild.
  acolyteSmites: async () => apprenticeSettings(env, await storedSettings()).smites,
};

/** Key for the sealed feed item ids. The feed fails closed without it. */
export function feedSecret(): string {
  const secret = env.FEED_TOKEN_SECRET?.trim();
  if (!secret) throw new Error('FEED_TOKEN_SECRET is not configured; the feed cannot be served');
  return secret;
}
