// @vitest-environment happy-dom
import { act, createElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsProviderModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsProviderModule from '~/providers/BrowserSettingsProvider';
import type * as ToursProviderModule from '~/components/Tours/ToursProvider';
import type * as AdsProviderModule from '~/components/Ads/AdsProvider';
import type * as SignalsProviderModule from '~/components/Signals/SignalsProvider';
import type * as ComCardPreviewModule from '~/components/Model/ComCardPreview/ComCardPreview';
import * as F from './model-page-fixture';

/**
 * The model page under `ssrSignedInSkipPrefetch`'s `skip` arm, from server HTML through hydration
 * to the rendered page: real `renderToString` → `hydrateRoot`, as in
 * `ImageDetailPage.ssrHydration.browser.test.tsx`, inside the real IsClient/Router/App providers.
 *
 * - With `model.getById` dehydrated (what the `skip` arm's getServerSideProps leaves): the server
 *   HTML is the loader, the hydrating render reproduces it with no mismatch, and the content
 *   renders once the client has mounted — with no further fetch.
 * - With an EMPTY cache (a failed fail-soft prefetch, or a `/_next/data` navigation): the loader
 *   hydrates, and the content renders when the client's own `model.getById` query lands.
 *
 * The content subtree is replaced by a probe at its root (`ComCardPreviewScope`, the only child of
 * the page's `<Gated>`): what is measured here is WHEN the page reaches its content and that the
 * hydration matches; the content's own markup is pinned by `model-page-defer-below-fold.test.ts`.
 * The `<head>` the page emits is read through `next/head`'s head manager, and carries the data.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const m = vi.hoisted(() => ({
  /** `model.getById` in the client cache (`cached`), or still loading (`pending`). */
  getById: 'cached' as 'cached' | 'pending',
  flags: {} as Record<string, boolean>,
  // ONE router object, as Next's is: a fresh `query` per render reads to `BrowserRouterProvider` as
  // a navigation on every render, which loops once effects run.
  router: {
    query: { id: '4201', slug: ['lantern-glow-portrait-lora'], modelVersionId: '9301' },
    asPath: '/models/4201/lantern-glow-portrait-lora?modelVersionId=9301',
    pathname: '/models/[id]/[[...slug]]',
    replace: async () => true,
    push: async () => true,
    events: { on: () => undefined, off: () => undefined },
    isReady: true,
  },
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));
vi.mock('next/router', () => ({ useRouter: () => m.router }));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    id: 5,
    username: 'lantern-viewer',
    isModerator: false,
    muted: false,
    bannedAt: null,
    tier: 'free',
    filePreferences: {},
  }),
}));
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
vi.mock('~/components/Model/ComCardPreview/ComCardPreview', async (importOriginal) => ({
  ...(await importOriginal<typeof ComCardPreviewModule>()),
  ComCardPreviewScope: () => createElement('div', { 'data-testid': 'model-content' }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  const F = await import('./model-page-fixture');
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
  // Only `model.getById`: the `skip` arm prefetches nothing else, so every other query is loading.
  const getById = {
    useQuery: () =>
      m.getById === 'cached' ? { data: F.MODEL, isLoading: false, isSuccess: true } : pending,
  };
  const procedures = new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => (key === 'model.getById' ? getById : notPrefetched),
  });
  return { ...(await importOriginal<typeof Trpc>()), trpc: makeTrpcProxy(procedures) };
});

const { default: ModelPage } = await import('~/pages/models/[id]/[[...slug]]');
const { getFeatureFlags } = await import('~/server/services/feature-flags.service');
// The anonymous static flag set (Flipt is not loaded in a unit test), as in the server-render test.
m.flags = { ...getFeatureFlags({ host: 'civitai.com' }) } as Record<string, boolean>;
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
const { HeadManagerContext } = await import(
  'next/dist/shared/lib/head-manager-context.shared-runtime'
);
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');

/** PageLoader's root: the loader the page renders in place of its content. */
const PAGE_LOADER = '.absolute.inset-0.flex.items-center.justify-center.gap-4';
const CONTENT = '[data-testid="model-content"]';
const TITLE = `<title>${F.MODEL_NAME} - v3.0 | Stable Diffusion XL LoRA | Civitai</title>`;

const HYDRATION_RE =
  /(Hydration failed|An error occurred during hydration|The server HTML was replaced|Expected server HTML|did not match|Text content does not match)/i;

let head: ReactNode = null;
const headManager = {
  mountedInstances: new Set(),
  updateHead: (state: ReactNode) => {
    head = state;
  },
};
const queryClient = new QueryClient();

