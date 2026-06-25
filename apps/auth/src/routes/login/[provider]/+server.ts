import { randomBytes } from 'crypto';
import { error, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import { getProvider, createPkce, buildAuthorizeUrl } from '$lib/server/auth/providers';
import { readReturnUrl, readSync } from '$lib/server/auth/redirect';
import { checkRateLimit } from '$lib/server/auth/rate-limit';

// Start the upstream OAuth flow: stash state/PKCE-verifier + the returnUrl/sync we must honor
// after login, in short-lived cookies, then redirect to the provider's consent screen.
// `?link=true` is the account-LINKING intent (the "Connect <provider>" flow): it requires an active session
// and tells the callback to attach the provider to the CURRENT user instead of logging in / creating one.
export const GET: RequestHandler = async ({ params, url, cookies, locals, getClientAddress }) => {
  // Rate limit per IP — bounds redirect/cookie churn from someone hammering the login start.
  if (!(await checkRateLimit('oauth-start', getClientAddress(), 30, 60))) {
    error(429, 'Too many requests');
  }

  const provider = getProvider(params.provider);
  if (!provider || !provider.clientId() || !provider.clientSecret()) {
    error(404, 'Unknown or unconfigured provider');
  }

  const link = url.searchParams.get('link') === 'true';
  if (link && !locals.user) error(401, 'must be signed in to link an account');

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
  if (link) cookies.set('oauth_link', '1', opts);
  else cookies.delete('oauth_link', { path: '/' });

  // `prompt` (e.g. select_account) is forwarded straight to the provider — it only affects the consent screen,
  // so it needs no round-trip cookie like returnUrl/sync/link do.
  const prompt = url.searchParams.get('prompt');

  // `roles=true` opts into the provider's incremental scope (Discord Linked Roles — role_connections.write).
  // The actual scope is server-defined (provider.incrementalScope); this is just the boolean intent. Used by
  // the /discord/link-role flow, which sends it alongside link=true.
  const incremental = url.searchParams.get('roles') === 'true';

  redirect(
    302,
    buildAuthorizeUrl(provider, { redirectUri, state, codeChallenge, prompt, incremental })
  );
};
