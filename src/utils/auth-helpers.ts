import { signIn } from 'next-auth/react';
import { env } from '~/env/client';

/**
 * Handle sign-in through auth proxy if configured (for PR previews).
 * This redirects OAuth flows through a shared auth endpoint that has registered OAuth callbacks.
 *
 * When NEXT_PUBLIC_AUTH_PROXY_URL is set:
 * - Redirects to auth proxy for OAuth flow
 * - After OAuth completes, user is redirected back to the original site
 * - Session cookie works across subdomains due to NEXTAUTH_COOKIE_DOMAIN setting
 *
 * When not set:
 * - Uses NextAuth's built-in signIn function
 */
export function handleSignIn(providerId: string, callbackUrl: string) {
  const authProxyUrl = env.NEXT_PUBLIC_AUTH_PROXY_URL;

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
