/**
 * redirect_uri policy + matching for the OAuth server.
 *
 * Two concerns live here:
 *  1. `isAllowedDcrRedirectUri` — the RFC 7591 registration allowlist. DCR is
 *     open and unauthenticated, so we only accept redirect targets that can't
 *     be abused as an open redirector or exfiltration channel:
 *       - https://<host>/...            (TLS, any host)
 *       - http://127.0.0.1[:port]/...   (IPv4 loopback)
 *       - http://[::1][:port]/...       (IPv6 loopback)
 *       - http://localhost[:port]/...   (loopback hostname)
 *     Rejected: non-loopback http, custom schemes, OOB
 *     (urn:ietf:wg:oauth:2.0:oob), data:, javascript:, etc.
 *
 *  2. `redirectUriMatches` — loopback-aware match used at /authorize. Native
 *     apps (per RFC 8252 §7.3) bind an ephemeral loopback port that the client
 *     can't know at registration time, so for loopback hosts we match
 *     scheme + host + path and IGNORE the port. For every other host we require
 *     an exact string match (the pre-existing behavior).
 */

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopbackHostname(hostname: string): boolean {
  // URL.hostname returns '[::1]' as '::1' (brackets stripped); normalize both.
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Validate a redirect_uri against the open-DCR allowlist.
 * Returns true if acceptable for a dynamically-registered public client.
 */
export function isAllowedDcrRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  // No fragment component is allowed in a redirect_uri (RFC 6749 §3.1.2).
  if (parsed.hash) return false;

  if (parsed.protocol === 'https:') {
    // Any TLS host is fine; reject empty host.
    return !!parsed.hostname;
  }

  if (parsed.protocol === 'http:') {
    // http is ONLY allowed for loopback addresses.
    return isLoopbackHostname(parsed.hostname);
  }

  // Custom schemes, urn: (OOB), data:, etc. are rejected.
  return false;
}

/**
 * Loopback-aware redirect_uri equality used at the /authorize endpoint to
 * match the incoming redirect_uri against a client's registered URIs.
 *
 * - For loopback hosts: match scheme + host + path, ignore the port (RFC 8252).
 * - For all other hosts: exact string match.
 */
export function redirectUriMatches(requested: string, registered: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(requested);
    b = new URL(registered);
  } catch {
    // Fall back to exact string comparison if either side won't parse.
    return requested === registered;
  }

  const bothLoopback = isLoopbackHostname(a.hostname) && isLoopbackHostname(b.hostname);
  if (bothLoopback) {
    return a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname;
  }

  return requested === registered;
}

/**
 * Does any registered URI match the requested one (loopback-aware)?
 */
export function isRegisteredRedirectUri(requested: string, registered: string[]): boolean {
  return registered.some((r) => redirectUriMatches(requested, r));
}
