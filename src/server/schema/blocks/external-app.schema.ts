/**
 * App Blocks — off-site (external-link) apps.
 *
 * PURE EXTERNAL LINK product model: a marketplace listing whose only action is
 * to open an external URL in a new tab. NO install, NO scopes, NO block token,
 * NO subscription, NO on-platform iframe/page hosting. The presence of
 * `externalUrl` on the AppBlock row is the discriminator (no separate appType
 * enum). Because there is nothing hosted on-platform, registering an external
 * app SKIPS the bundle / `<slug>.<APPS_DOMAIN>` validation the embedded-app
 * approve flow runs — there's nothing on-platform to validate.
 *
 * Mutual exclusivity: an external app must NOT also declare an on-platform
 * surface (a page or any iframe/target slot). The validator below is the single
 * source of truth for both the https:// shape check AND the
 * external-vs-on-platform conflict, so the schema, the service, and the tests
 * can't drift.
 */

/** Max length for a stored external URL (defensive bound; well above any real URL). */
export const MAX_EXTERNAL_URL_LENGTH = 2048;

export type ExternalUrlValidation =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * Validate a candidate external-link URL. Returns the parsed (whitespace-trimmed)
 * https:// URL string on success, or a human-readable error.
 *
 * NOTE: the returned `url` is the WHATWG-parsed serialization of the input, NOT a
 * sanitized/canonicalized safe URL — it is only guaranteed to be an https URL with
 * a host and NO embedded credentials. It is NOT DNS-resolved and NOT SSRF-checked;
 * a server-side fetch of it must still go through the hardened `safeFetch`.
 *
 * Rules (deterministic, no heuristics):
 *   - parses as an absolute URL,
 *   - scheme is EXACTLY https (http / javascript / data / mailto / etc. are
 *     rejected — a marketplace card link opens in the user's browser, so a
 *     non-https or non-http scheme is a phishing / XSS vector),
 *   - has a host,
 *   - carries NO userinfo (`user:pass@host`) — `https://example.com@evil.com`
 *     displays as `example.com` but resolves to `evil.com`, a display-vs-real-host
 *     phishing vector; reject it outright,
 *   - within the length bound.
 */
export function validateExternalUrl(raw: unknown): ExternalUrlValidation {
  if (typeof raw !== 'string') return { ok: false, error: 'externalUrl must be a string' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: 'externalUrl must not be empty' };
  if (trimmed.length > MAX_EXTERNAL_URL_LENGTH) {
    return { ok: false, error: `externalUrl must be ≤ ${MAX_EXTERNAL_URL_LENGTH} chars` };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `externalUrl "${trimmed}" is not a valid absolute URL` };
  }
  // `URL.protocol` includes the trailing colon.
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: `externalUrl must be an https:// URL (got "${parsed.protocol}//")` };
  }
  if (!parsed.host) {
    return { ok: false, error: 'externalUrl must include a host' };
  }
  // Reject embedded credentials — `https://example.com@evil.com` renders the
  // trusted-looking `example.com` but the REAL host is `evil.com`.
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'externalUrl must not contain credentials (user:pass@host)' };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * Minimal manifest shape an external-link registration may carry. An external
 * app is a pure listing, so the only honoured fields are display metadata. A
 * `page` object or any `targets` entry means the publisher is declaring an
 * on-platform surface — which is mutually exclusive with the external-link
 * model and must be rejected (NOT silently dropped, so the publisher isn't
 * surprised later when the on-platform surface they declared doesn't exist).
 */
export type ExternalAppManifestInput = {
  name?: unknown;
  description?: unknown;
  page?: unknown;
  targets?: unknown;
  iframe?: unknown;
};

export type ExternalManifestValidation =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Assert a manifest does NOT declare any on-platform hosting surface. Used at
 * external-app registration: an external app links OUT, so a page / iframe /
 * target slot is a contradiction.
 */
export function assertNoOnPlatformSurface(manifest: ExternalAppManifestInput): ExternalManifestValidation {
  const page = manifest.page;
  if (page && typeof page === 'object') {
    return {
      ok: false,
      error: 'an external-link app must not declare a page surface (it links off-site)',
    };
  }
  if (Array.isArray(manifest.targets) && manifest.targets.length > 0) {
    return {
      ok: false,
      error: 'an external-link app must not declare target slots (it links off-site)',
    };
  }
  if (manifest.iframe && typeof manifest.iframe === 'object') {
    return {
      ok: false,
      error: 'an external-link app must not declare an iframe surface (it links off-site)',
    };
  }
  return { ok: true };
}
