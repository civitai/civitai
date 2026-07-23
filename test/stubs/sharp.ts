/**
 * Browser-mode (`component` project) stub for the native `sharp` module.
 *
 * A couple of `.browser.test.tsx` tests import a Next *page* to render its CLIENT
 * shell (e.g. `src/pages/apps/review/[publishRequestId].tsx`). Those pages also
 * declare `getServerSideProps`, whose top-level import pulls the full server
 * router graph (`server-side-helpers` → `routers/index` → `creator-shop.router`
 * → `creator-shop.service`), and that service `import sharp from 'sharp'`.
 *
 * In a real Next build the server-only `getServerSideProps` graph is stripped
 * from the client bundle, so `sharp` never reaches the browser. Vitest's
 * browser build has no such stripping, so esbuild's optimizeDeps scan follows
 * the import into `sharp` and dies trying to bundle its native
 * `require('../build/Release/sharp-*.node')` — killing the ENTIRE component
 * suite before any test runs (the tests themselves already `vi.mock`
 * server-side-helpers, but that is a RUNTIME interception that can't stop the
 * BUILD-time static scan).
 *
 * Aliasing `sharp` to this trivial stub for the `component` project only lets
 * esbuild bundle a no-op instead of the native binary. `sharp` is never actually
 * exercised in browser tests (server-side code never runs), so the stub is never
 * called. The `unit` (node) project keeps the real `sharp`.
 */
const notInBrowser = () => {
  throw new Error('sharp is not available in browser-mode (component) tests');
};

export default new Proxy(function sharp() {
  return notInBrowser();
} as unknown as Record<string, unknown>, {
  get: () => notInBrowser,
});
