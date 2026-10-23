/**
 * THE MODEL PAGE ON `@civitai/components` MARKUP (flag `modelPageDesignSystemMarkup`), MEASURED
 * AGAINST THE MANTINE PAGE IT REPLACES, IN THE REAL APP CASCADE.
 *
 * Renders the real page component twice, flag OFF and flag ON, and compares every heading, link,
 * button, badge, code, paragraph and the Mantine cards and accordion items around them: same boxes,
 * same ink placement, same computed styles, in light and dark, at a desktop and a phone width. The
 * literal markup contract is pinned in `src/tests/pages/models/model-page-defer-below-fold.test.ts`
 * (the server render); this file is about what a user sees.
 *
 * Only parts that are identical in both arms and not under test are stubbed (the carousel, the
 * below-the-fold sections, ads), so the comparison cannot be disturbed by images loading.
 */
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
import type { Viewport } from '../../../../test/geometry-setup';
import { cascadeEvidence, nextLayout, renderAtViewport } from '../../../../test/geometry-setup';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsProviderModule from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsProviderModule from '~/providers/BrowserSettingsProvider';
import type * as ToursProviderModule from '~/components/Tours/ToursProvider';
import type * as AdsProviderModule from '~/components/Ads/AdsProvider';
import type * as SignalsProviderModule from '~/components/Signals/SignalsProvider';
import * as F from '~/tests/pages/models/model-page-fixture';

type Scheme = 'light' | 'dark';

const state = vi.hoisted(() => ({ ds: false, scheme: 'dark' as 'light' | 'dark' }));

vi.mock('next/router', () => {
  const router = {
    query: { id: '4201', slug: ['lantern-glow-portrait-lora'], modelVersionId: '9301' },
    asPath: '/models/4201/lantern-glow-portrait-lora?modelVersionId=9301',
    pathname: '/models/[id]/[[...slug]]',
    route: '/models/[id]/[[...slug]]',
    basePath: '',
    replace: vi.fn().mockResolvedValue(true),
    push: vi.fn().mockResolvedValue(true),
    prefetch: vi.fn().mockResolvedValue(undefined),
    back: vi.fn(),
    events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
    isReady: true,
    isFallback: false,
  };
  return { __esModule: true, useRouter: () => router, Router: router, default: router };
});
// The page module's `getServerSideProps` imports; never called here.
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({ getDefaultModelVersion: vi.fn() }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => {
  const flags = () => ({
    canWrite: true,
    collections: true,
    imageGeneration: true,
    air: true,
    cosmeticShop: true,
    modelPageDesignSystemMarkup: state.ds,
  });
  return {
    ...(await importOriginal<typeof FeatureFlagsProviderModule>()),
    useFeatureFlags: flags,
    useOptionalFeatureFlags: flags,
    useFeatureFlagsReady: () => true,
  };
});
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsProviderModule>()),
  useBrowsingSettings: (select: (s: Record<string, unknown>) => unknown) =>
    select({
      showNsfw: false,
      browsingLevel: 1,
      blurNsfw: true,
      allowAds: false,
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
  const q = (data: () => unknown) => ({
    useQuery: () => ({ data: data(), isLoading: false, isSuccess: true }),
  });
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'model.getById': q(() => F.MODEL),
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
    }),
  };
});

function stub(name: string, height = 0) {
  function Stub() {
    return <div data-stub={name} style={{ height }} />;
  }
  Stub.displayName = `Stub(${name})`;
  return Stub;
}
// `importOriginal` keeps every other export real, so nothing the page imports alongside is undefined.
vi.mock('~/components/Model/ModelCarousel/ModelCarousel', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ModelCarousel: stub('carousel', 400),
}));
vi.mock('~/components/Model/Discussion/ModelDiscussion', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ModelDiscussion: stub('discussion'),
}));
vi.mock('~/components/Model/Gallery/ModelGallery', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ModelGallery: stub('gallery'),
}));
vi.mock('~/components/AssociatedModels/AssociatedModels', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  AssociatedModels: stub('associated'),
}));
vi.mock('~/components/Ads/AdUnit', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  AdUnitSide_1: stub('ad'),
  AdUnitSide_2: stub('ad'),
  AdUnitTop: stub('ad'),
}));
vi.mock('~/components/Ads/AdUnitOutstream', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  RenderAdUnitOutstream: stub('ad'),
}));
vi.mock('~/components/AppBlocks/BlockSlot', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  BlockSlot: stub('block-slot'),
}));

const { default: ModelPage } = await import('~/pages/models/[id]/[[...slug]]');
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
const { TrainedWords } = await import('~/components/TrainedWords/TrainedWords');

