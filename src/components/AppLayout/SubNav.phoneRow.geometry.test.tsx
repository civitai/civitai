/**
 * ON A PHONE THE FEED FILTERS AND THE GEAR SHARE THE ROW UNDER THE TABS — MEASURED IN PIXELS.
 *
 * The tabs row is a horizontal scroller and needs all the width it can get, so the gear must not
 * sit beside it or alone on a third line. Every feed with filters puts the gear on the filter row;
 * the filter group has to shrink to make room (its buttons truncate their labels) instead of
 * pushing the gear off the screen. Signed in, the images feed has the widest group: "Everyone",
 * the sort and "Filters".
 *
 * Renders the real `SubNav2` with the real filter components at an explicit viewport, against the
 * real cascade (see `test/geometry-setup.tsx` for why this is not a `component` test: Tailwind is
 * not loaded there, so every utility class would be inert and the assertions would pass vacuously).
 */
import { MantineProvider } from '@mantine/core';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { cascadeEvidence, nextLayout, renderAtViewport } from '../../../test/geometry-setup';
import Router from 'next/router';
import { IsClientProvider } from '~/providers/IsClientProvider';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import type * as TrpcModule from '~/utils/trpc';

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useFeatureFlags: () => ({
    articles: true,
    bounties: true,
    comicCreator: true,
    challengePlatform: true,
    crucible: true,
    cosmeticShop: true,
    model3dFeed: true,
    userHubs: true,
    auctions: true,
    vault: true,
    canViewNsfw: true,
    isGreen: false,
    imageSearch: true,
  }),
}));
// A signed-in viewer who sees mature content, the widest the filters get.
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useBrowsingSettings: (select: (state: Record<string, unknown>) => unknown) =>
    select({ showNsfw: true, browsingLevel: 31, blurNsfw: false }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'tester' }),
}));
vi.mock('~/components/UserSettings/hooks', () => ({ useCurrentUserSettings: () => ({}) }));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  // Any procedure or util the filters reach for answers "loading, no data".
  const idle = { data: undefined, isLoading: false, isFetching: false };
  const anything = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) =>
        key === 'useQuery' || key === 'useInfiniteQuery' ? () => idle : anything(),
      apply: () => anything(),
    });
  return {
    ...actual,
    trpc: new Proxy(
      { changelog: { getLatest: { useQuery: () => ({ data: 0 }) } } },
      { get: (target, key) => (target as never)[key] ?? anything() }
    ),
  };
});

const { SubNav2 } = await import('./SubNav');
const { FiltersProvider } = await import('~/providers/FiltersProvider');

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden">
      <ContainerProvider containerName="main">
        <MantineProvider
          theme={{ components: { Popover: { defaultProps: { withinPortal: false } } } }}
        >
          <IsClientProvider>
            <FiltersProvider>{children}</FiltersProvider>
          </IsClientProvider>
        </MantineProvider>
      </ContainerProvider>
    </div>
  );
}

// The harness's `next/router` mock hands every caller one shared router object.
const setRoute = (pathname: string) => {
  (Router as { pathname: string }).pathname = pathname;
};

const gear = () => document.querySelector<HTMLElement>('[aria-label="Customize navigation"]');

/** The row that holds the gear: its parent when the filters and gear are wrapped together. */
function rows() {
  const g = gear();
  if (!g) throw new Error('gear not rendered');
  const wrapper = g.parentElement!;
  const filterGroup = wrapper.firstElementChild as HTMLElement;
  return { g, wrapper, filterGroup };
}

const PHONES = [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
] as const;

const FEEDS = [
  '/images',
  '/models',
  '/videos',
  '/3d-models',
  '/posts',
  '/articles',
  '/bounties',
  '/tools',
  '/tools/[slug]',
  '/comics',
  // The app store's filters live on the store (`/apps/store`); `/apps` is the viewer's app home.
  '/apps/store',
  '/storylines',
] as const;

