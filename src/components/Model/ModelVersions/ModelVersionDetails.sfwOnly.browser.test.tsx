import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { render } from 'vitest-browser-react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsProviderModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsProviderModule from '~/providers/BrowserSettingsProvider';
import type * as AdsProviderModule from '~/components/Ads/AdsProvider';
import type * as SignalsProviderModule from '~/components/Signals/SignalsProvider';
import * as F from '~/tests/pages/models/model-page-fixture';

/**
 * The SFW-only badge in the model page's Base Model row, on the real `ModelVersionDetails` under the
 * real `AppProvider` (harness from ModelVersionDetails.deferBelowFold.browser.test.tsx). `blue` is
 * what civitai.red resolves to (it is configured as both the blue and the red host); `green` is
 * civitai.com.
 */

const mocks = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  getCreator: vi.fn(),
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
        useQuery: (input: unknown) => {
          mocks.getCreator(input);
          return { data: F.CREATOR, isLoading: false, isSuccess: true };
        },
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

function Tree({ children, domain }: { children: React.ReactNode; domain: 'green' | 'blue' }) {
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
            domain,
            host: domain === 'green' ? 'civitai.com' : 'civitai.red',
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

const mount = (domain: 'green' | 'blue', baseModel: string) =>
  render(
    <Tree domain={domain}>
      <ModelVersionDetails
        model={F.MODEL}
        version={{ ...F.MODEL.modelVersions[0], baseModel }}
        image={undefined}
      />
    </Tree>
  );

const baseModelRow = () =>
  Array.from(document.querySelectorAll('span')).find((s) => s.textContent === 'Base Model')
    ?.parentElement;

beforeEach(() => {
  mocks.getCreator.mockReset();
  mocks.user = null;
});

describe('ModelVersionDetails — SFW only in the Base Model row', () => {
  test('SD 3.5 Large on red shows the badge', async () => {
    mount('blue', 'SD 3.5 Large');
    await expect.element(page.getByText('Base Model', { exact: true })).toBeInTheDocument();
    expect(baseModelRow()?.textContent).toContain('SD 3.5 Large');
    expect(baseModelRow()?.querySelector('[data-testid="sfw-only-badge"]')).toBeTruthy();
  });

  test('SD 3.5 Large on .com shows nothing', async () => {
    mount('green', 'SD 3.5 Large');
    await expect.element(page.getByText('Base Model', { exact: true })).toBeInTheDocument();
    expect(baseModelRow()?.textContent).toContain('SD 3.5 Large');
    expect(baseModelRow()?.querySelector('[data-testid="sfw-only-badge"]')).toBeNull();
  });

  test('SDXL 1.0 on red shows nothing', async () => {
    mount('blue', 'SDXL 1.0');
    await expect.element(page.getByText('Base Model', { exact: true })).toBeInTheDocument();
    expect(baseModelRow()?.textContent).toContain('SDXL 1.0');
    expect(baseModelRow()?.querySelector('[data-testid="sfw-only-badge"]')).toBeNull();
  });
});
