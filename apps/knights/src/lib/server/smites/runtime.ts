import { env } from '$env/dynamic/private';
import { resetPlayerInMainApp } from './main-app';
import type { ResetDeps } from './smites.service';

export const resetDeps: ResetDeps = { resetPlayer: resetPlayerInMainApp };

/** Key for the sealed feed item ids. */
export function feedSecret(): string {
  const secret = env.FEED_TOKEN_SECRET || env.JOBS_TOKEN;
  if (!secret) throw new Error('FEED_TOKEN_SECRET is not configured');
  return secret;
}
