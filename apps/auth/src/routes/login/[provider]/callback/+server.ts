import { error, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import {
  getProvider,
  exchangeCode,
  fetchProfile,
  isStubProviderEnabled,
  NO_PKCE_COOKIE,
} from '$lib/server/auth/providers';
import {
  findOrCreateUser,
  linkAccountToUser,
  userExistsByEmail,
  isLinkedAccount,
} from '$lib/server/auth/users';
import {
  emailDomain,
  isBlockedEmailDomain,
  normalizeEmailAddress,
} from '$lib/server/auth/blocklist';
import { establishSession } from '$lib/server/auth/session';
import { buildPostLoginRedirect } from '$lib/server/auth/redirect';
import { buildPostLoginOriginCheck } from '$lib/server/oauth/first-party';
import { blockedEmailDomainSignupsTotal, loginsTotal } from '$lib/server/metrics';
import { logToAxiom } from '$lib/server/axiom';

export const GET: RequestHandler = async ({ params, url, cookies, locals }) => {
  const provider = getProvider(params.provider);
  if (!provider) error(404, 'Unknown provider');
  // The e2e-only `stub` provider's callback is inert unless AUTH_ENABLE_STUB_PROVIDER is set (prod-inert),
  // matching the start route + listEnabledProviders.
  if (params.provider === 'stub' && !isStubProviderEnabled()) error(404, 'Unknown provider');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const savedState = cookies.get('oauth_state');
  const verifier = cookies.get('oauth_verifier');
  const returnUrl = cookies.get('oauth_return') ?? '/';
  const sync = cookies.get('oauth_sync') ?? null;
  const linkIntent = cookies.get('oauth_link') === '1';
  const noPkce =
    cookies.get(NO_PKCE_COOKIE) === provider.id && linkIntent && !!provider.incrementalSkipsPkce;

  // Clear flow cookies regardless of outcome.
  for (const name of [
    'oauth_state',
    'oauth_verifier',
    'oauth_return',
    'oauth_sync',
    'oauth_link',
    NO_PKCE_COOKIE,
  ]) {
    cookies.delete(name, { path: '/' });
  }

  // Provider refused (user cancelled, or e.g. `invalid_scope`): no code to exchange, so send the user
  // back to where the flow started.
  const providerError = url.searchParams.get('error');
  if (providerError) {
    const errorCode = providerError === 'access_denied' ? 'AccessDenied' : 'OAuthCallback';
    logCallbackFailure(provider.id, 'provider_error', linkIntent, providerError);
    if (linkIntent) {
      const target = appendQuery(returnUrl, 'error', errorCode);
      const isAllowedOrigin = await buildPostLoginOriginCheck();
      redirect(302, buildPostLoginRedirect(target, null, url.origin, dev, isAllowedOrigin));
    }
    redirect(302, loginRetry(url.origin, errorCode, returnUrl));
  }

  const missingVerifier = !verifier && !noPkce;
  if (!code || !state || !savedState || state !== savedState || missingVerifier) {
    const reason =
      !code || !state ? 'no_code' : !savedState || missingVerifier ? 'no_cookie' : 'state_mismatch';
    logCallbackFailure(provider.id, reason, linkIntent);
    error(400, 'Invalid OAuth state');
  }

  const redirectUri = `${url.origin}/login/${provider.id}/callback`;
  const { accessToken, scope } = await exchangeCode(provider, {
    code,
    redirectUri,
    codeVerifier: noPkce ? undefined : verifier,
  });
  const profile = await fetchProfile(provider, accessToken);
  // Normalize BEFORE anything reads it: `findOrCreateUser` both looks up and STORES this string,
  // and a trailing-dot variant would be a second row for one real mailbox.
  if (profile.email) profile.email = normalizeEmailAddress(profile.email);

  // Account-LINKING: attach this provider to the CURRENT user (no new user, no new session, no cross-domain
  // sync). On conflict, bounce back with an error the account page surfaces. The session must STILL be present
  // (it rides the callback as a Lax cookie) — if it was lost between start and callback, fail rather than fall
  // through to login/create, which could silently switch the user to a different account.
  // Resolve the registry-aware origin allow-check once (cached); reused by both redirect paths below.
  const isAllowedOrigin = await buildPostLoginOriginCheck();

  if (linkIntent) {
    if (!locals.user) error(401, 'Session expired — sign in and try linking again');
    const result = await linkAccountToUser(locals.user.id, provider.id, profile, scope);
    const target =
      result === 'conflict' ? appendQuery(returnUrl, 'error', 'AccountNotLinked') : returnUrl;
    redirect(302, buildPostLoginRedirect(target, null, url.origin, dev, isAllowedOrigin));
  }

  // Blocked email domains, OAuth edge of the same gate the email action applies. A provider-VERIFIED
  // address is deliverable by construction, so the blocklist is the whole check here — no MX probe.
  // Ordered blocklist-first so the two lookups below only run for an address that is actually
  // blocked; a returning user (linked account, or an existing row on that address) is exempt for the
  // same reason as the email action — a domain appended upstream later must not lock anyone out.
  if (profile.email && profile.emailVerified) {
    const domain = emailDomain(profile.email);
    if (
      domain &&
      (await isBlockedEmailDomain(domain)) &&
      !(await isLinkedAccount(provider.id, profile.providerAccountId)) &&
      !(await userExistsByEmail(profile.email))
    ) {
      blockedEmailDomainSignupsTotal.inc({ path: 'oauth' });
      // NOT `error(400)`. This is a top-level browser navigation and apps/auth ships no
      // +error.svelte, so a throw here renders SvelteKit's bare fallback page with no way back --
      // and the flow cookies that would let them retry were already deleted above. Send them to the
      // hub's own login page, which is what the email half of this same gate effectively does.
      // `returnUrl` was read at the top, BEFORE the flow cookies were deleted, so a successful
      // retry still lands where they started rather than at AUTH_DEFAULT_RETURN_URL.
      redirect(302, loginRetry(url.origin, 'BlockedDomain', returnUrl));
    }
  }

  // Standard login / signup — the hub sets the session cookie here.
  const user = await findOrCreateUser(provider.id, profile, scope);
  await establishSession(cookies, user, { returnUrl });

  // Count the successful login AFTER the session is established (best-effort; never blocks the redirect).
  loginsTotal.inc({ provider: provider.id });

  // Honor returnUrl (validated + sync marker re-attached). No real returnUrl (user hit the hub directly) → send
  // to the main app via AUTH_DEFAULT_RETURN_URL, falling back to the hub-relative default when unset.
  const loginReturn =
    returnUrl === '/' && env.AUTH_DEFAULT_RETURN_URL ? env.AUTH_DEFAULT_RETURN_URL : returnUrl;
  redirect(302, buildPostLoginRedirect(loginReturn, sync, url.origin, dev, isAllowedOrigin));
};

// The hub login page with an error to show, keeping a real returnUrl so a retry lands where the user started.
function loginRetry(origin: string, errorCode: string, returnUrl: string): string {
  const retry = new URL('/login', origin);
  retry.searchParams.set('error', errorCode);
  if (returnUrl && returnUrl !== '/') retry.searchParams.set('returnUrl', returnUrl);
  return `${retry.pathname}${retry.search}`;
}

// Never log the code, state, or free-form provider text.
function logCallbackFailure(
  provider: string,
  reason: 'provider_error' | 'no_code' | 'no_cookie' | 'state_mismatch',
  link: boolean,
  providerError?: string
) {
  void logToAxiom({
    type: 'warn',
    name: 'oauth-callback-failed',
    provider,
    reason,
    link,
    ...(providerError && {
      providerError: /^[a-z_]{1,64}$/.test(providerError) ? providerError : 'unrecognised',
    }),
  }).catch(() => undefined);
}

// Append a query param to a (relative or absolute) returnUrl, preserving any hash.
function appendQuery(rawUrl: string, key: string, value: string): string {
  const [beforeHash, hash] = rawUrl.split('#');
  const sep = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${sep}${key}=${encodeURIComponent(value)}${hash ? `#${hash}` : ''}`;
}
