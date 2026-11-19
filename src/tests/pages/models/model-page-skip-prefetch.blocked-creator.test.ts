import { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsProviderModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsProviderModule from '~/providers/BrowserSettingsProvider';
import type * as ToursProviderModule from '~/components/Tours/ToursProvider';
import type * as AdsProviderModule from '~/components/Ads/AdsProvider';
import type * as SignalsProviderModule from '~/components/Signals/SignalsProvider';
import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as BrowsingLevelUtils from '~/server/utils/browsing-level';
import * as F from './model-page-fixture';

/**
 * A viewer who blocked the model's creator gets NotFound from the SERVER render in both arms of
 * `ssrSignedInSkipPrefetch` — never the blocked creator's page after mount.
 *
 * The seam is what is tested, so neither half is hand-written: the page's own getServerSideProps
 * runs first with a recording `ssg`, and the server render that follows sees data for exactly the
 * queries that run prefetched, every other query still loading. Drop `hiddenPreferences.getHidden`
 * from the skip arm and the render below has no blocked-users list, renders the loading shell, and
 * the NotFound assertion fails.
 */

const m = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  /** The procedures the page's getServerSideProps prefetched for this request. */
  prefetched: new Set<string>(),
  blocked: false,
  viewer: {
    id: 5,
    username: 'lantern-viewer',
    isModerator: false,
    muted: false,
    bannedAt: null,
    tier: 'free',
    filePreferences: {},
  },
}));
const VIEWER = m.viewer;

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: ({ resolver }: { resolver: unknown }) => resolver,
}));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  getDefaultModelVersion: async () => ({
    id: F.VERSION_IDS[0],
    status: 'Published',
    availability: 'Public',
    trainingStatus: null,
    model: { id: F.MODEL_ID, userId: F.CREATOR_ID, availability: 'Public' },
  }),
}));
vi.mock('~/server/utils/browsing-level', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelUtils>()),
  getServerImageQueryFilters: async () => ({ excludedTagIds: [] }),
}));
vi.mock('next/router', () => ({
  useRouter: () => ({
    query: { id: '4201', slug: ['lantern-glow-portrait-lora'], modelVersionId: '9301' },
    asPath: '/models/4201/lantern-glow-portrait-lora?modelVersionId=9301',
    pathname: '/models/[id]/[[...slug]]',
    replace: vi.fn(),
    push: vi.fn(),
    events: { on: vi.fn(), off: vi.fn() },
    isReady: true,
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => m.viewer }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProviderModule>()),
  useFeatureFlags: () => m.flags,
  useOptionalFeatureFlags: () => m.flags,
  useFeatureFlagsReady: () => true,
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsProviderModule>()),
  useBrowsingSettings: (select: (state: Record<string, unknown>) => unknown) =>
    select({
      showNsfw: false,
      browsingLevel: 1,
      blurNsfw: true,
      allowAds: true,
      disableHidden: false,
      autoplayGifs: true,
      setState: () => undefined,
    }),
}));
vi.mock('~/components/Tours/ToursProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ToursProviderModule>()),
  useTourContext: () => ({ activeTour: null, running: false, runTour: () => undefined }),
}));
vi.mock('~/components/Ads/AdsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AdsProviderModule>()),
  useAdsContext: () => ({
    ready: false,
    consent: false,
    adsEnabled: true,
    useDirectAds: false,
    adEngine: 'none',
    isMember: false,
  }),
}));
vi.mock('~/components/Signals/SignalsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof SignalsProviderModule>()),
  useSignalContext: () => ({ connected: false, status: 'closed', worker: null }),
  useSignalConnection: () => undefined,
  useSignalTopic: () => undefined,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  const F = await import('./model-page-fixture');
  const q = (data: () => unknown) => ({
    useQuery: () => ({ data: data(), isLoading: false, isSuccess: true }),
  });
  const pending = {
    data: undefined,
    isLoading: true,
    isPending: true,
    isFetching: true,
    isSuccess: false,
    isError: false,
    error: null,
    refetch: () => undefined,
  };
  const notPrefetched = {
    useQuery: () => pending,
    useInfiniteQuery: () => ({ ...pending, hasNextPage: false, fetchNextPage: () => undefined }),
  };
  // What each query holds once prefetched; it is served only if this request prefetched it.
  const data: Record<string, unknown> = {
    'model.getById': q(() => F.MODEL),
    'hiddenPreferences.getHidden': q(() => ({
      blockedUsers: m.blocked ? [{ id: F.CREATOR_ID, username: F.CREATOR_USERNAME }] : [],
    })),
    'user.getCreator': q(() => F.CREATOR),
    'model.getCollectionShowcase': q(() => F.SHOWCASE_COLLECTION),
    'common.getEntityAccess': q(() => [
      { entityId: F.VERSION_IDS[0], entityType: 'ModelVersion', hasAccess: true },
    ]),
    'blocks.listForModel': q(() => []),
    'user.getEngagedModelVersions': q(() => ({ Notify: [], Downloaded: [] })),
    'resourceReview.getUserResourceReview': q(() => []),
    'image.getInfinite': {
      useInfiniteQuery: () => ({
        data: { pages: [{ items: F.IMAGES, nextCursor: undefined }] },
        isLoading: false,
        isSuccess: true,
        hasNextPage: false,
      }),
    },
  };
  const procedures = new Proxy(data, {
    get: (target, key: string) =>
      key in target && m.prefetched.has(key) ? target[key] : notPrefetched,
  });
  return { ...(await importOriginal<typeof Trpc>()), trpc: makeTrpcProxy(procedures) };
});

