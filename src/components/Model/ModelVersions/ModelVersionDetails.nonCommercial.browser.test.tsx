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
 * Non-commercial base models (Flux.2 Klein 9B) can't be bought or charged a license fee, so the model
 * page must show neither a price nor a fee. A viewer without access keeps the lock: the file endpoint
 * still refuses them, so a normal Download button would end in a 403. Real `ModelVersionDetails` under
 * the real `AppProvider` (harness from ModelVersionDetails.sfwOnly.browser.test.tsx).
 */

const mocks = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  getCreator: vi.fn(),
  user: null as null | Record<string, unknown>,
  access: [] as Record<string, unknown>[],
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
      'common.getEntityAccess': {
        useQuery: () => ({ data: mocks.access, isLoading: false, isSuccess: true }),
      },
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

function Tree({
  children,
  domain = 'green',
}: {
  children: React.ReactNode;
  domain?: 'green' | 'blue';
}) {
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

const KLEIN = 'Flux.2 Klein 9B';
const EA_DOWNLOAD = 20_000;
const LABEL = 'Not commercially available at the moment';

// v3059408 shape: permanent paywall with a download price, no stored generation fee.
const paywalled = (extra: Record<string, unknown> = {}) => ({
  ...F.MODEL.modelVersions[0],
  canDownload: false,
  paidAccess: {
    endsAt: null,
    timeframeDays: null,
    terms: { download: { price: EA_DOWNLOAD }, generation: { price: 5_000 } },
    sale: null,
  },
  ...extra,
});

const mount = (version: Record<string, unknown>) =>
  render(
    <Tree>
      <ModelVersionDetails model={F.MODEL} version={version as never} image={undefined} />
    </Tree>
  );

const text = () => document.body.textContent ?? '';
const downloadButton = () =>
  Array.from(document.querySelectorAll('a,button')).find((b) =>
    /^Download/.test(b.textContent?.trim() ?? '')
  ) as HTMLElement | undefined;

beforeEach(() => {
  mocks.user = null;
  mocks.access = [];
  mocks.flags = { imageGeneration: true };
});

describe('ModelVersionDetails — non-commercial base hides price and fee', () => {
  test('gated non-buyer: label, locked disabled Download, no price', async () => {
    mount(paywalled({ baseModel: KLEIN }));
    await expect.element(page.getByTestId('not-commercially-available')).toBeInTheDocument();
    expect(text()).toContain(LABEL);
    expect(text()).toContain('licensed for non-commercial use only');
    expect(text()).not.toMatch(/20[,.]?000|20k|20K/);
    expect(text()).not.toMatch(/(?<!\d)5k/i);
    expect(
      document.querySelector('[data-testid="not-commercially-available-generate"]')
    ).toBeTruthy();
    const btn = downloadButton();
    expect(btn).toBeTruthy();
    expect(
      btn!.hasAttribute('disabled') ||
        btn!.getAttribute('aria-disabled') === 'true' ||
        btn!.hasAttribute('data-disabled')
    ).toBe(true);
    expect(btn!.getAttribute('href')).toBeNull();
  });

  test('license fee row is hidden', async () => {
    mount(paywalled({ baseModel: KLEIN, licensingFee: 500 }));
    await expect.element(page.getByText('Base Model', { exact: true })).toBeInTheDocument();
    expect(text()).not.toContain('Generation License Fee');
  });

  test('buyer keeps a working Download link', async () => {
    mocks.access = [
      {
        entityId: F.VERSION_IDS[0],
        entityType: 'ModelVersion',
        hasAccess: true,
        permissions: 1 | 2 | 4 | 8,
      },
    ];
    mount(paywalled({ baseModel: KLEIN, canDownload: false }));
    await expect.element(page.getByText('Base Model', { exact: true })).toBeInTheDocument();
    expect(text()).not.toContain(LABEL);
    expect(downloadButton()?.getAttribute('href')).toBeTruthy();
    expect(downloadButton()?.hasAttribute('data-disabled')).toBe(false);
  });

  test('commercial control: fee and price still show', async () => {
    mount(paywalled({ baseModel: 'SDXL 1.0', licensingFee: 500 }));
    await expect.element(page.getByText('Generation License Fee')).toBeInTheDocument();
    expect(text()).not.toContain(LABEL);
    expect(text()).toMatch(/20[,.]?000|20k|20K/);
    expect(text()).toMatch(/(?<!\d)5k/i);
  });
});
