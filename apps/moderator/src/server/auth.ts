// SPOKE verifier for the moderator app (`*.civitai.com` subdomain). It shares the hub's
// `.civitai.com` cookie for free, so it just verifies the JWT locally via JWKS and redirects
// to the hub on miss. No login UI, no providers.
//
// This spoke has no redis client, so revocation is NOT injected — it's a signature-only
// gate. Acceptable because: (a) the session token is short-lived relative to ban response
// needs, and (b) any mutating action still flows through a server handler that can do the
// authoritative revocation check. If real-time revocation is required here, give the app a
// `@civitai/redis` client and inject `isRevoked` like the main app's session-verifier.ts.
import { createAuthVerifier } from '@civitai/auth';

export const auth = createAuthVerifier();

// Usage in a server component / route / proxy.ts:
//   const result = await auth.requireAuth(headers().get('cookie') ?? '', currentUrl);
//   if ('redirect' in result) redirect(result.redirect);
//   const user = result.session.user;
