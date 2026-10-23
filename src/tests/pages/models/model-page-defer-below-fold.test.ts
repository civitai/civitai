import { createElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { Window } from 'happy-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsProviderModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsProviderModule from '~/providers/BrowserSettingsProvider';
import type * as ToursProviderModule from '~/components/Tours/ToursProvider';
import type * as AdsProviderModule from '~/components/Ads/AdsProvider';
import type * as SignalsProviderModule from '~/components/Signals/SignalsProvider';
import * as F from './model-page-fixture';

/**
 * The model page's SERVER render under the `modelPageDeferBelowFold` trial, and under
 * `modelPageDesignSystemMarkup` (the last three describes).
 *
 * Renders the real page component (and the real `ModelVersionDetails` under it) to an HTML string
 * in the node unit project, inside the real Theme/App/IsClient/Router/IntersectionObserver
 * providers. Only context hooks whose providers need a browser or a socket are stubbed, and
 * `trpc` answers with SERVER semantics: a query `getServerSideProps` prefetches has data, every
 * other query is still pending — which is what the server render actually sees.
 *
 * Flag OFF must emit every sidebar section it emits today; flag ON must keep everything above the
 * fold and everything SEO reads (title, description, version details, files, meta tags, canonical,
 * JSON-LD) and replace only the deferred sections with their placeholders.
 *
 * Lives under `src/tests/` because a test file under `src/pages/` is a route to `next build`.
 */

const m = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  user: null as null | Record<string, unknown>,
  downloaded: [] as number[],
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
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
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => m.user }));
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
  // Exactly what the page's getServerSideProps prefetches — including `user.getCreator` in both
  // flag states, as `model-page-defer-prefetch.test.ts` pins — so a server-rendered reader of any
  // of them sees the data it would see in production.
  const prefetched: Record<string, unknown> = {
    'model.getById': q(() => F.MODEL),
    'user.getCreator': q(() => F.CREATOR),
    'model.getCollectionShowcase': q(() => F.SHOWCASE_COLLECTION),
    'common.getEntityAccess': q(() => [
      { entityId: F.VERSION_IDS[0], entityType: 'ModelVersion', hasAccess: true },
    ]),
    'blocks.listForModel': q(() => []),
    'hiddenPreferences.getHidden': q(() => undefined),
    'user.getEngagedModelVersions': q(() => ({ Notify: [], Downloaded: m.downloaded })),
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
  const procedures = new Proxy(prefetched, {
    get: (target, key: string) => (key in target ? target[key] : notPrefetched),
  });
  return { ...(await importOriginal<typeof Trpc>()), trpc: makeTrpcProxy(procedures) };
});

const { default: ModelPage } = await import('~/pages/models/[id]/[[...slug]]');
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
const { HeadManagerContext } = await import(
  'next/dist/shared/lib/head-manager-context.shared-runtime'
);
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');

// The anonymous static flag set (Flipt is not loaded in a unit test), so the sections render with
// the flags a logged-out visitor gets rather than with everything off.
const ANON_FLAGS = { ...getFeatureFlags({ host: 'civitai.com' }) } as Record<string, boolean>;

type Layer = [unknown, Record<string, unknown> | null];

