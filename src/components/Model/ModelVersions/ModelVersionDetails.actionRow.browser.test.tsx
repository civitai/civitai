import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsProviderModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsProviderModule from '~/providers/BrowserSettingsProvider';
import type * as AdsProviderModule from '~/components/Ads/AdsProvider';
import type * as SignalsProviderModule from '~/components/Signals/SignalsProvider';
import * as F from '~/tests/pages/models/model-page-fixture';

/**
 * The version action row (Like, notifications, Share, ...) is anchored at the top of the panel:
 * Create, when the model has it, renders BELOW the row, so Like sits at the same y on every model.
 * Mounts the real `ModelVersionDetails` with and without `canGenerate`.
 */

const mocks = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  user: null as null | Record<string, unknown>,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProviderModule>()),
  useFeatureFlags: () => mocks.flags,
  useOptionalFeatureFlags: () => mocks.flags,
  useFeatureFlagsReady: () => true,
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsProviderModule>()),
  useBrowsingSettings: (select: (state: Record<string, unknown>) => unknown) =>
    select({ showNsfw: false, browsingLevel: 1, blurNsfw: true, allowAds: true }),
}));
vi.mock('~/components/Ads/AdsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AdsProviderModule>()),
  useAdsContext: () => ({
    ready: false,
    consent: false,
    adsEnabled: false,
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
  const F = await import('~/tests/pages/models/model-page-fixture');
  const q = (data: unknown) => ({ useQuery: () => ({ data, isLoading: false, isSuccess: true }) });
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'user.getCreator': {
        useQuery: () => ({ data: F.CREATOR, isLoading: false, isSuccess: true }),
      },
      'model.getCollectionShowcase': q(F.SHOWCASE_COLLECTION),
      'user.getEngagedModelVersions': {
        useQuery: () => ({
          data: { Notify: [], Downloaded: [] },
          isLoading: false,
          isSuccess: true,
        }),
      },
      'resourceReview.getUserResourceReview': q([]),
      'common.getEntityAccess': q([
        { entityId: F.VERSION_IDS[0], entityType: 'ModelVersion', hasAccess: true },
      ]),
      'image.getInfinite': {
        useInfiniteQuery: () => ({
          data: { pages: [{ items: F.IMAGES, nextCursor: undefined }] },
          isLoading: false,
          isSuccess: true,
          hasNextPage: false,
        }),
      },
    }),
  };
});

const { ModelVersionDetails } = await import('./ModelVersionDetails');
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

function Tree({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider colorScheme="dark">
        <AppProvider
          {...({
            settings: {},
            seed: 1,
            canIndex: true,
            allowMatureContent: false,
            domain: 'blue',
            host: 'civitai.com',
            serverDomains: {},
            availableOAuthProviders: [],
            verifiedBot: null,
            isAuthed: false,
          } as unknown as React.ComponentProps<typeof AppProvider>)}
        >
          <IsClientProvider>
            <HiddenPreferencesProvider>
              <BrowserRouterProvider>
                <ContainerProvider containerName="main">
                  <IntersectionObserverProvider>{children}</IntersectionObserverProvider>
                </ContainerProvider>
              </BrowserRouterProvider>
            </HiddenPreferencesProvider>
          </IsClientProvider>
        </AppProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

const roots: Array<{ unmount: () => void; container: HTMLElement }> = [];

afterEach(() => {
  for (const r of roots.splice(0)) {
    r.unmount();
    r.container.remove();
  }
});

async function mountPanel(canGenerate: boolean) {
  mocks.flags = { imageGeneration: true };
  mocks.user = null;
  const container = document.createElement('div');
  container.style.width = '1200px';
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ unmount: () => root.unmount(), container });
  root.render(
    <Tree>
      <ModelVersionDetails
        model={F.MODEL}
        version={{ ...F.MODEL.modelVersions[0], canGenerate }}
        image={undefined}
        onFavoriteClick={() => undefined}
      />
    </Tree>
  );
  await expect.poll(() => container.querySelector('[data-tour="model:like"]')).not.toBeNull();
  const like = container.querySelector('[data-tour="model:like"]') as HTMLElement;
  const row = like.parentElement as HTMLElement;
  const create = container.querySelector('[data-tour="model:create"]') as HTMLElement | null;
  return {
    like,
    row,
    create,
    labels: [...row.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')),
    top: (el: Element) =>
      Math.round(el.getBoundingClientRect().top - container.getBoundingClientRect().top),
  };
}

describe('ModelVersionDetails — action row anchored above Create', () => {
  test('Like sits at the same y with and without Create, and Create renders below the row', async () => {
    const without = await mountPanel(false);
    // Control: without canGenerate there is no Create, so the comparison below is not vacuous.
    expect(without.create).toBeNull();
    const likeTopWithout = without.top(without.like);

    const withCreate = await mountPanel(true);
    expect(withCreate.create, 'Create renders when canGenerate').not.toBeNull();

    expect(withCreate.top(withCreate.like)).toBe(likeTopWithout);
    expect(withCreate.top(withCreate.create!)).toBeGreaterThan(
      withCreate.top(withCreate.row) + withCreate.row.getBoundingClientRect().height - 1
    );
  });

  test('Like is first and the notification bell second', async () => {
    const { labels } = await mountPanel(true);
    expect(labels.slice(0, 2)).toEqual(['Like', 'Get notifications for this model']);
    expect(labels).toContain('Share');
  });
});