const DESKTOP: Viewport = { width: 1280, height: 900 };
const PHONE: Viewport = { width: 390, height: 844 };

const headManager = { mountedInstances: new Set(), updateHead: () => undefined };

function Page() {
  const layers: Array<[unknown, Record<string, unknown> | null]> = [
    [HeadManagerContext.Provider, { value: headManager }],
    [ThemeProvider, { colorScheme: state.scheme }],
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
        isAuthed: false,
      },
    ],
    [IsClientProvider, null],
    [HiddenPreferencesProvider, null],
    [BrowserRouterProvider, null],
    [ContainerProvider, { containerName: 'main', id: 'main' }],
    [IntersectionObserverProvider, null],
  ];
  const page = layers.reduceRight<ReactNode>(
    (child, [Component, props]) => createElement(Component as never, props, child),
    createElement(ModelPage as never, { id: F.MODEL_ID })
  );
  return (
    <>
      <div data-page-under-test>{page}</div>
      <div
        data-pointer-park
        style={{ position: 'fixed', top: 0, left: 0, width: 4, height: 4, zIndex: 10000 }}
      />
    </>
  );
}

async function parkPointer() {
  const park = document.querySelector<HTMLElement>('[data-pointer-park]');
  if (!park) throw new Error('pointer park missing');
  await userEvent.hover(park);
  await nextLayout();
}

function region(): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    '[data-page-under-test] [data-tour="model:start"]'
  );
  if (!el) throw new Error('model page did not render');
  return el;
}

async function renderPage({
  ds,
  scheme,
  viewport,
}: {
  ds: boolean;
  scheme: Scheme;
  viewport: Viewport;
}) {
  state.ds = ds;
  state.scheme = scheme;
  // Both Mantine providers (the harness's and the page's) read the scheme from this key on mount,
  // so the JS colour scheme the page branches on and the attribute the CSS reads agree.
  localStorage.setItem('mantine-color-scheme-value', scheme);
  await renderAtViewport(<Page />, viewport);
  document.documentElement.setAttribute('data-mantine-color-scheme', scheme);
  await nextLayout();
  if (document.documentElement.getAttribute('data-mantine-color-scheme') !== scheme)
    throw new Error(`colour scheme did not stick at ${scheme}`);
  await parkPointer();
}

const SELECTOR = [
  'h1',
  'a',
  'button',
  'code',
  'p',
  '[role="separator"]',
  '.mantine-Badge-root',
  '[data-civitai-ui="badge"]',
  '.mantine-Card-root',
  '.mantine-Accordion-item',
  '.mantine-ScrollArea-root',
].join(', ');

function measured(): HTMLElement[] {
  return [...region().querySelectorAll<HTMLElement>(SELECTOR)].filter(
    (el) => !el.closest('[data-stub]') && el.getClientRects().length > 0
  );
}

/**
 * Compared on each element's ROOT. Not compared: `display` (Mantine's full-width button is `block`,
 * the design-system one `inline-flex`; where the content lands is what `ink` measures) and
 * `white-space`/`text-align` (Mantine sets them on the label span inside, the markup here on the
 * root).
 */
const STYLE_PROPS = [
  'box-sizing',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-left',
  'font-size',
  'font-weight',
  'font-family',
  'line-height',
  'letter-spacing',
  'text-transform',
  'color',
  'background-color',
  'background-image',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-top-color',
  'border-left-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'cursor',
  'text-decoration-line',
  'user-select',
  'overflow-x',
  'opacity',
  'transform',
] as const;

const r1 = (n: number) => Math.round(n * 10) / 10;
const rect = (r: DOMRect) => ({ x: r1(r.x), y: r1(r.y), w: r1(r.width), h: r1(r.height) });

/** The union of an element's text runs and icons, relative to its box. */
function inkRect(el: HTMLElement): DOMRect | null {
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n.textContent ?? '').trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    rects.push(range.getBoundingClientRect());
  }
  el.querySelectorAll('svg').forEach((svg) => rects.push(svg.getBoundingClientRect()));
  const real = rects.filter((r) => r.width > 0 && r.height > 0);
  if (!real.length) return null;
  const left = Math.min(...real.map((r) => r.left));
  const top = Math.min(...real.map((r) => r.top));
  return new DOMRect(
    left,
    top,
    Math.max(...real.map((r) => r.right)) - left,
    Math.max(...real.map((r) => r.bottom)) - top
  );
}

function describeEl(el: HTMLElement) {
  return `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}" ${
    el.getAttribute('aria-label') ?? ''
  }`;
}

