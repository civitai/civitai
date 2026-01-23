import { signIn } from 'next-auth/react';
// Keep env import for potential initialization side effects
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { env } from '~/env/client';

/**
 * Detect if we're running on a PR preview environment.
 * PR previews use the pattern pr-{number}.civitaic.com
 */
function isPrPreview(): boolean {
  if (typeof window === 'undefined') return false;
  return /^pr-\d+\.civitaic\.com$/.test(window.location.hostname);
}

/**
 * Get the auth proxy URL for PR previews.
 * Returns null if not a PR preview or if running server-side.
 */
function getAuthProxyUrl(): string | null {
  if (!isPrPreview()) return null;
  return 'https://auth.civitaic.com';
}

/**
 * Handle sign-in through auth proxy for PR previews.
 * This redirects OAuth flows through a shared auth endpoint that has registered OAuth callbacks.
 *
 * On PR previews (pr-*.civitaic.com):
 * - Redirects to auth.civitaic.com for OAuth flow
 * - After OAuth completes, user is redirected back to the PR preview
 * - Session cookie works across subdomains due to NEXTAUTH_COOKIE_DOMAIN setting
 *
 * On other environments:
 * - Uses NextAuth's built-in signIn function
 */
export function handleSignIn(providerId: string, callbackUrl: string) {
  const authProxyUrl = getAuthProxyUrl();

  if (authProxyUrl) {
    // For PR previews: redirect to auth proxy with full return URL
    const fullCallbackUrl = callbackUrl.startsWith('http')
      ? callbackUrl
      : `${window.location.origin}${callbackUrl.startsWith('/') ? callbackUrl : '/' + callbackUrl}`;

    window.location.href = `${authProxyUrl}/api/auth/signin/${providerId}?callbackUrl=${encodeURIComponent(fullCallbackUrl)}`;
  } else {
    // Normal flow: use NextAuth's built-in signIn
    signIn(providerId, { callbackUrl });
  }
}
