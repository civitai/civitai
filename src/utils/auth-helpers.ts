import { signIn } from 'next-auth/react';
import { env } from '~/env/client';

// Auth proxy URL for PR previews - hardcoded as fallback since env vars may not be
// baked in at build time for newly added variables
const PR_PREVIEW_AUTH_PROXY = 'https://auth.civitaic.com';

/**
 * Check if we're running on a PR preview subdomain (pr-*.civitaic.com)
 */
function isPrPreview(): boolean {
  if (typeof window === 'undefined') return false;
  return /^pr-\d+\.civitaic\.com$/.test(window.location.hostname);
}

/**
 * Get the auth proxy URL - either from env var or by detecting PR preview hostname.
 * Uses nullish coalescing to ensure the fallback code is not tree-shaken.
 */
function getAuthProxyUrl(): string | undefined {
  // Try env var first, then fallback to hostname detection for PR previews
  // Using ?? ensures both branches are preserved in the bundle
  return (
    env.NEXT_PUBLIC_AUTH_PROXY_URL ??
    (isPrPreview() ? PR_PREVIEW_AUTH_PROXY : undefined)
  );
}

/**
 * Handle sign-in through auth proxy if configured (for PR previews).
 * This redirects OAuth flows through a shared auth endpoint that has registered OAuth callbacks.
 *
 * For PR previews (detected by env var or hostname pattern):
 * - Redirects to auth proxy for OAuth flow
 * - After OAuth completes, user is redirected back to the original site
 * - Session cookie works across subdomains due to NEXTAUTH_COOKIE_DOMAIN setting
 *
 * For regular environments:
 * - Uses NextAuth's built-in signIn function
 */
export function handleSignIn(providerId: string, callbackUrl: string) {
  const authProxyUrl = getAuthProxyUrl();

  if (authProxyUrl && typeof window !== 'undefined') {
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
