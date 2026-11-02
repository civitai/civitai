/**
 * A page render that arrives carrying a static-asset rule's `Cache-Control` must leave private.
 *
 * `next.config.mjs` gives `/images/<file>.<ext>` (and the worker, icon and manifest paths) a
 * public, CDN-cacheable `Cache-Control`, and Next sets it on the response BEFORE it knows whether a
 * file exists. A missing file, or a case variant of a real one (rules match without case, the
 * filesystem does not), is answered by the `/images/[imageId]` page instead, through `_app`, with
 * per-viewer props and cookies — and Next keeps the rule's header on that page's 404, its 500 when
 * `getServerSideProps` throws, its redirect, and on `_app`'s own 302 (measured on a Next 16.4.3
 * production build). `_app.getInitialProps` therefore replaces a rule value with the private one
 * first, recognising it by the value Next already set (not by re-deriving the path).
 *
 * Each case replays Next's order on ONE real response: the rule header, `_app` for the page, the
 * page's real `createServerSideProps` handler, and `_app` again for the `/404` or `/_error` Next
 * renders after a `notFound` or a throw.
 *
 * Lives outside `src/pages` deliberately: Next treats every file under there as a route.
 */
import type { ServerResponse } from 'node:http';
import type { GetServerSidePropsContext } from 'next';
import type { AppContext } from 'next/app';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as SharedSlotSync from '~/server/auth/shared-slot-sync';
import { createRealApiPair } from '~/server/utils/__tests__/real-api-response';

const h = vi.hoisted(() => ({
  bootstrap: vi.fn<(req: unknown) => Promise<unknown>>(),
  syncUrl: { current: null as string | null },
}));

// Wholesale on purpose, as in app-guard-redirect-once.test.ts: `_app` uses only this export.
vi.mock('~/server/services/settings-bootstrap.service', () => ({
  resolveSettingsBootstrapForRender: h.bootstrap,
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => ({})),
}));
// `_app`'s own 302 (the shared-slot session sync), forced on so the case can reach it.
vi.mock('~/server/auth/shared-slot-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedSlotSync>()),
  sharedSlotNavigationSyncUrl: vi.fn(() => h.syncUrl.current),
}));

import AppWithTRPC from '~/pages/_app';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

const getInitialProps = (AppWithTRPC as unknown as { getInitialProps: (c: AppContext) => unknown })
  .getInitialProps;

const RULE_HEADER = 'public, max-age=3600, s-maxage=14400, stale-while-revalidate=3600';
const SHORT_RULE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=300';
const PRIVATE = 'private, no-cache, no-store, max-age=0, must-revalidate';

type Exit = 'render' | 'throw' | 'redirect' | 'notFound';

const page = (exit: Exit) =>
  createServerSideProps({
    resolver: async () => {
      if (exit === 'throw') throw new Error('page failed');
      if (exit === 'redirect') return { redirect: { destination: '/', permanent: false } };
      if (exit === 'notFound') return { notFound: true };
      return { props: {} };
    },
  });

/** Next's order on one response; `ruleHeader` is what `next.config.mjs` set before the page ran. */
async function serve(url: string, exit: Exit, ruleHeader?: string) {
  const { req, res } = createRealApiPair({ url, headers: { host: 'civitai.com' } });
  const response = res as unknown as ServerResponse;
  if (ruleHeader) response.setHeader('Cache-Control', ruleHeader);
  const pathname = url.split('?')[0];
  const noop = () => null;
  const app = (renderPathname: string) =>
    getInitialProps({
      Component: noop,
      AppTree: noop,
      router: { locales: ['en'] },
      ctx: { req, res, pathname: renderPathname, query: {}, asPath: url, AppTree: noop },
    } as unknown as AppContext);

  await app('/images/[imageId]');
  if (!response.headersSent) {
    let rerender: string | undefined;
    try {
      const result = (await page(exit)({
        req,
        res,
        params: { imageId: pathname.split('/').pop() },
        query: {},
        resolvedUrl: url,
      } as unknown as GetServerSidePropsContext)) as { notFound?: boolean };
      if (result.notFound) rerender = '/404';
    } catch {
      rerender = '/_error';
    }
    if (rerender) await app(rerender);
  }
  return response;
}

beforeEach(() => {
  h.bootstrap.mockReset();
  h.bootstrap.mockImplementation(async () => ({ session: null }));
  h.syncUrl.current = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 }))
  );
});

// What Next put on the response from a `next.config.mjs` rule before `_app` ran; `_app` decides
// by this value alone, so the url only feeds the page handler (`/index/` data form included).
const RULE_VALUES = [SHORT_RULE, RULE_HEADER];
const URLS = [
  '/images/no-such-file.png',
  '/images/BASE-BADGE.PNG',
  '/_next/data/BUILD_ID/images/a.png.json',
  '/_next/data/BUILD_ID/index/en/images/a.png.json?foo=1',
];

describe.each(RULE_VALUES.flatMap((value) => URLS.map((url) => [value, url] as const)))(
  'a page render that arrives with the rule value %j (%s)',
  (ruleValue, url) => {
    it.each<Exit>(['notFound', 'throw', 'redirect', 'render'])(
      'leaves private when the page exits by %s',
      async (exit) => {
        const res = await serve(url, exit, ruleValue);
        expect(res.getHeader('cache-control')).toBe(PRIVATE);
      }
    );

    it("leaves private on _app's own 302", async () => {
      h.syncUrl.current = '/api/auth/authorize?returnUrl=%2F';
      const res = await serve(url, 'render', ruleValue);
      expect(res.statusCode).toBe(302);
      expect(res.getHeader('cache-control')).toBe(PRIVATE);
    });
  }
);

describe('a render with any other Cache-Control is left alone', () => {
  it.each([
    // A page that sets its OWN public header (the sitemaps) must keep it.
    ['/sitemap.xml', 'public, max-age=86400, must-revalidate'],
    // Close to a rule value but not one: only exact values are rule hits.
    ['/images/no-such-file.png', 'public, max-age=3600, s-maxage=14400'],
    ['/images/no-such-file.png', 'public, max-age=60'],
  ])('%s keeps %j', async (url, value) => {
    const res = await serve(url, 'render', value);
    expect(res.getHeader('cache-control')).toBe(value);
  });

  it.each(['/images/123', '/_next/data/BUILD_ID/images/123.json', '/images/no-such-file.png'])(
    '%s with no incoming Cache-Control gets none from _app',
    async (url) => {
      const res = await serve(url, 'render');
      expect(res.getHeader('cache-control')).toBeUndefined();
    }
  );
});
