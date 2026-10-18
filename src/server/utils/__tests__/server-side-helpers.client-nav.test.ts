import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GetServerSidePropsContext } from 'next';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

/**
 * `createServerSideProps` skips the SSG prefetch for a `prefetch: 'once'` page on a client-side
 * navigation, since the browser fetches those queries itself. Next delivers a real navigation with
 * `req.url` already rewritten to the page path (`/_next/data/<build>/en/models/1.json` arrives as
 * `/models/1`) and marks it with `x-nextjs-data: 1`, so the URL test alone never sees one.
 */

const { flags, probeQuery } = vi.hoisted(() => ({
  flags: { current: {} as Record<string, boolean> },
  probeQuery: vi.fn(async () => 'probe-data'),
}));

vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: vi.fn(async () => null),
}));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => null),
  maybeRollHubCookie: vi.fn(async () => undefined),
  maybeUpgradeLegacySession: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => flags.current),
}));
vi.mock('~/server/routers', async () => {
  const { publicProcedure, router } = await import('~/server/trpc');
  return { appRouter: router({ probe: publicProcedure.query(probeQuery) }) };
});

const { createServerSideProps } = await import('~/server/utils/server-side-helpers');

type Ssg = { probe: { prefetch: () => Promise<void> } };
const seenIsClient: boolean[] = [];
const page = (prefetch?: 'once' | 'always') =>
  createServerSideProps({
    useSSG: true,
    ...(prefetch ? { prefetch } : {}),
    resolver: async ({ ssg, isClient }) => {
      seenIsClient.push(isClient);
      if (ssg) await (ssg as unknown as Ssg).probe.prefetch();
      return { props: { rendered: true } };
    },
  });
const oncePage = page();
const alwaysPage = page('always');

/** What a page handler receives: a real navigation is the page path plus Next's data header. */
const HTML = { url: '/models/1', dataHeader: false };
const NAVIGATION = { url: '/models/1', dataHeader: true };
const DATA_URL = { url: '/_next/data/build-id/models/1.json', dataHeader: false };

async function load(handler: typeof oncePage, req: { url: string; dataHeader: boolean }) {
  seenIsClient.length = 0;
  const result = (await handler({
    req: {
      url: req.url,
      headers: { host: 'civitai.com', ...(req.dataHeader ? { 'x-nextjs-data': '1' } : {}) },
      cookies: {},
    },
    res: { setHeader: vi.fn(), getHeader: vi.fn() },
    query: {},
    resolvedUrl: '/models/1',
  } as unknown as GetServerSidePropsContext)) as { props?: { trpcState?: unknown } };
  return {
    isClient: seenIsClient[0],
    prefetched: probeQuery.mock.calls.length > 0,
    shipsState: JSON.stringify(result.props?.trpcState ?? null).includes('probe-data'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.current = { clientNavSkipsPrefetch: true };
});

describe('client-navigation detection in createServerSideProps', () => {
  it('a navigation marked by the data header skips the prefetch of a once page', async () => {
    expect(await load(oncePage, NAVIGATION)).toEqual({
      isClient: true,
      prefetched: false,
      shipsState: false,
    });
  });

  it('a page request prefetches and ships the dehydrated state', async () => {
    expect(await load(oncePage, HTML)).toEqual({
      isClient: false,
      prefetched: true,
      shipsState: true,
    });
  });

  it.each([
    ['on', { clientNavSkipsPrefetch: true }],
    ['off', {}],
  ])(
    'with the flag %s, a URL still carrying the /_next/data prefix is a navigation',
    async (_, flagState) => {
      flags.current = flagState;
      expect(await load(oncePage, DATA_URL)).toEqual({
        isClient: true,
        prefetched: false,
        shipsState: false,
      });
    }
  );

  it('prefetch: always still prefetches on a navigation', async () => {
    expect(await load(alwaysPage, NAVIGATION)).toEqual({
      isClient: true,
      prefetched: true,
      shipsState: true,
    });
  });

  it('with clientNavSkipsPrefetch off, the data header is ignored and the page prefetches', async () => {
    flags.current = {};
    expect(await load(oncePage, NAVIGATION)).toEqual({
      isClient: false,
      prefetched: true,
      shipsState: true,
    });
  });
});
