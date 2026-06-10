import { error, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import { getProvider, exchangeCode, fetchProfile } from '$lib/server/auth/providers';
import { findOrCreateUser } from '$lib/server/auth/users';
import { establishSession } from '$lib/server/auth/session';
import { buildPostLoginRedirect } from '$lib/server/auth/redirect';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
  const provider = getProvider(params.provider);
  if (!provider) error(404, 'Unknown provider');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const savedState = cookies.get('oauth_state');
  const verifier = cookies.get('oauth_verifier');
  const returnUrl = cookies.get('oauth_return') ?? '/';
  const sync = cookies.get('oauth_sync') ?? null;

  // Clear flow cookies regardless of outcome.
  for (const name of ['oauth_state', 'oauth_verifier', 'oauth_return', 'oauth_sync']) {
    cookies.delete(name, { path: '/' });
  }

  if (!code || !state || !savedState || state !== savedState || !verifier) {
    error(400, 'Invalid OAuth state');
  }

  const redirectUri = `${url.origin}/login/${provider.id}/callback`;
  const accessToken = await exchangeCode(provider, { code, redirectUri, codeVerifier: verifier });
  const profile = await fetchProfile(provider, accessToken);
  const user = await findOrCreateUser(provider.id, profile);

  await establishSession(cookies, user);

  // Honor returnUrl (validated to civitai origins) and re-attach the cross-domain sync marker
  // so a different-root destination pulls the session from this hub.
  redirect(302, buildPostLoginRedirect(returnUrl, sync, url.origin, dev));
};
