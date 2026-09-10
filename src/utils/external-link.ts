// The port is stripped because the two sides are asymmetric: an href is compared as
// `url.hostname`, which never carries one, while `internalHosts` entries come from
// `window.location.host`, which does. Left in, every absolute internal link warns on :3000.
const normalizeHost = (host: string) =>
  host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');

/**
 * Whether following `href` leaves Civitai.
 *
 * 🔴 Not a suffix match. `evil-civitai.com` and `civitai.com.evil.test` both end in a string
 * a suffix test would accept, and `cdn.civitai.com` is a different origin with a different
 * owner. Hosts are compared whole.
 *
 * Anything this cannot resolve to an http(s) origin — a relative path, a fragment, a
 * `mailto:` — is internal. Failing the other way would put an interstitial in front of every
 * unparseable href on the site.
 */
export function isExternalHref(href: string, internalHosts: readonly string[]): boolean {
  const value = href.trim();
  if (!value) return false;

  // `new URL` resolves a scheme-relative `//evil.com` against the base, so the base has to be
  // a host that can never be in `internalHosts`, or the answer would depend on the base.
  const url = (() => {
    try {
      return new URL(value, 'https://invalid.');
    } catch {
      return null;
    }
  })();

  if (!url || !['http:', 'https:'].includes(url.protocol)) return false;
  if (url.hostname === 'invalid.') return false;

  const host = normalizeHost(url.hostname);
  return !internalHosts.some((internal) => normalizeHost(internal) === host);
}
