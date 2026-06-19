import { env } from '$env/dynamic/private';
import { isSecureCookie } from '@civitai/auth';

// Single source of truth for the auth cookies' `Domain` attribute (session + device). `AUTH_COOKIE_DOMAIN`
// overrides per-env; otherwise default to the shared parent so EVERY civitai.com subdomain (the app,
// moderator, test-auth, …) can read the hub's cookie instead of it being host-only on the hub.
//
// HTTPS-gated: on http/localhost a `.civitai.com` Domain would be rejected by the browser (the host doesn't
// match), so fall back to host-only (undefined) there. `isSecureCookie()` follows the hub's own protocol
// (AUTH_JWT_ISSUER) — the same signal used for the cookies' `Secure` attribute, so the two stay in lockstep.
const DEFAULT_COOKIE_DOMAIN = '.civitai.com';

export const cookieDomain = (): string | undefined =>
  env.AUTH_COOKIE_DOMAIN || (isSecureCookie() ? DEFAULT_COOKIE_DOMAIN : undefined);