function look(el: HTMLElement) {
  const s = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  const ink = inkRect(el);
  return {
    what: describeEl(el),
    box: rect(box),
    ink: ink ? rect(new DOMRect(ink.x - box.x, ink.y - box.y, ink.width, ink.height)) : null,
    style: Object.fromEntries(STYLE_PROPS.map((p) => [p, s.getPropertyValue(p)])),
  };
}

function capture() {
  const els = measured();
  return {
    looks: els.map(look),
    dsRoots: region().querySelectorAll('[data-civitai-ui]').length,
    mantineRoots: region().querySelectorAll('[class*="mantine-"][class*="-root"]').length,
  };
}

/** Hover and keyboard focus, as the user sees them. */
async function interactive(el: HTMLElement) {
  await userEvent.hover(el);
  await nextLayout();
  const hovered = getComputedStyle(el);
  const hover = {
    bg: hovered.backgroundColor,
    color: hovered.color,
    border: hovered.borderTopColor,
  };
  await parkPointer();
  el.focus({ focusVisible: true, preventScroll: true } as FocusOptions);
  await nextLayout();
  const focused = getComputedStyle(el);
  const focus = {
    outlineStyle: focused.outlineStyle,
    outlineWidth: focused.outlineWidth,
    outlineColor: focused.outlineColor,
    outlineOffset: focused.outlineOffset,
  };
  el.blur();
  return { hover, focus };
}

function representatives(): HTMLElement[] {
  const root = region();
  const pick = (sel: string, match?: (el: HTMLElement) => boolean) => {
    const el = [...root.querySelectorAll<HTMLElement>(sel)].find((e) => !match || match(e));
    if (!el) throw new Error(`representative ${sel} not rendered`);
    return el;
  };
  const byText = (t: string) => (el: HTMLElement) => (el.textContent ?? '').trim() === t;
  return [
    pick('button', byText('v2.0')), // inactive version: filled gray (dark) / light gray (light)
    pick('button', byText('v3.0')), // active version: filled blue
    pick('button[aria-label="Share"]'), // action row: filled gray, full width
    pick('a[href="/tag/lighting"]'), // tag badge link
    pick('button', byText('+ 1')), // tag overflow toggle
  ];
}

beforeEach(() => {
  state.ds = false;
});

afterEach(() => {
  localStorage.removeItem('mantine-color-scheme-value');
  document.documentElement.setAttribute('data-mantine-color-scheme', 'light');
});

describe('model page design-system markup: the cascade under it is the real one', () => {
  test('the app cascade, including the design-system layer, is loaded', async () => {
    await renderPage({ ds: true, scheme: 'dark', viewport: DESKTOP });
    const evidence = cascadeEvidence();
    expect(evidence.tailwindFlexUtilityResolves).toBe(true);
    expect(evidence.layerOrder.declaredOrder).toEqual([
      'tailwind-preflight',
      'theme',
      'mantine',
      'civitai.components',
      'modules',
    ]);
    // `inline-flex` on a button comes only from `[data-civitai-ui='button']`.
    const share = region().querySelector<HTMLElement>('button[aria-label="Share"]');
    expect(share?.getAttribute('data-civitai-ui')).toBe('button');
    expect(getComputedStyle(share as HTMLElement).display).toBe('inline-flex');
  });
});

describe('model page design-system markup: flag ON matches flag OFF', () => {
  const MATRIX = [
    ['light', DESKTOP],
    ['dark', DESKTOP],
    ['light', PHONE],
    ['dark', PHONE],
  ] as const;

  test.each(MATRIX)('%s at %o: every element looks and behaves identically', async (scheme, vp) => {
    await renderPage({ ds: false, scheme, viewport: vp });
    const off = capture();
    const offStates = [];
    for (const el of representatives()) offStates.push(await interactive(el));
    await cleanup();

    await renderPage({ ds: true, scheme, viewport: vp });
    const on = capture();
    const onStates = [];
    for (const el of representatives()) onStates.push(await interactive(el));

    // Premises: OFF is the Mantine page, ON the design-system page.
    expect(off.dsRoots).toBe(0);
    expect(on.dsRoots).toBeGreaterThan(30);
    expect(on.mantineRoots).toBeLessThan(off.mantineRoots);
    expect(off.looks.length).toBeGreaterThan(40);

    expect(on.looks.map((l) => l.what)).toEqual(off.looks.map((l) => l.what));
    on.looks.forEach((l, i) => {
      expect(l, l.what).toEqual(off.looks[i]);
    });
    expect(onStates).toEqual(offStates);
  });

  test('the colour scheme really changes what is compared (control for the dark rows)', async () => {
    await renderPage({ ds: true, scheme: 'light', viewport: DESKTOP });
    const light = look(
      region().querySelector<HTMLElement>('a[href="/tag/lighting"]') as HTMLElement
    );
    await cleanup();
    await renderPage({ ds: true, scheme: 'dark', viewport: DESKTOP });
    const dark = look(
      region().querySelector<HTMLElement>('a[href="/tag/lighting"]') as HTMLElement
    );
    expect(light.style['background-color']).not.toBe(dark.style['background-color']);
  });

  test('hover is observable in this harness (control for the hover comparison)', async () => {
    await renderPage({ ds: true, scheme: 'dark', viewport: DESKTOP });
    const v2 = [...region().querySelectorAll<HTMLElement>('button')].find(
      (b) => (b.textContent ?? '').trim() === 'v2.0'
    ) as HTMLElement;
    const before = getComputedStyle(v2).backgroundColor;
    const { hover } = await interactive(v2);
    expect(hover.bg).not.toBe(before);
  });
});

