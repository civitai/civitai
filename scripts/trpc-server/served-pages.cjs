'use strict';
/**
 * The pages the standalone server (`./server.cjs`) answers. Anything else is a 404.
 *
 * Which pages depends on the server's PROFILE, read once at boot from `STANDALONE_SERVER_PROFILE`:
 *
 *   - `trpc` (the default, and the only profile before the variable existed): exactly
 *     `TRPC_PAGES`, a fixed list. Unset means this profile, so a deployment that never sets the
 *     variable serves exactly what it served before.
 *   - `api`: `TRPC_PAGES` plus every pages-API route the build has under `API_PROFILE_PREFIXES`,
 *     read from the build's own `pages-manifest.json` at boot, so a route added under those
 *     prefixes is served without editing this file.
 *
 * Own module so unit tests can check the lists against the proxy matcher
 * (`src/server/middleware/__tests__/proxy-standalone-pages.test.ts`): this server never runs the
 * proxy, so a page the proxy runs on under Next can only be served here if this server does the
 * proxy's work for it. For `/api/v1/` pages (`PROXY_POLICY_PREFIXES`) it does: before the route
 * runs it applies Next's request-body cap for proxied requests (`applyProxyBodyLimit` in
 * `./next-compat.cjs`) and then the proxy middlewares' whole effect on an API request, the shared
 * `applyApiRequestPolicy` (`src/server/middleware/api-request-policy.ts`), which instrumentation
 * registers on `globalThis` under `API_POLICY_GLOBAL_KEY`. Any other page the proxy covers must
 * stay off every list; the test fails if one is added.
 *
 * Every page is matched exactly (see `createPageMatcher` in `./next-compat.cjs`): a trailing slash or
 * an extra segment gets this server's plain 404, where Next would redirect or render its 404 page.
 * The callers send exact paths only; the parity harness (`./parity/cases.mjs`) pins those answers.
 *
 * Plain CommonJS with no require: `server.cjs` loads it at module scope, so the image build's
 * boot-graph gate (`scripts/ci/assert-standalone-boot-graph.mjs`) fails if it is not shipped.
 */

const TRPC_PAGES = Object.freeze([
  '/api/trpc/[trpc]',
  // The internal image-delivery lookup. Its caller sends `/api/internal/image-delivery/<key>`.
  '/api/internal/image-delivery/[id]',
  // The browser beacons: page views (`TrackPageView.tsx`), entity views (`TrackView.tsx`) and the
  // coalesced search/action/impression batch (`trackEventBuffer.ts`). POST only; each route
  // module parses its own body (Next's default `bodyParser`, as under `server.js`).
  '/api/internal/ping',
  '/api/internal/pulse',
  '/api/track/batch',
  '/api/live',
  '/api/health',
  '/api/ready',
  '/api/readyz',
  '/api/metrics',
]);

/**
 * The route families the `api` profile adds: the public REST API. `/api/auth/` is deliberately
 * NOT here: it costs little CPU and carries the widest blast radius of anything the API pools
 * serve (session cookies, OAuth redirects, POST flows), so it stays on Next.
 */
const API_PROFILE_PREFIXES = Object.freeze(['/api/v1/']);

/** Pages the proxy runs on under Next; this server applies the proxy's API policy before them. */
const PROXY_POLICY_PREFIXES = Object.freeze(['/api/v1/']);

/** The `globalThis` key (via `Symbol.for`) instrumentation registers `applyApiRequestPolicy` under. */
const API_POLICY_GLOBAL_KEY = 'civitai.standalone.applyApiRequestPolicy';

const PROFILES = Object.freeze(['trpc', 'api']);
const DEFAULT_PROFILE = 'trpc';

/** The profile named by `value` (unset or empty means the default), or null when it is unknown. */
function resolveProfile(value) {
  const name = value === undefined || value === '' ? DEFAULT_PROFILE : value;
  return PROFILES.includes(name) ? name : null;
}

/** Whether this server must apply the proxy's API policy before `page`'s route runs. */
function needsApiPolicy(page) {
  return PROXY_POLICY_PREFIXES.some((prefix) => page.startsWith(prefix));
}

/**
 * The pages `profile` serves, given the build's `pages-manifest.json` (page -> module file).
 * `trpc`: `TRPC_PAGES`, whatever the manifest holds. `api`: those plus every manifest page under
 * `API_PROFILE_PREFIXES`, in manifest-independent (sorted) order. Throws on an unknown profile.
 */
function servedPages(profile, pagesManifest) {
  if (profile === 'trpc') return [...TRPC_PAGES];
  if (profile !== 'api') throw new Error(`unknown standalone server profile ${String(profile)}`);
  const extra = Object.keys(pagesManifest)
    .filter((page) => API_PROFILE_PREFIXES.some((prefix) => page.startsWith(prefix)))
    .filter((page) => !TRPC_PAGES.includes(page))
    .sort();
  return [...TRPC_PAGES, ...extra];
}

module.exports = Object.freeze({
  TRPC_PAGES,
  API_PROFILE_PREFIXES,
  PROXY_POLICY_PREFIXES,
  API_POLICY_GLOBAL_KEY,
  PROFILES,
  DEFAULT_PROFILE,
  resolveProfile,
  needsApiPolicy,
  servedPages,
});
