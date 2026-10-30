/**
 * The first-party media hosts a stored generation URL may name.
 *
 * Shared by the server meta-propagation gate (`mapDataToGraphInput`) and the
 * client `?gen=` handoff decode, so it must stay free of server- and
 * client-only imports: callers pass the configured image location in.
 *
 * Why a gate at all: source-image URLs reach these seams from attacker-writable
 * surfaces (stored image meta, crafted handoff links) and the form auto-fetches
 * them client-side. A first-party host is never sufficient for a credential
 * grant on its own — media auth is presigned signatures — it only stops
 * attacker-chosen URLs from entering the generator's fetch paths.
 * ClickUp 868maend5.
 */

const ORCHESTRATION_HOST_RE = /^orchestration[a-z0-9-]*\.civitai\.com$/i;
const LOCALHOST_HOST_RE = /^(localhost|\[::1\])(:\d+)?$/;

function hostOf(url: unknown): { host: string; protocol: string } | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const parsed = new URL(url);
    // `host` rather than `hostname`, so a matching name on an attacker-chosen
    // port is not trusted (same rule as trusted-blob-url.ts).
    return { host: parsed.host.toLowerCase(), protocol: parsed.protocol };
  } catch {
    return undefined;
  }
}

/**
 * Strip a default port (:443 for https, :80 for http) so an image location
 * configured with an explicit default port does not invalidate every CDN URL
 * built without one (and vice versa). Non-default ports are kept — a matching
 * name on an attacker-chosen port stays untrusted.
 */
function normalizeDefaultPort(host: string, protocol: string): string {
  if (protocol === 'https:' && host.endsWith(':443')) return host.slice(0, -4);
  if (protocol === 'http:' && host.endsWith(':80')) return host.slice(0, -3);
  return host;
}

/**
 * Whether a stored meta URL may be handed to the generator form.
 *
 * `https`-only, with one carve-out: in development the image location is an
 * `http://localhost[:port]` (or loopback IPv6) origin, so loopback URLs are
 * accepted only when the configuration itself points at loopback — a stored
 * `localhost` URL in production names the *viewer's* machine and gains
 * nothing from the exception. The carve-out is http-only: an https://localhost
 * URL against an http dev config is still rejected.
 */
export function isMediaHost(url: unknown, imageLocation: string | undefined): boolean {
  const parsed = hostOf(url);
  if (!parsed) return false;
  if (parsed.protocol === 'https:' && ORCHESTRATION_HOST_RE.test(parsed.host)) return true;

  const loc = imageLocation ? hostOf(imageLocation) : undefined;
  if (!loc) return false;

  if (
    parsed.protocol === 'https:' &&
    normalizeDefaultPort(parsed.host, parsed.protocol) ===
      normalizeDefaultPort(loc.host, loc.protocol)
  ) {
    return true;
  }
  return (
    parsed.protocol === 'http:' &&
    loc.protocol === 'http:' &&
    LOCALHOST_HOST_RE.test(loc.host) &&
    LOCALHOST_HOST_RE.test(parsed.host)
  );
}