type Layer = [unknown, Record<string, unknown> | null];

function Tree({ deferredSsr }: { deferredSsr: boolean }): ReactElement {
  const layers: Layer[] = [
    [HeadManagerContext.Provider, { value: headManager }],
    [QueryClientProvider, { client: queryClient }],
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
  return layers.reduceRight<ReactElement>(
    (child, [Component, props]) => createElement(Component as never, props, child),
    createElement(ModelPage as never, { id: F.MODEL_ID, initialMobile: false, deferredSsr })
  );
}

let consoleErrors: string[] = [];
let recoverable: string[] = [];
const roots: Root[] = [];
const containers: HTMLElement[] = [];

const hydrationErrors = () => [
  ...recoverable,
  ...consoleErrors.filter((e) => HYDRATION_RE.test(e)),
];

// Captured once: a spy left over from a failed test must never become the next test's "original".
const originalConsoleError = console.error.bind(console);

beforeEach(() => {
  m.getById = 'cached';
  head = null;
  consoleErrors = [];
  recoverable = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    originalConsoleError(...args);
  });
});

afterEach(() => {
  try {
    act(() => {
      for (const root of roots.splice(0)) root.unmount();
    });
  } finally {
    for (const container of containers.splice(0)) container.remove();
    vi.restoreAllMocks();
  }
});

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The server's HTML, hydrated with the client's tree; returns once effects have run. */
async function hydrate(server: { deferredSsr: boolean }, client = server) {
  const html = renderToString(createElement(Tree, server));
  // The "server" render runs in a DOM environment here; only the hydration is measured.
  consoleErrors = [];
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  containers.push(container);
  await act(async () => {
    roots.push(
      hydrateRoot(container, createElement(Tree, client), {
        onRecoverableError: (err) =>
          recoverable.push(err instanceof Error ? err.message : String(err)),
      })
    );
    await flush();
  });
  return { html, container, root: roots[roots.length - 1] };
}

const parse = (html: string) => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
};
const headMarkup = () => renderToStaticMarkup(createElement('head', null, head));

describe('model page deferredSsr: server HTML → hydration → content', () => {
  it('INSTRUMENT CHECK: hydrating the shell with the full page IS reported as a mismatch', async () => {
    // The server rendered the shell; a client that does not defer renders the content at once.
    await hydrate({ deferredSsr: true }, { deferredSsr: false });
    expect(hydrationErrors().length).toBeGreaterThan(0);
  });

  it('model.getById dehydrated: the loader hydrates with no mismatch, then the content renders', async () => {
    const { html, container } = await hydrate({ deferredSsr: true });

    // Server HTML: the loader, no content.
    expect(parse(html).querySelectorAll(PAGE_LOADER)).toHaveLength(1);
    expect(parse(html).querySelector(CONTENT)).toBeNull();
    // Hydration matched.
    expect(hydrationErrors()).toEqual([]);
    // Mounted: the content, the loader gone, and the head carries the model.
    expect(container.querySelectorAll(CONTENT)).toHaveLength(1);
    expect(container.querySelector(PAGE_LOADER)).toBeNull();
    expect(headMarkup()).toContain(TITLE);
  });

  it('empty cache: the loader hydrates, and the content renders when model.getById lands', async () => {
    m.getById = 'pending';
    const { html, container, root } = await hydrate({ deferredSsr: true });

    expect(parse(html).querySelectorAll(PAGE_LOADER)).toHaveLength(1);
    expect(hydrationErrors()).toEqual([]);
    // Mounted, but the query is still loading: still the loader.
    expect(container.querySelector(CONTENT)).toBeNull();
    expect(container.querySelectorAll(PAGE_LOADER)).toHaveLength(1);

    m.getById = 'cached';
    await act(async () => {
      root.render(createElement(Tree, { deferredSsr: true }));
      await flush();
    });

    expect(container.querySelectorAll(CONTENT)).toHaveLength(1);
    expect(container.querySelector(PAGE_LOADER)).toBeNull();
    expect(headMarkup()).toContain(TITLE);
  });

  it('deferredSsr false: the content is in the server HTML and hydrates with no mismatch', async () => {
    const { html, container } = await hydrate({ deferredSsr: false });

    expect(parse(html).querySelectorAll(CONTENT)).toHaveLength(1);
    expect(parse(html).querySelector(PAGE_LOADER)).toBeNull();
    expect(hydrationErrors()).toEqual([]);
    expect(container.querySelectorAll(CONTENT)).toHaveLength(1);
  });
});