/** Server-render the page; returns the body HTML and the `next/head` markup it emitted. */
function renderPage(flags: Record<string, boolean>) {
  m.flags = flags;
  let headElements: ReactNode = null;
  const headManager = {
    mountedInstances: new Set(),
    updateHead: (state: ReactNode) => {
      headElements = state;
    },
  };
  const layers: Layer[] = [
    [HeadManagerContext.Provider, { value: headManager }],
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
        isAuthed: !!m.user,
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
    createElement(ModelPage as never, { id: F.MODEL_ID })
  );
  const html = renderToString(tree);
  const head = renderToStaticMarkup(createElement('head', null, headElements));
  return { html, head };
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/** The collection-showcase accordion panel's markup, from its region id to the next item. */
function showcasePanel(html: string) {
  const start = html.indexOf('panel-collection-showcase"');
  if (start === -1) throw new Error('collection-showcase panel not rendered at all');
  return html.slice(start, html.indexOf('mantine-Accordion-item', start));
}

// Markers that only the deferred sections emit (plus the downloader review card's prompt, which is
// NOT deferred). Each is checked present with the flag off, so an absence with the flag on cannot
// be a marker that never matched.
// The creator card's root marker: `CreatorCardSimple` (what `SmartCreatorCard` renders under the
// public `cosmeticShop` flag) draws this background image unconditionally — with the creator's
// data and with its zeroed no-data fallback alike — so it appears whenever the card renders at
// all, whatever the `user.getCreator` query returned.
const CREATOR_CARD_ROOT = 'alt="default creator card background decoration"';
const CREATOR_CARD_LINK = 'href="https://example.com/lanternsmith"';
const LICENSE_TEXT = 'License<!-- -->:';
const PERMISSION_ICON = 'tabler-icon-businessplan';
const SHOWCASE_BODY = 'mantine-ScrollArea-root';
const USER_REVIEW_PROMPT = 'What did you think of this resource?';

const VIEWER = {
  id: 5,
  username: 'lantern-viewer',
  isModerator: false,
  muted: false,
  bannedAt: null,
  tier: 'free',
  filePreferences: {},
};

beforeEach(() => {
  m.user = null;
  m.downloaded = [];
});

describe('model page server render — modelPageDeferBelowFold OFF', () => {
  it('renders the creator card, license, permissions and collection-showcase body', () => {
    const { html } = renderPage({ ...ANON_FLAGS, modelPageDeferBelowFold: false });

    expect(count(html, CREATOR_CARD_ROOT)).toBe(1);
    expect(count(html, CREATOR_CARD_LINK)).toBe(1);
    expect(count(html, LICENSE_TEXT)).toBe(1);
    expect(count(html, PERMISSION_ICON)).toBe(1);
    expect(showcasePanel(html)).toContain(SHOWCASE_BODY);
    expect(html).not.toContain('data-deferred-section');
  });

  it("renders a downloader's own review card", () => {
    m.user = VIEWER;
    m.downloaded = [F.VERSION_IDS[0]];
    const { html } = renderPage({ ...ANON_FLAGS, modelPageDeferBelowFold: false });

    expect(count(html, USER_REVIEW_PROMPT)).toBe(1);
    expect(html).not.toContain('data-deferred-section');
  });
});

// Under both markups: the design-system flag must not move what the defer trial defers.
describe.each([false, true])(
  'model page server render — modelPageDeferBelowFold ON (design-system markup %s)',
  (ds) => {
    const flags = { ...ANON_FLAGS, modelPageDeferBelowFold: true, modelPageDesignSystemMarkup: ds };

    it('keeps the above-the-fold and SEO content', () => {
      const { html, head } = renderPage(flags);

      // Title, model description, the selected version's description, details and files.
      expect(html).toMatch(new RegExp(`<h1[^>]*>${F.MODEL_NAME}</h1>`));
      expect(html).toContain(F.MODEL_DESCRIPTION_MARKER);
      expect(html).toContain(F.VERSION_DESCRIPTION_MARKER);
      expect(html).toContain('Trigger Words');
      expect(html).toContain('lanternglow');
      expect(html).toContain('>Download<');
      expect(html).toContain(`>lantern_glow_v${F.VERSION_IDS[0]}_1.safetensors<`);
      // The hero carousel's images.
      expect(html).toContain(F.IMAGES[0].url);
      // Meta, canonical and structured data.
      expect(head).toContain(
        `<title>${F.MODEL_NAME} - v3.0 | Stable Diffusion XL LoRA | Civitai</title>`
      );
      expect(head).toMatch(/<meta name="description" content="About lantern-description-marker/);
      expect(head).toContain(
        '<link rel="canonical" href="/models/4201/lantern-glow-portrait-lora"/>'
      );
      expect(head).toContain('"@type":"SoftwareApplication"');
      expect(head).toContain('"@type":"BreadcrumbList"');
    });

    it('replaces the creator card, license and permissions with placeholders and empties the showcase body', () => {
      const { html } = renderPage(flags);

      expect(count(html, CREATOR_CARD_ROOT)).toBe(0);
      expect(count(html, CREATOR_CARD_LINK)).toBe(0);
      expect(count(html, LICENSE_TEXT)).toBe(0);
      expect(count(html, PERMISSION_ICON)).toBe(0);
      expect(showcasePanel(html)).not.toContain(SHOWCASE_BODY);
      expect(count(html, 'data-deferred-section="creator-card"')).toBe(1);
      expect(count(html, 'data-deferred-section="license"')).toBe(1);
      // The showcase's header row (its name) is not deferred.
      expect(html).toContain(F.SHOWCASE_COLLECTION_NAME);
    });

    it("still server-renders a downloader's own review card (it is not deferred)", () => {
      m.user = VIEWER;
      m.downloaded = [F.VERSION_IDS[0]];
      const { html } = renderPage(flags);

      expect(count(html, USER_REVIEW_PROMPT)).toBe(1);
      expect(count(html, 'data-deferred-section="user-review"')).toBe(0);
    });
  }
);

// ─── modelPageDesignSystemMarkup ────────────────────────────────────────────────────────────────

// `air` is a signed-in default; switched on here so the AIR row renders for the anonymous viewer.
const DS_OFF = { ...ANON_FLAGS, air: true, modelPageDesignSystemMarkup: false };
const DS_ON = { ...ANON_FLAGS, air: true, modelPageDesignSystemMarkup: true };

/** Parsed without installing DOM globals: the page must keep rendering down its SERVER paths. */
function parse(html: string) {
  const window = new Window();
  const root = window.document.createElement('div');
  root.innerHTML = html;
  return root as unknown as HTMLElement;
}

const dsAttrs = (el: Element) => ({
  ui: el.getAttribute('data-civitai-ui'),
  variant: el.getAttribute('data-variant'),
  size: el.getAttribute('data-size'),
});
const text = (el: Element) => (el.textContent ?? '').trim();

const ACTION_LABELS = [
  'Share',
  'Like',
  'Get notifications for this model',
  'Add to collection',
  'Report',
];

describe('model page server render — modelPageDesignSystemMarkup ON', () => {
  it('renders the title as a plain h1 and the stats as large light badges', () => {
    const root = parse(renderPage(DS_ON).html);
    const h1 = root.querySelectorAll('h1');
    expect(h1).toHaveLength(1);
    expect(text(h1[0])).toBe(F.MODEL_NAME);
    expect(h1[0].className).not.toContain('mantine-');

    const stats = [...root.querySelectorAll('[data-civitai-ui="badge"][data-size="lg"]')];
    // Reviews, downloads, generations, collections, Buzz.
    expect(stats.map(dsAttrs)).toEqual(
      Array(5).fill({ ui: 'badge', variant: 'light', size: 'lg' })
    );
    // Each carries its icon in a leading section, as `IconBadge` does.
    for (const badge of stats) expect(badge.firstElementChild?.querySelector('svg')).not.toBeNull();
  });

  it('renders the category and tags as badge links, and the overflow toggle as a badge button', () => {
    const root = parse(renderPage(DS_ON).html);
    const links = [...root.querySelectorAll('a[href^="/tag/"]')].map((a) => ({
      text: text(a),
      href: a.getAttribute('href'),
      ...dsAttrs(a),
    }));
    const tag = { ui: 'badge', size: 'sm', variant: 'filled' };
    expect(links).toEqual([
      { text: 'portraits', href: '/tag/portraits', ui: 'badge', size: 'sm', variant: 'light' },
      { text: 'lighting', href: '/tag/lighting', ...tag },
      { text: 'warm', href: '/tag/warm', ...tag },
      { text: 'bokeh', href: '/tag/bokeh', ...tag },
      { text: 'film', href: '/tag/film', ...tag },
      { text: 'rim light', href: '/tag/rim%20light', ...tag },
    ]);
    const toggle = [...root.querySelectorAll('button')].filter((b) => text(b) === '+ 1');
    expect(toggle.map(dsAttrs)).toEqual([{ ui: 'badge', variant: 'light', size: 'sm' }]);
    expect(toggle[0].hasAttribute('type')).toBe(false);
    // Both dividers of the "Updated" row.
    expect(
      root.querySelectorAll('[role="separator"][data-orientation="vertical"]').length
    ).toBeGreaterThanOrEqual(2);
  });

  it('renders the version buttons and scroll arrows as design-system buttons', () => {
    const root = parse(renderPage(DS_ON).html);
    const list = root.querySelector('.mantine-ScrollArea-root');
    const buttons = [...(list?.querySelectorAll('button') ?? [])].map((b) => ({
      text: text(b),
      label: b.getAttribute('aria-label'),
      type: b.getAttribute('type'),
      ...dsAttrs(b),
    }));
    const arrow = { text: '', type: 'button', ui: 'button', variant: 'subtle', size: 'sm' };
    const version = { label: null, type: 'button', ui: 'button', variant: 'filled', size: 'sm' };
    expect(buttons).toEqual([
      { ...arrow, label: 'Scroll versions left' },
      { ...version, text: 'v3.0' },
      { ...version, text: 'v2.0' },
      { ...version, text: 'v1.0' },
      { ...arrow, label: 'Scroll versions right' },
    ]);
  });

  it('renders the action row as full-width design-system buttons in tooltip wrappers', () => {
    const root = parse(renderPage(DS_ON).html);
    for (const label of ACTION_LABELS) {
      const button = root.querySelector(`button[aria-label="${label}"]`);
      expect(button, label).not.toBeNull();
      expect(
        { ...dsAttrs(button as Element), full: button?.getAttribute('data-full-width') },
        label
      ).toEqual({
        ui: 'button',
        variant: 'filled',
        size: 'md',
        full: 'true',
      });
      expect(button?.closest('[data-civitai-ui="tooltip"]'), label).not.toBeNull();
    }
    // The bubbles are client-only: nothing for the server to clip or hide.
    expect(root.querySelectorAll('[data-civitai-ui-tooltip-bubble]')).toHaveLength(0);
    expect(root.querySelectorAll('[role="tooltip"]')).toHaveLength(0);
  });

  it('renders the Details rows, trigger words, hash and AIR without Mantine', () => {
    const root = parse(renderPage(DS_ON).html);
    const badges = new Map(
      [...root.querySelectorAll('[data-civitai-ui="badge"]')].map((b) => [text(b), dsAttrs(b)])
    );
    const sm = (variant: string) => ({ ui: 'badge', size: 'sm', variant });
    expect(badges.get('LoRA')).toEqual(sm('filled'));
    expect(badges.get('Steps: 4,200')).toEqual(sm('light'));
    expect(badges.get('Epochs: 12')).toEqual(sm('light'));
    expect(badges.get('Clip Skip: 2')).toEqual(sm('light'));
    expect(badges.get('Strength: 0.8')).toEqual(sm('light'));
    expect(badges.get('lanternglow')).toEqual(sm('light'));
    expect(badges.get('warm rim light')).toEqual(sm('light'));
    expect(badges.get('AutoV2')).toEqual({ ui: 'badge', size: 'md', variant: 'outline' });
    expect(badges.get('A1B2C3D4E0')).toEqual({ ui: 'badge', size: 'md', variant: 'outline' });

    const codes = [...root.querySelectorAll('code')];
    expect(codes.map(text).slice(0, 4)).toEqual([
      'civitai:',
      `${F.MODEL_ID}`,
      '@',
      `${F.VERSION_IDS[0]}`,
    ]);
    for (const code of codes) expect(code.className).not.toContain('mantine-');
  });

  it('emits no Mantine Grid, Title, Code or Divider root and no per-instance grid <style>', () => {
    const on = renderPage(DS_ON).html;
    const off = renderPage(DS_OFF).html;
    for (const name of ['Grid', 'Title', 'Code', 'Divider']) {
      // Control: each is present with the flag off, so a zero below is not a class that never matched.
      expect(mantineRoots(off)[name], name).toBeGreaterThan(0);
      expect(mantineRoots(on)[name] ?? 0, name).toBe(0);
    }
    expect(count(on, 'mantine-grid (min-width')).toBe(0);
    expect(count(off, 'mantine-grid (min-width')).toBeGreaterThan(0);
  });
});

/** Every `mantine-<Name>-root` class in the HTML, by component name. */
function mantineRoots(html: string) {
  const counts: Record<string, number> = {};
  for (const match of html.matchAll(/\bmantine-([A-Za-z]+)-root\b/g))
    counts[match[1]] = (counts[match[1]] ?? 0) + 1;
  return counts;
}
const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

describe('model page server render — modelPageDesignSystemMarkup OFF', () => {
  it('still renders the Mantine page, with no design-system markup', () => {
    const root = parse(renderPage(DS_OFF).html);
    expect(root.querySelectorAll('[data-civitai-ui]')).toHaveLength(0);
    expect(root.querySelector('h1')?.className).toContain('mantine-Title-root');
    expect(root.querySelector('a[href="/tag/portraits"]')?.className).toContain(
      'mantine-Badge-root'
    );
    expect(root.querySelector('button[aria-label="Share"]')?.className).toContain(
      'mantine-Button-root'
    );
  });

  it('exposes the same names, hrefs, roles and aria as the flag-ON page', () => {
    // Interactive elements and everything carrying a role or ARIA state, in document order. Ids
    // come from `useId` and follow tree shape, so only their presence is compared.
    const semantics = (html: string) =>
      [
        ...parse(html).querySelectorAll(
          'a, button, h1, [role], [aria-label], [aria-haspopup], [aria-expanded], [aria-controls], [aria-describedby], [tabindex]'
        ),
      ].map((el) => ({
        interactive: el.matches('a, button'),
        text: text(el),
        href: el.getAttribute('href'),
        target: el.getAttribute('target'),
        rel: el.getAttribute('rel'),
        type: el.getAttribute('type'),
        title: el.getAttribute('title'),
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        ariaHaspopup: el.getAttribute('aria-haspopup'),
        ariaExpanded: el.getAttribute('aria-expanded'),
        ariaControls: el.hasAttribute('aria-controls'),
        ariaDescribedby: el.hasAttribute('aria-describedby'),
        tabIndex: el.getAttribute('tabindex'),
        disabled: el.hasAttribute('disabled'),
      }));
    const off = semantics(renderPage(DS_OFF).html);
    const on = semantics(renderPage(DS_ON).html);
    expect(off.length).toBeGreaterThan(30);
    expect(on).toEqual(off);
  });
});

describe('model page server render — modelPageDesignSystemMarkup, Mantine roots OFF vs ON', () => {
  it('drops the replaced components from the server HTML', () => {
    const off = mantineRoots(renderPage(DS_OFF).html);
    const on = mantineRoots(renderPage(DS_ON).html);
    // The measurement this flag exists for, printed for the PR record.
    console.info('[modelPageDesignSystemMarkup] mantine-*-root classes', {
      off: total(off),
      on: total(on),
      byComponent: Object.fromEntries(
        [...new Set([...Object.keys(off), ...Object.keys(on)])]
          .sort()
          .map((name) => [name, { off: off[name] ?? 0, on: on[name] ?? 0 }])
      ),
    });
    for (const name of ['Badge', 'Button', 'Group', 'Stack', 'Text'])
      expect(on[name] ?? 0, name).toBeLessThan(off[name] ?? 0);
    expect(total(on)).toBeLessThan(total(off));
  });
});
