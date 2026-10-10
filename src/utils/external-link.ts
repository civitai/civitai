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
  const url = resolveHttpHref(href);
  if (!url) return false;

  const host = normalizeHost(url.hostname);
  return !internalHosts.some((internal) => normalizeHost(internal) === host);
}

/**
 * `href` as an absolute http(s) URL with a real host, or null. Shared by `isExternalHref` and
 * `externalLinkInterstitialHref` because they must agree: a link the first calls external has to
 * reach `/leaving` as a destination the page accepts.
 */
function resolveHttpHref(href: string): URL | null {
  // `new URL` resolves a scheme-relative `//evil.com` against the base, so the base has to be
  // a host that can never be in `internalHosts`, or the answer would depend on the base.
  const url = (() => {
    try {
      return new URL(href.trim(), 'https://invalid.');
    } catch {
      return null;
    }
  })();

  if (!url || !['http:', 'https:'].includes(url.protocol)) return null;
  if (url.hostname === 'invalid.') return null;
  return url;
}

const EXTERNAL_LINK_INTERSTITIAL_PATH = '/leaving';

/**
 * The absolute http(s) URL the leaving-Civitai page may offer as a link, or null.
 *
 * 🔴 The page takes this from its query string, so anyone can write the parameter. Only an
 * absolute http(s) URL passes: a `javascript:` or `data:` value would run in Civitai's origin
 * when the "Continue" link is clicked.
 */
export function parseExternalDestination(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * A same-site href that opens the leaving-Civitai warning for `destination`, so a link can be
 * middle-clicked or copied without the copy skipping the warning.
 *
 * `:` and `/` are legal unescaped in a query value, and leaving them readable is what lets the
 * hover preview show where the link goes.
 */
export function externalLinkInterstitialHref(destination: string): string {
  const absolute = resolveHttpHref(destination)?.href ?? destination;
  const encoded = encodeURIComponent(absolute).replace(/%3A/gi, ':').replace(/%2F/gi, '/');
  return `${EXTERNAL_LINK_INTERSTITIAL_PATH}?url=${encoded}`;
}