describe('sub nav phone row', () => {
  test('the real cascade is loaded — without this every assertion below is vacuous', async () => {
    setRoute('/images');
    await renderAtViewport(
      <Shell>
        <SubNav2 />
      </Shell>,
      { width: 390, height: 844 }
    );
    expect(cascadeEvidence().tailwindFlexUtilityResolves).toBe(true);
  });

  for (const viewport of PHONES) {
    for (const path of FEEDS) {
      test(`${path} at ${viewport.width}px: the gear sits on the filter row inside the viewport`, async () => {
        setRoute(path);
        await renderAtViewport(
          <Shell>
            <SubNav2 />
          </Shell>,
          viewport
        );
        await nextLayout();
        const { g, wrapper, filterGroup } = rows();
        const gearBox = g.getBoundingClientRect();
        const groupBox = filterGroup.getBoundingClientRect();
        const tabs = document
          .querySelector('a[href="/models"]')!
          .parentElement!.getBoundingClientRect();

        // On the screen, and a real tap target.
        expect(gearBox.right).toBeLessThanOrEqual(viewport.width);
        expect(gearBox.width).toBeGreaterThanOrEqual(32);
        // On the filter row: level with the group, to its right, below the tabs.
        expect(gearBox.top).toBeGreaterThanOrEqual(groupBox.top - 1);
        expect(gearBox.bottom).toBeLessThanOrEqual(groupBox.bottom + 1);
        expect(gearBox.left).toBeGreaterThanOrEqual(groupBox.right - 1);
        expect(groupBox.top).toBeGreaterThanOrEqual(tabs.bottom);
        // The tabs row keeps the whole width to scroll in.
        expect(tabs.right).toBeGreaterThanOrEqual(viewport.width - 16);
        // Every control in the filter group is still a tap target and still on screen.
        const buttons = [...filterGroup.querySelectorAll<HTMLElement>('button')];
        expect(buttons.length).toBeGreaterThan(0);
        for (const button of buttons) {
          const box = button.getBoundingClientRect();
          // Not under the gear either: the group's own box can end early while a child overflows it.
          expect(box.right, button.textContent ?? '').toBeLessThanOrEqual(gearBox.left + 1);
          expect(box.width, button.textContent ?? '').toBeGreaterThanOrEqual(32);
        }
        // The audience button ("Everyone") keeps only its icon below 390px; the name stays for
        // screen readers (the text is visually hidden, not removed) and for hover (`title`).
        const audience = filterGroup.querySelector<HTMLElement>('button[data-collapse-label]');
        if (audience) {
          const label = audience.querySelector('span')!.getBoundingClientRect();
          expect(audience.getAttribute('title')).toBeTruthy();
          expect(audience.textContent).toBeTruthy();
          if (viewport.width < 390) expect(label.width).toBeLessThanOrEqual(1);
          else expect(label.width).toBeGreaterThan(20);
        }
        // Every other label is shown in full, at 360px as well as 390px.
        for (const button of buttons.filter((b) => b !== audience)) {
          const clipped = [button, ...button.querySelectorAll('*')].some(
            (el) => el.scrollWidth > el.clientWidth + 1
          );
          expect(clipped, `${button.textContent} is clipped`).toBe(false);
        }
        expect(wrapper.scrollWidth).toBeLessThanOrEqual(wrapper.clientWidth + 1);
      });
    }
  }

  test('the hub pages hide their filters on phones and the gear stays at the right edge', async () => {
    setRoute('/hubs/[id]/[[...slug]]');
    await renderAtViewport(
      <Shell>
        <SubNav2 />
      </Shell>,
      { width: 390, height: 844 }
    );
    await nextLayout();
    const { g, filterGroup } = rows();
    expect(getComputedStyle(filterGroup).display).toBe('none');
    const box = g.getBoundingClientRect();
    expect(box.right).toBeLessThanOrEqual(390);
    expect(box.left).toBeGreaterThan(390 / 2);
  });
});
