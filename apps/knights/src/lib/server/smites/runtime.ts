import { env } from '$env/dynamic/private';
import { resetPlayerInMainApp } from './main-app';
import type { ResetDeps } from './smites.service';

export const resetDeps: ResetDeps = { resetPlayer: resetPlayerInMainApp };

/** Key for the sealed feed item ids. The feed fails closed without it. */
export function feedSecret(): string {
  const secret = env.FEED_TOKEN_SECRET?.trim();
  if (!secret) throw new Error('FEED_TOKEN_SECRET is not configured; the feed cannot be served');
  return secret;
}
