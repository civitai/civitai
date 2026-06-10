import { randomBytes } from 'crypto';
import { error, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import { getProvider, createPkce, buildAuthorizeUrl } from '$lib/server/auth/providers';
import { readReturnUrl, readSync } from '$lib/server/auth/redirect';

// Start the upstream OAuth flow: stash state/PKCE-verifier + the returnUrl/sync we must honor
// after login, in short-lived cookies, then redirect to the provider's consent screen.
export const GET: RequestHandler = ({ params, url, cookies }) => {
  const provider = getProvider(params.provider);
  if (!provider || !provider.clientId() || !provider.clientSecret()) {
    error(404, 'Unknown or unconfigured provider');
  }

  const redirectUri = `${url.origin}/login/${provider.id}/callback`;
  const state = randomBytes(16).toString('hex');
  const { codeVerifier, codeChallenge } = createPkce();
  const returnUrl = readReturnUrl(url);
  const sync = readSync(url);

  const opts = { path: '/', httpOnly: true, secure: !dev, sameSite: 'lax' as const, maxAge: 600 };
  cookies.set('oauth_state', state, opts);
  cookies.set('oauth_verifier', codeVerifier, opts);
  cookies.set('oauth_return', returnUrl, opts);
  if (sync) cookies.set('oauth_sync', sync, opts);
  else cookies.delete('oauth_sync', { path: '/' });

  redirect(302, buildAuthorizeUrl(provider, { redirectUri, state, codeChallenge }));
};
