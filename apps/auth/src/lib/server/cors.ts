import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';

// SAME-SITE spoke origins allowed to call the hub's /api/auth/* endpoints DIRECTLY from the browser with
// credentials — so a `*.civitai.com` app (e.g. moderator.civitai.com) can use @civitai/auth's
// createAuthBrowserClient instead of building its own same-origin proxies. These are different origins from the
// hub (CORS applies) but the SAME site, so their cookies ride along and the hub's Set-Cookie is accepted.
//
// DISTINCT from the `TrustedSpokeDomain` table, the CROSS-site first-party login registry for `.red` (the
// auth-code flow's redirect_uri host registry). A cross-site origin must NOT go here — it can't send
// cookies on a cross-site fetch, so credentialed CORS is useless to it; it uses the auth-code login flow.
//
// Exact origins, comma-separated, e.g. "https://moderator.civitai.com". localhost (any port) is allowed only in
// dev. An empty/unset value means no spoke uses the direct browser client (the main app goes through proxies).
const ALLOWED = new Set(
  (env.AUTH_CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
);

/** The exact origin to echo back in `Access-Control-Allow-Origin`, or null if this origin isn't allowed. */
export function allowedCorsOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (ALLOWED.has(origin)) return origin;
  if (dev) {
    try {
      const { hostname } = new URL(origin);
      if (hostname === 'localhost' || hostname === '127.0.0.1') return origin;
    } catch {
      return null;
    }
  }
  return null;
}
