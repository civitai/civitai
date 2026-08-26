import { error, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import {
  getProvider,
  exchangeCode,
  fetchProfile,
  isStubProviderEnabled,
} from '$lib/server/auth/providers';
import {
  findOrCreateUser,
  linkAccountToUser,
  userExistsByEmail,
  isLinkedAccount,
} from '$lib/server/auth/users';
import {
  emailDomain,
  getBlockedEmailDomains,
  isBlockedDomain,
  normalizeEmailAddress,
} from '$lib/server/auth/blocklist';
import { establishSession } from '$lib/server/auth/session';
import { buildPostLoginRedirect } from '$lib/server/auth/redirect';
import { buildPostLoginOriginCheck } from '$lib/server/oauth/first-party';
import { blockedEmailDomainSignupsTotal, loginsTotal } from '$lib/server/metrics';

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

  // Clear flow cookies regardless of outcome.
  for (const name of [
    'oauth_state',
    'oauth_verifier',
    'oauth_return',
    'oauth_sync',
    'oauth_link',
  ]) {
    cookies.delete(name, { path: '/' });
  }

  if (!code || !state || !savedState || state !== savedState || !verifier) {
    error(400, 'Invalid OAuth state');
  }

  const redirectUri = `${url.origin}/login/${provider.id}/callback`;
  const { accessToken, scope } = await exchangeCode(provider, {
    code,
    redirectUri,
    codeVerifier: verifier,
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
      isBlockedDomain(await getBlockedEmailDomains(), domain) &&
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
      const retry = new URL('/login', url.origin);
      retry.searchParams.set('error', 'BlockedDomain');
      if (returnUrl && returnUrl !== '/') retry.searchParams.set('returnUrl', returnUrl);
      redirect(302, `${retry.pathname}${retry.search}`);
    }
  }

  // Standard login / signup — the hub sets the session cookie here.
  const user = await findOrCreateUser(provider.id, profile, scope);
  await establishSession(cookies, user);

  // Count the successful login AFTER the session is established (best-effort; never blocks the redirect).
  loginsTotal.inc({ provider: provider.id });

  // Honor returnUrl (validated + sync marker re-attached). No real returnUrl (user hit the hub directly) → send
  // to the main app via AUTH_DEFAULT_RETURN_URL, falling back to the hub-relative default when unset.
  const loginReturn =
    returnUrl === '/' && env.AUTH_DEFAULT_RETURN_URL ? env.AUTH_DEFAULT_RETURN_URL : returnUrl;
  redirect(302, buildPostLoginRedirect(loginReturn, sync, url.origin, dev, isAllowedOrigin));
};

// Append a query param to a (relative or absolute) returnUrl, preserving any hash.
function appendQuery(rawUrl: string, key: string, value: string): string {
  const [beforeHash, hash] = rawUrl.split('#');
  const sep = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${sep}${key}=${encodeURIComponent(value)}${hash ? `#${hash}` : ''}`;
}