const pageModule = await import('~/pages/models/[id]/[[...slug]]');
const ModelPage = pageModule.default;
const { getFeatureFlags } = await import('~/server/services/feature-flags.service');
const { ThemeProvider } = await import('~/providers/ThemeProvider');
const { AppProvider } = await import('~/providers/AppProvider');
const { IsClientProvider } = await import('~/providers/IsClientProvider');
const { HiddenPreferencesProvider } = await import(
  '~/components/HiddenPreferences/HiddenPreferencesProvider'
);
const { BrowserRouterProvider } = await import('~/components/BrowserRouter/BrowserRouterProvider');
const { ContainerProvider } = await import('~/components/ContainerProvider/ContainerProvider');
const { IntersectionObserverProvider } = await import(
  '~/components/IntersectionObserver/IntersectionObserverProvider'
);
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');

const ANON_FLAGS = { ...getFeatureFlags({ host: 'civitai.com' }) } as Record<string, boolean>;

/** An `ssg` that records `<router>.<procedure>` for every fetch/prefetch the resolver issues. */
function recordingSsg(calls: Set<string>) {
  return new Proxy(
    {},
    {
      get: (_t, router: string) =>
        new Proxy(
          {},
          {
            get: (_t2, proc: string) => {
              const record = async () => {
                calls.add(`${router}.${proc}`);
                return router === 'model' && proc === 'getById' ? F.MODEL : null;
              };
              return { fetch: record, prefetch: record, prefetchInfinite: record };
            },
          }
        ),
    }
  );
}

/** Run the page's getServerSideProps, then server-render it against what that run prefetched. */
async function serverRender(flag: boolean) {
  m.prefetched = new Set();
  const resolver = pageModule.getServerSideProps as unknown as (args: unknown) => Promise<unknown>;
  const result = (await resolver({
    ssg: recordingSsg(m.prefetched),
    ctx: {
      params: { id: String(F.MODEL_ID), slug: ['lantern-glow-portrait-lora'] },
      query: { id: String(F.MODEL_ID), slug: ['lantern-glow-portrait-lora'] },
      req: { url: '/models/4201/lantern-glow-portrait-lora', headers: {} },
      res: {},
    },
    session: { user: { id: VIEWER.id, username: VIEWER.username, isModerator: false } },
    features: { ssrSignedInSkipPrefetch: flag },
  })) as { props: { id: number; initialMobile: boolean; deferredSsr: boolean } };
  // The arm the request actually took, so a case cannot pass by landing in the other one.
  expect(result.props.deferredSsr).toBe(flag);

  m.flags = ANON_FLAGS;
  const layers: [unknown, Record<string, unknown> | null][] = [
    [QueryClientProvider, { client: new QueryClient() }],
    [ThemeProvider, { colorScheme: 'dark' }],
    [
      AppProvider,
      {
        settings: {},
        seed: 1,
        canIndex: true,
        allowMatureContent: false,
        domain: 'blue',
        host: 'civitai.com',
        serverDomains: {},
        availableOAuthProviders: [],
        verifiedBot: null,
        isAuthed: true,
      },
    ],
    [IsClientProvider, null],
    [HiddenPreferencesProvider, null],
    [BrowserRouterProvider, null],
    [ContainerProvider, { containerName: 'main', id: 'main' }],
    [IntersectionObserverProvider, null],
  ];
  const tree = layers.reduceRight<ReactElement>(
    (child, [Component, props]) => createElement(Component as never, props, child),
    createElement(ModelPage as never, result.props)
  );
  return renderToString(tree);
}

const NOT_FOUND = 'The page you are looking for doesn';
const PAGE_LOADER = 'class="absolute inset-0 flex items-center justify-center gap-4"';

beforeEach(() => {
  m.blocked = false;
});

describe('model page server render: a creator the viewer blocked', () => {
  it('skip arm: the server renders NotFound, not the loading shell', async () => {
    m.blocked = true;
    const html = await serverRender(true);

    expect(html).toContain(NOT_FOUND);
    expect(html).not.toContain(PAGE_LOADER);
    expect(html).not.toContain(F.MODEL_DESCRIPTION_MARKER);
  });

  it('skip arm, creator not blocked: the loading shell (so NotFound above is the block speaking)', async () => {
    const html = await serverRender(true);

    expect(html).toContain(PAGE_LOADER);
    expect(html).not.toContain(NOT_FOUND);
  });

  it('full arm: the server renders NotFound, as the skip arm does', async () => {
    m.blocked = true;
    const html = await serverRender(false);

    expect(html).toContain(NOT_FOUND);
    expect(html).not.toContain(F.MODEL_DESCRIPTION_MARKER);
  });
});
