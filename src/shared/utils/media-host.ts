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
const LOCALHOST_HOST_RE = /^localhost(:\d+)?$/;

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
 * Whether a stored meta URL may be handed to the generator form.
 *
 * `https`-only, with one carve-out: in development the image location is an
 * `http://localhost[:port]` origin, so localhost URLs (any port) are accepted
 * only when the configuration itself points at localhost — a stored
 * `localhost` URL in production names the *viewer's* machine and gains
 * nothing from the exception.
 */
export function isMediaHost(url: unknown, imageLocation: string | undefined): boolean {
  const parsed = hostOf(url);
  if (!parsed) return false;
  const { host, protocol } = parsed;
  if (ORCHESTRATION_HOST_RE.test(host) && protocol === 'https:') return true;

  let imageLocationHost: string | undefined;
  try {
    imageLocationHost = imageLocation ? new URL(imageLocation).host.toLowerCase() : undefined;
  } catch {
    imageLocationHost = undefined;
  }
  if (!imageLocationHost) return false;

  if (protocol === 'https:' && host === imageLocationHost) return true;
  return LOCALHOST_HOST_RE.test(imageLocationHost) && LOCALHOST_HOST_RE.test(host);
}