/** The open tooltip's bubble, wherever its implementation put it. */
async function openBubble(): Promise<HTMLElement> {
  let bubble: HTMLElement | null = null;
  await expect
    .poll(() => {
      bubble = document.querySelector<HTMLElement>('[role="tooltip"]');
      return bubble ? getComputedStyle(bubble).opacity : null;
    })
    .toBe('1');
  await nextLayout();
  return bubble as unknown as HTMLElement;
}

function bubbleLook(bubble: HTMLElement, target: HTMLElement) {
  const b = bubble.getBoundingClientRect();
  const t = target.getBoundingClientRect();
  const s = getComputedStyle(bubble);
  return {
    text: (bubble.textContent ?? '').trim(),
    centerOffset: Math.round(b.left + b.width / 2 - (t.left + t.width / 2)),
    gapAbove: Math.round(t.top - b.bottom),
    w: Math.round(b.width),
    h: Math.round(b.height),
    bg: s.backgroundColor,
    color: s.color,
    fontSize: s.fontSize,
    padding: s.padding,
    radius: s.borderTopLeftRadius,
  };
}

describe('model page design-system markup: tooltips', () => {
  test.each(['light', 'dark'] as const)(
    '%s: the action-row tooltip looks and sits where Mantine puts it, unclipped',
    async (scheme) => {
      await renderPage({ ds: false, scheme, viewport: DESKTOP });
      let target = region().querySelector<HTMLElement>('button[aria-label="Share"]')
        ?.parentElement as HTMLElement;
      await userEvent.hover(target);
      const off = bubbleLook(await openBubble(), target);
      await parkPointer();
      await cleanup();

      await renderPage({ ds: true, scheme, viewport: DESKTOP });
      target = region().querySelector<HTMLElement>('button[aria-label="Share"]')
        ?.parentElement as HTMLElement;
      await userEvent.hover(target);
      const bubble = await openBubble();
      const on = bubbleLook(bubble, target);

      expect(off.text).toBe('Share');
      expect(on).toEqual(off);
      // Outside every `overflow: hidden` ancestor of the trigger.
      expect(bubble.parentElement).toBe(document.body);
      expect(getComputedStyle(bubble).position).toBe('fixed');
      await parkPointer();
      await expect.poll(() => document.querySelector('[role="tooltip"]')).toBeNull();
    }
  );

  test('a trigger word shows "Copied!" while copied, and not on hover', async () => {
    await renderPage({ ds: true, scheme: 'dark', viewport: DESKTOP });
    const word = [...region().querySelectorAll<HTMLElement>('[data-civitai-ui="badge"]')].find(
      (b) => (b.textContent ?? '').trim() === 'lanternglow'
    ) as HTMLElement;
    await userEvent.hover(word);
    await nextLayout();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await userEvent.click(word);
    const bubble = await openBubble();
    expect((bubble.textContent ?? '').trim()).toBe('Copied!');
  });
});

describe('model page design-system markup: shared components elsewhere', () => {
  // Invariant guard: TrainedWords is also rendered by the generator, without `ds`.
  test('TrainedWords without `ds` is the Mantine component', async () => {
    await renderAtViewport(
      <TrainedWords trainedWords={['alpha', 'beta']} type={'LORA' as never} />,
      DESKTOP
    );
    expect(document.querySelectorAll('[data-civitai-ui]')).toHaveLength(0);
    expect(document.querySelectorAll('.mantine-Badge-root')).toHaveLength(2);
  });
});
