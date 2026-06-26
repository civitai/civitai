import { error, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { SYNC_PARAM } from '@civitai/auth';
import type { RequestHandler } from './$types';
import { consumeVerificationToken } from '$lib/server/auth/email-tokens';
import { findOrCreateUserByEmail } from '$lib/server/auth/users';
import { establishSession } from '$lib/server/auth/session';
import { buildPostLoginRedirect } from '$lib/server/auth/redirect';
import { buildPostLoginOriginCheck } from '$lib/server/oauth/first-party';
import { loginsTotal } from '$lib/server/metrics';

// Magic-link landing: validate + consume the token, establish the session, honor returnUrl/sync.
export const GET: RequestHandler = async ({ url, cookies }) => {
  const token = url.searchParams.get('token');
  const email = url.searchParams.get('email')?.toLowerCase();
  const returnUrl = url.searchParams.get('returnUrl') ?? '/';
  const sync = url.searchParams.get(SYNC_PARAM);

  if (!token || !email) error(400, 'Invalid verification link');

  const valid = await consumeVerificationToken(email, token);
  if (!valid) redirect(302, '/login?error=Verification');

  const user = await findOrCreateUserByEmail(email);
  await establishSession(cookies, user);

  // Count the successful email login (best-effort; never blocks the redirect).
  loginsTotal.inc({ provider: 'email' });

  const isAllowedOrigin = await buildPostLoginOriginCheck();
  redirect(302, buildPostLoginRedirect(returnUrl, sync, url.origin, dev, isAllowedOrigin));
};
