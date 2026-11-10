import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GetServerSidePropsContext } from 'next';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { unionDeserialize } from '~/shared/utils/trpc-union-transformer';
import {
  fakeResponse,
  procedureCalls,
  renderSeedFor,
  USERS,
  type Fixture,
} from '~/server/page-data/__tests__/image-detail.fixtures';

/**
 * What `/images/[imageId]`'s `getServerSideProps` returns, pinned literally, so that moving its
 * resolver into `~/server/page-data/image-detail` (to share it with the page-data endpoint) is
 * provably a move: the same prefetches, the same inputs, the same viewer, the same `adsGated`
 * and session. Green before AND after that refactor — an invariant guard, not a regression test.
 */

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
  getFeatureFlagsAsync: vi.fn(async ({ req }: { req?: { headers: { host?: string } } }) => ({
    canViewNsfw: req?.headers.host === 'civitai.red' ? true : undefined,
  })),
}));
vi.mock('~/server/routers', async () => {
  const { buildFixtureRouter } = await import('~/server/page-data/__tests__/image-detail.fixtures');
  return { appRouter: await buildFixtureRouter() };
});

const page = (await import('~/pages/images/[imageId]')) as unknown as {
  getServerSideProps: (ctx: GetServerSidePropsContext) => Promise<{
    props?: { trpcState?: unknown; adsGated?: boolean; session?: unknown };
    notFound?: boolean;
  }>;
};

function renderPage({ user, imageId, host }: Fixture) {
  const seed = renderSeedFor(user);
  return page.getServerSideProps({
    req: {
      ...(seed ? { session: seed } : {}),
      url: `/images/${imageId}`,
      headers: { host },
      cookies: {},
    },
    res: fakeResponse(),
    params: { imageId: String(imageId) },
    query: { imageId: String(imageId) },
    resolvedUrl: `/images/${imageId}`,
  } as unknown as GetServerSidePropsContext);
}

/**
 * The prefetched queries as the client hydrates them: key and data, in prefetch order. The key's
 * `browsingLevel` is not the page's: `publicProcedure`'s `applyDomainFeature` clamps the input in
 * place to the domain's cap for the viewer, and the cache key is built from that same object.
 */
function queriesOf(trpcState: unknown) {
  const state = unionDeserialize(trpcState) as {
    queries: { queryKey: unknown; state: { data: unknown } }[];
  };
  return state.queries.map((q) => ({ queryKey: q.queryKey, data: q.state.data }));
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T00:00:00.000Z'));
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  procedureCalls.length = 0;
});

const viewer = (userId: number | null, extra: { isModerator?: boolean } = {}) => ({
  userId,
  isModerator: !!extra.isModerator,
  canViewNsfw: false,
  domain: expect.any(String),
  tokenScope: TokenScope.Full,
  createdAt: userId === null ? null : '2024-01-02T03:04:05.000Z',
});

describe('/images/[imageId] getServerSideProps', () => {
  it('renders the owner of an R-rated image on .com with all four prefetches', async () => {
    const result = await renderPage({ user: USERS.owner, imageId: 101, host: 'civitai.com' });

    expect(Object.keys(result.props ?? {}).sort()).toEqual(['adsGated', 'session', 'trpcState']);
    expect(result.props?.adsGated).toBe(true);
    expect(result.props?.session).toEqual({
      user: { ...USERS.owner, createdAt: '2024-01-02T03:04:05.000Z' },
    });
    expect(queriesOf(result.props?.trpcState)).toEqual([
      {
        queryKey: [['image', 'get'], { input: { id: 101, browsingLevel: 3 }, type: 'query' }],
        data: {
          id: 101,
          name: null,
          nsfwLevel: 4,
          poi: false,
          type: 'image',
          user: { id: 7 },
          url: 'media-101',
          viewer: viewer(7),
        },
      },
      {
        queryKey: [
          ['image', 'getGenerationData'],
          { input: { id: 101, browsingLevel: 3 }, type: 'query' },
        ],
        data: { id: 101, meta: { prompt: 'prompt-101' }, viewer: viewer(7) },
      },
      {
        queryKey: [
          ['image', 'getContestCollectionDetails'],
          { input: { id: 101, browsingLevel: 3 }, type: 'query' },
        ],
        data: { id: 101, viewer: viewer(7) },
      },
      {
        queryKey: [['hiddenPreferences', 'getHidden'], { type: 'query' }],
        data: { hiddenImages: [907] },
      },
    ]);
  });

  it('skips the contest prefetch for a signed-out viewer and withholds R media', async () => {
    const result = await renderPage({ user: null, imageId: 101, host: 'civitai.com' });

    expect(result.props?.adsGated).toBe(true);
    expect(result.props?.session).toBeNull();
    expect(procedureCalls).not.toContain('image.getContestCollectionDetails');
    expect(queriesOf(result.props?.trpcState)).toEqual([
      {
        queryKey: [['image', 'get'], { input: { id: 101, browsingLevel: 1 }, type: 'query' }],
        data: {
          id: 101,
          name: null,
          nsfwLevel: 4,
          poi: false,
          type: 'image',
          user: { id: 7 },
          url: null,
          viewer: viewer(null),
        },
      },
      {
        queryKey: [
          ['image', 'getGenerationData'],
          { input: { id: 101, browsingLevel: 1 }, type: 'query' },
        ],
        data: { id: 101, meta: { prompt: 'prompt-101' }, viewer: viewer(null) },
      },
      {
        queryKey: [['hiddenPreferences', 'getHidden'], { type: 'query' }],
        data: { hiddenImages: [] },
      },
    ]);
  });

  it('drops a failed image.get from the state and leaves ads on for a PG image', async () => {
    const result = await renderPage({
      user: USERS.blockedByOwner,
      imageId: 103,
      host: 'civitai.com',
    });

    expect(result.props?.adsGated).toBe(false);
    expect(procedureCalls).toContain('image.get');
    expect(
      queriesOf(result.props?.trpcState).map((q) => (q.queryKey as [string[]])[0].join('.'))
    ).toEqual([
      'image.getGenerationData',
      'image.getContestCollectionDetails',
      'hiddenPreferences.getHidden',
    ]);
  });

  it('is a 404 for a non-numeric id, before any prefetch', async () => {
    const result = await page.getServerSideProps({
      req: { url: '/images/abc', headers: { host: 'civitai.com' }, cookies: {} },
      res: fakeResponse(),
      params: { imageId: 'abc' },
      query: { imageId: 'abc' },
      resolvedUrl: '/images/abc',
    } as unknown as GetServerSidePropsContext);
    expect(result).toEqual({ notFound: true });
    expect(procedureCalls).toEqual([]);
  });
});
