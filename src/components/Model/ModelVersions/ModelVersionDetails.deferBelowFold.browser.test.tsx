import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsProviderModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsProviderModule from '~/providers/BrowserSettingsProvider';
import type * as AdsProviderModule from '~/components/Ads/AdsProvider';
import type * as SignalsProviderModule from '~/components/Signals/SignalsProvider';
import * as F from '~/tests/pages/models/model-page-fixture';

/**
 * `modelPageDeferBelowFold` across the server → client seam: `renderToString` → `hydrateRoot`.
 *
 * The server render uses the real `IsClientProvider`, so it emits the placeholders exactly as the
 * server does; the hydrating render must produce the same markup (no recoverable hydration error,
 * no hydration console error), and only the render AFTER mount may swap in the deferred sections —
 * at which point the creator card first reads `user.getCreator` (in production served from the
 * query the server still prefetches and dehydrates).
 *
 * DETECTORS, two independent ones (React's warning text can change without disarming both):
 * `hydrateRoot`'s `onRecoverableError`, and a console.error match. The INSTRUMENT CHECK proves the
 * pair goes red on a real server/client divergence, so "no mismatch" cannot mean "never hydrated".
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

/** Marks the container once the client's effects have run, i.e. hydration has committed. */
function HydratedMarker() {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => {
    ref.current?.setAttribute('data-hydrated', 'true');
  }, []);
  return <span ref={ref} data-hydrated="false" />;
}

const details = ({ ds = false }: { ds?: boolean } = {}) => (
  <Tree>
    <ModelVersionDetails
      model={F.MODEL}
      version={F.MODEL.modelVersions[0]}
      image={undefined}
      ds={ds}
    />
    <HydratedMarker />
  </Tree>
);

const HYDRATION_RE =
  /(Hydration failed|An error occurred during hydration|The server HTML was replaced|Expected server HTML|did not match|Text content does not match)/i;
const CREATOR_CARD_LINK = 'a[href="https://example.com/lanternsmith"]';

let consoleErrors: string[] = [];
let recoverable: string[] = [];
let restoreConsole: (() => void) | null = null;
const containers: HTMLElement[] = [];

beforeEach(() => {
  consoleErrors = [];
  recoverable = [];
  mocks.getCreator.mockReset();
  mocks.user = null;
  const original = console.error;
  console.error = ((...args: unknown[]) => {
    consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    original.apply(console, args as []);
  }) as typeof console.error;
  restoreConsole = () => {
    console.error = original;
  };
});

afterEach(() => {
  restoreConsole?.();
  restoreConsole = null;
  for (const c of containers.splice(0)) c.remove();
});

const hydrationConsoleErrors = () =>
  consoleErrors.filter(
    (e) => HYDRATION_RE.test(e) && !/useLayoutEffect does nothing on the server/.test(e)
  );

/**
 * Plant server HTML, hydrate it, and wait until the client's effects have run. Hydration errors are
 * reported during the hydration commit, before effects, so every assertion on the detectors that
 * follows reads a finished hydration rather than racing it.
 */
async function hydrateInto(html: string, tree: React.ReactElement) {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  containers.push(container);
  hydrateRoot(container, tree, {
    onRecoverableError: (err) => {
      recoverable.push(err instanceof Error ? err.message : String(err));
    },
  });
  if (container.querySelector('[data-hydrated]')) {
    await expect
      .poll(() => container.querySelector('[data-hydrated]')?.getAttribute('data-hydrated'))
      .toBe('true');
  } else {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return container;
}

describe('ModelVersionDetails — modelPageDeferBelowFold hydration', () => {
  test('INSTRUMENT CHECK: a server/client divergence is reported by both detectors', async () => {
    function Divergent() {
      return <span>{typeof window === 'undefined' ? 'server' : 'client'}</span>;
    }
    // renderToString runs in the browser here, so fake the server output by hand.
    await hydrateInto('<span>server</span>', <Divergent />);
    expect(recoverable.length).toBeGreaterThan(0);
    expect(hydrationConsoleErrors().length).toBeGreaterThan(0);
  });

  test('ON: server emits placeholders, hydration matches, the sections and their fetch arrive after mount', async () => {
    mocks.flags = { modelPageDeferBelowFold: true, cosmeticShop: true };
    const html = renderToString(details());

    expect(html).toContain('data-deferred-section="creator-card"');
    expect(html).toContain('data-deferred-section="license"');
    expect(html).not.toContain('https://example.com/lanternsmith');
    expect(mocks.getCreator).not.toHaveBeenCalled();

    const container = await hydrateInto(html, details());

    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
    // After mount: the real creator card replaced its placeholder and asked for its own data.
    await expect.poll(() => container.querySelector(CREATOR_CARD_LINK)).not.toBeNull();
    expect(container.textContent).toContain('License');
    expect(container.querySelector('[data-deferred-section]')).toBeNull();
    expect(mocks.getCreator).toHaveBeenCalledWith({ id: F.CREATOR_ID });
  });

  test('OFF: server emits the sections themselves and hydration matches', async () => {
    mocks.flags = { modelPageDeferBelowFold: false, cosmeticShop: true };
    const html = renderToString(details());

    expect(html).not.toContain('data-deferred-section');
    expect(html).toContain('https://example.com/lanternsmith');

    const container = await hydrateInto(html, details());

    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
    expect(container.querySelector(CREATOR_CARD_LINK)).not.toBeNull();
  });

  test('design-system markup (`ds`): hydration matches, and the client keeps the markup', async () => {
    mocks.flags = { modelPageDeferBelowFold: true, cosmeticShop: true, air: true };
    const html = renderToString(details({ ds: true }));
    // Control: this is the design-system render, not the Mantine one.
    expect(html).toContain('data-civitai-ui="button"');
    expect(html).toContain('data-civitai-ui="tooltip"');

    const container = await hydrateInto(html, details({ ds: true }));

    expect(recoverable).toEqual([]);
    expect(hydrationConsoleErrors()).toEqual([]);
    expect(
      container.querySelector('button[aria-label="Share"]')?.getAttribute('data-civitai-ui')
    ).toBe('button');
  });
});
