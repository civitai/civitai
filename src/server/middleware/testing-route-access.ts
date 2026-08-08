// Which `/api/testing/*` routes are reachable, given where the request landed.
//
// The debug endpoints are non-prod only, and `NODE_ENV=production` is baked into the
// image every environment deploys — preview included — so in practice they are
// local-dev only. That is fine for the endpoints that poke at data, and fatal for the
// synthetic event-loop stall: a preview environment will not wedge on its own, so
// without a way to trigger one there, the watchdog cannot be validated anywhere
// except the place it is least needed.
//
// WHY THE HOSTNAME AND NOT `IS_PREVIEW`: the preview pipeline injects IS_PREVIEW by
// rewriting the ConfigMap at DEPLOY time, and it is not a build ARG. Next inlines
// `process.env.*` into the edge middleware bundle at BUILD time, so an exemption
// written as `isPreview` compiles to `false` — it would pass review, pass CI, deploy
// cleanly, and change nothing, while presenting as "the fix didn't work" rather than
// "the fix isn't there". `request.nextUrl.hostname` is genuinely runtime.
//
// 🔴 THIS IS A ROUTING CHECK, NOT AN AUTHENTICATION BOUNDARY. It is defence in depth.
// What keeps the stall endpoint out of production is EVENTLOOP_WATCHDOG_STALL_ENDPOINT
// being unset there: the route module then constructs no handler at all, so the path
// is a bare 404 regardless of how a request reached the pod. Never add a route to the
// set below on the strength of the hostname check alone.

// The whole non-production family domain, not just ephemeral PR previews — several
// long-lived non-prod services share it. Narrowness therefore comes from the path set
// below, not from this suffix.
const NON_PROD_HOST_SUFFIX = '.civitaic.com';

// Exact paths, never prefixes. Each one must be independently safe to reach on any
// non-production host by anyone holding the WEBHOOK_TOKEN.
const NON_PROD_REACHABLE_TESTING_PATHS = new Set(['/api/testing/eventloop-stall']);

/**
 * The host the request actually arrived at.
 *
 * `nextUrl.hostname` is derived from the request as the runtime sees it, and behind a
 * CDN and an ingress proxy there is no guarantee it carries the public host. The
 * forwarded headers are what is on the wire, so prefer them and keep `nextUrl` only as
 * a fallback. Normalised because each source can carry a port, a comma-separated
 * chain, or mixed case, and the suffix test is exact.
 *
 * This does not change the trust story: `x-forwarded-host` is no more attacker-
 * controlled than `Host` was, and neither is a boundary — see the header note above.
 */
export function resolveRequestHost(request: {
  headers: { get: (name: string) => string | null };
  nextUrl: { hostname: string };
}): string {
  const raw =
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    request.nextUrl.hostname;
  return (raw ?? '').split(',')[0].trim().split(':')[0].toLowerCase();
}

export function canAccessTestingRoute({
  pathname,
  hostname,
  isProduction,
}: {
  pathname: string;
  hostname: string;
  isProduction: boolean;
}): boolean {
  if (!isProduction) return true;
  return NON_PROD_REACHABLE_TESTING_PATHS.has(pathname) && hostname.endsWith(NON_PROD_HOST_SUFFIX);
}

/**
 * True when a path is one this module is willing to open on a non-production host.
 * Exported so the guard can tell "denied a route that is meant to be reachable here"
 * apart from "denied a route that is never reachable in production", and log only the
 * former. Without that distinction the diagnostic would fire on every ordinary
 * production probe of /api/testing/*.
 */
export function isNonProdReachableTestingPath(pathname: string): boolean {
  return NON_PROD_REACHABLE_TESTING_PATHS.has(pathname);
}
