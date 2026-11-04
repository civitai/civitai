'use strict';
/**
 * The only pages the standalone tRPC server (`./server.cjs`) answers. Anything else is a 404.
 *
 * Its own module so a unit test can pin the exact list (`__tests__/served-pages.test.ts`) and check
 * it against the proxy matcher (`src/server/middleware/__tests__/proxy-standalone-pages.test.ts`):
 * this server never runs the proxy, so a page the proxy runs on under Next cannot be served here.
 *
 * Every page is matched exactly (see `createPageMatcher` in `./next-compat.cjs`): a trailing slash or
 * an extra segment gets this server's plain 404, where Next would redirect or render its 404 page.
 * The callers send exact paths only; the parity harness (`./parity/cases.mjs`) pins those answers.
 *
 * Plain CommonJS with no require: `server.cjs` loads it at module scope, so the image build's
 * boot-graph gate (`scripts/ci/assert-standalone-boot-graph.mjs`) fails if it is not shipped.
 */
module.exports = Object.freeze([
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
  '/api/metrics',
]);
