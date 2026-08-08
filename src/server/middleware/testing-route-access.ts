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
// 🔴 THIS IS NOT AN AUTHENTICATION BOUNDARY. The hostname comes from the Host header,
// which the client controls, so anything able to reach a pod directly can satisfy it.
// What keeps the stall endpoint out of production is that
// EVENTLOOP_WATCHDOG_STALL_ENDPOINT is unset there, so the route module never
// constructs a handler and a spoofed Host reaches a bare 404. This check is
// convenience and defence in depth; do not add a route here on the strength of it
// alone.

const PREVIEW_HOST_SUFFIX = '.civitaic.com';

// Exact paths, never prefixes. Each one must be independently safe to reach on a
// preview host by anyone holding the WEBHOOK_TOKEN.
const PREVIEW_REACHABLE_TESTING_PATHS = new Set(['/api/testing/eventloop-stall']);

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
  return PREVIEW_REACHABLE_TESTING_PATHS.has(pathname) && hostname.endsWith(PREVIEW_HOST_SUFFIX);
}
