// Ported from the main app's redirectUriMatches in src/server/schema/oauth-client.schema.ts (the hub has
// no oauth-client zod schema — only the matcher is needed by the OAuth model's validateRedirectUri).

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Does `provided` match one of the client's registered redirect URIs?
 *
 * Exact match for everything, PLUS RFC 8252 §7.3 port flexibility for loopback
 * redirects: a registered `http://localhost:18188/civitai/callback` also matches
 * `http://localhost:<any-port>/civitai/callback`. Native/desktop apps (e.g. the
 * ComfyUI node pack) can't pin a fixed loopback port — the OS may reserve it
 * (Windows excluded ranges) — so they bind a free port at runtime. Loopback
 * redirects target the user's own machine, so the port is not a security
 * boundary; non-loopback (https) URIs still require an exact match.
 */
export function redirectUriMatches(registeredUris: string[], provided: string): boolean {
  if (registeredUris.includes(provided)) return true;
  let providedUrl: URL;
  try {
    providedUrl = new URL(provided);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(providedUrl.hostname)) return false;
  return registeredUris.some((uri) => {
    try {
      const registered = new URL(uri);
      return (
        LOOPBACK_HOSTS.has(registered.hostname) &&
        registered.protocol === providedUrl.protocol &&
        registered.pathname === providedUrl.pathname
      );
    } catch {
      return false;
    }
  });
}

/**
 * The error response URL for a client whose `redirectUri` has already been checked with
 * redirectUriMatches (RFC 6749 §4.1.2.1): `?error=…&error_description=…&state=…`.
 */
export function clientErrorUrl(
  redirectUri: string,
  state: string | undefined,
  error: string,
  description?: string
): string {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error);
  if (description) target.searchParams.set('error_description', description);
  if (state) target.searchParams.set('state', state);
  return target.toString();
}
