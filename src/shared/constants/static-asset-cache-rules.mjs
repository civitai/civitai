// @ts-check
/**
 * `Cache-Control` for files served from `public/`. Plain `.mjs` so both readers load THIS list:
 * `next.config.mjs` (which Node loads natively, so it cannot import TypeScript) turns each entry
 * into a `headers()` rule, and `_app.getInitialProps` (`~/server/utils/static-asset-cache`) makes
 * any PAGE render on one of these paths private again (see below).
 *
 * Next serves every public file with `public, max-age=0` (it cannot know whether one changed), so a
 * CDN in front revalidates each one against the origin on EVERY request. None of these URLs
 * carries a content hash, so every TTL here bounds how long a deploy that edits a file in place
 * can take to reach everyone: worst case = `s-maxage` + `stale-while-revalidate` at the CDN, then
 * `max-age` in the browser.
 *
 * - Workers (`public/workers/*.js`, built by `pnpm build:workers` on every build): SHORT. The
 *   signals worker URL carries `?v=SIGNALS_WORKER_VERSION` and the client retries a script that
 *   reports another protocol version (`useSignalsWorker`); the file-hash worker URL carries the
 *   build id. During a rolling deploy a new URL can still be answered by an old pod, and the CDN
 *   would keep that copy for the whole TTL, so five minutes. The civitai-link worker URL is
 *   unversioned on purpose: it is a SharedWorker, and a per-build URL would start a second worker
 *   (and Link socket) for every build a viewer has tabs open on.
 * - Icons, the web manifest and the bundled default images (`/favicon*.ico`, `/apple-touch-icon*`,
 *   `/site.webmanifest`, `/images/<file>.<ext>`): a stale copy is cosmetic only, so hours.
 *
 * 🔴 Next applies a rule BEFORE it knows whether the file exists, and keeps it on whatever answers
 * instead. A miss on a path no page owns is Next's own static 404 (no viewer data). A miss on
 * `/images/<file>.<ext>` — or a case variant of a real file, since rules match without case and
 * the filesystem does not — is rendered by `/images/[imageId]` through `_app`, with per-viewer
 * props and cookies, and Next leaves the rule's header on its 404, its 500 when the page throws,
 * and its redirects. `_app` therefore sets `STATIC_ASSET_MISS_CACHE_CONTROL` first on every render
 * whose path one of these rules matches.
 *
 * `/_next/static` is not listed: Next already serves it immutable and ignores any override.
 */

const SHORT_LIVED_STATIC = 'public, max-age=60, s-maxage=300, stale-while-revalidate=300';
const LONG_LIVED_STATIC = 'public, max-age=3600, s-maxage=14400, stale-while-revalidate=3600';

/** @type {ReadonlyArray<{ source: string; cacheControl: string }>} */
export const STATIC_ASSET_CACHE_RULES = [
  { source: '/workers/:file([^/]+\\.js)', cacheControl: SHORT_LIVED_STATIC },
  { source: '/:file(favicon(?:-[a-z]+)?\\.ico)', cacheControl: LONG_LIVED_STATIC },
  { source: '/:file(apple-touch-icon(?:-precomposed)?\\.png)', cacheControl: LONG_LIVED_STATIC },
  { source: '/site.webmanifest', cacheControl: LONG_LIVED_STATIC },
  {
    // The extension is required: `/images`, `/images/iterate` and `/images/123` are pages.
    source: '/images/:file(.+\\.(?:png|jpe?g|gif|svg|webp|ico))',
    cacheControl: LONG_LIVED_STATIC,
  },
];

/** What a page render on a rule path must carry instead: Next's own default for a dynamic page. */
export const STATIC_ASSET_MISS_CACHE_CONTROL =
  'private, no-cache, no-store, max-age=0, must-revalidate';
