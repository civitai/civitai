// The tile's layout (grid columns, one-line truncation) comes from Mantine's stylesheet, which
// the shared scaffold omits; without it every geometry assertion below measures nothing.
// Browser mode gives each file its own iframe, so this does not leak into sibling suites.
import '@mantine/core/styles.css';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as TrpcMod from '~/utils/trpc';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';
import type { MyAppRow } from '~/server/services/blocks/my-apps.logic';

/**
 * `/apps` — the "My apps" home body. What a viewer would notice broken: a tile that does not
 * launch where it says (in-site vs a new tab), a menu link into the wrong page, an empty state
 * with no way to the store.
 */

const mocks = vi.hoisted(() => ({
  myApps: { data: undefined as unknown, isLoading: false, isError: false },
  listAvailableItems: [] as unknown[],
  listAvailableInputs: [] as Record<string, unknown>[],
  flags: {} as Record<string, boolean>,
  user: { id: 41, username: 'viewer' } as { id: number; username: string } | null,
  detailIcons: {} as Record<string, string>,
  hide: vi.fn(),
  unhide: vi.fn(),
  /** `utils.appListings.listMyApps.invalidate` — the home's ONLY list refetch. */
  invalidate: vi.fn(),
  /** Re-render every mounted `listMyApps` reader (a refetch landing). */
  listeners: new Set<() => void>(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const React = await import('react');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'appListings.listMyApps': {
          useQuery: () => {
            const [, rerender] = React.useReducer((n: number) => n + 1, 0);
            React.useEffect(() => {
              mocks.listeners.add(rerender);
              return () => {
                mocks.listeners.delete(rerender);
              };
            }, []);
            return { ...mocks.myApps, refetch: vi.fn() };
          },
        },
        // Delegating, so a test can swap the spy mid-render without waiting for a re-render.
        'appListings.hideMyApp': {
          useMutation: () => ({ mutateAsync: (i: { slug: string }) => mocks.hide(i) }),
        },
        'appListings.unhideMyApp': {
          useMutation: () => ({ mutateAsync: (i: { slug: string }) => mocks.unhide(i) }),
        },
        // The live icon read a recents-only tile makes (the chrome's `useChromeListingDetail`).
        'appListings.getAppDetail': {
          useQuery: (input: { slug: string }) => ({
            data: mocks.detailIcons[input.slug]
              ? { iconUrl: mocks.detailIcons[input.slug] }
              : undefined,
            isLoading: false,
            error: null,
          }),
        },
        // The home makes NO store list read; this stub records any call so a test can say so.
        'appListings.listAvailable': {
          useQuery: (input: Record<string, unknown>) => {
            mocks.listAvailableInputs.push(input);
            return { data: { items: mocks.listAvailableItems }, isPending: false };
          },
        },
      },
      {
        // A STABLE spy (the proxy's default mints a fresh one per read, so it can never be
        // asserted on); it defers to `mocks.invalidate` so each test can swap the behaviour.
        useUtils: () => ({
          appListings: { listMyApps: { invalidate: () => mocks.invalidate() } },
        }),
      }
    ),
  };
});
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => mocks.flags,
  useOptionalFeatureFlags: () => mocks.flags,
}));

const { AppsHomeBody } = await import('./AppsHomeBody');
const { clearRecentlyOpenedApps, recordRecentlyOpenedApp } = await import(
  './recentlyOpenedAppsStore'
);

const PAGE_APP: MyAppRow = {
  listingId: 'apl_page1',
  slug: 'pixel-forge',
  name: 'Pixel Forge',
  category: null,
  iconUrl: null,
  coverUrl: null,
  kind: 'page',
  launchHref: '/apps/run/pixel-forge',
  external: false,
  lastUsedAt: new Date('2026-10-20T00:00:00.000Z'),
};
const OFFSITE_APP: MyAppRow = {
  listingId: 'apl_off1',
  slug: 'prompt-lab',
  name: 'Prompt Lab',
  category: null,
  iconUrl: null,
  coverUrl: null,
  kind: 'offsite',
  launchHref: 'https://promptlab.example.org/app',
  external: true,
  lastUsedAt: new Date('2026-10-10T00:00:00.000Z'),
};

/** A third app the server holds but cuts off below the cap until a slot frees up. */
const THIRD_APP: MyAppRow = {
  ...PAGE_APP,
  listingId: 'apl_page3',
  slug: 'third-app',
  name: 'Third App',
  launchHref: '/apps/run/third-app',
  lastUsedAt: new Date('2026-10-01T00:00:00.000Z'),
};

function listingCard(id: string, name: string): ListingCard {
  return {
    id,
    slug: `slug-${id}`,
    kind: 'onsite',
    name,
    tagline: null,
    category: 'generation',
    contentRating: null,
    isBeta: false,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    openCount: 0,
    restrictedAudience: null,
    kindData: {
      kind: 'onsite',
      appBlockId: `ab_${id}`,
      hasPage: true,
      liveUrl: 'https://x.civit.ai',
    },
  };
}

/** The launch anchor of the tile whose name is `name`. */
function launch(name: string): HTMLAnchorElement {
  const tile = Array.from(document.querySelectorAll('[data-testid="apps-home-tile"]')).find((t) =>
    (t.textContent ?? '').includes(name)
  );
  expect(tile, `no tile named ${name}`).toBeTruthy();
  return tile!.querySelector('[data-testid="apps-home-tile-launch"]') as HTMLAnchorElement;
}

/** The `listMyApps` payload: the derived apps plus the viewer's hides. */
const served = (apps: MyAppRow[], hidden: Record<string, string> = {}, removedCount = 0) => ({
  apps,
  hidden,
  removedCount,
});

beforeEach(() => {
  mocks.myApps = { data: served([PAGE_APP, OFFSITE_APP]), isLoading: false, isError: false };
  mocks.hide = vi.fn(async (input: { slug: string }) => ({
    slug: input.slug,
    hiddenAt: new Date().toISOString(),
  }));
  mocks.unhide = vi.fn(async (input: { slug: string }) => ({ slug: input.slug }));
  mocks.invalidate = vi.fn(async () => undefined);
  mocks.listAvailableItems = [];
  mocks.listAvailableInputs = [];
  mocks.flags = { appBlocks: true, appBlocksPages: true, appListings: true };
  mocks.user = { id: 41, username: 'viewer' };
  mocks.detailIcons = {};
  clearRecentlyOpenedApps();
});

describe('the My apps grid', () => {
  test('🔴 a page app launches IN-SITE; an off-site app opens in a NEW TAB with noopener', async () => {
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge')).toBeVisible();
    await expect.element(page.getByText('Prompt Lab')).toBeVisible();

    const pageLaunch = launch('Pixel Forge');
    // `?from=home` is the run chrome's "came from My apps" signal (its breadcrumb then reads
    // "My apps" → /apps).
    expect(pageLaunch.getAttribute('href')).toBe('/apps/run/pixel-forge?from=home');
    expect(pageLaunch.getAttribute('target')).toBeNull();

    const offLaunch = launch('Prompt Lab');
    expect(offLaunch.getAttribute('href')).toBe('https://promptlab.example.org/app');
    expect(offLaunch.getAttribute('target')).toBe('_blank');
    expect(offLaunch.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('renders one tile per app, in the order the server sent', async () => {
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge')).toBeVisible();
    const tiles = page.getByTestId('apps-home-tile').elements();
    expect(tiles).toHaveLength(2);
    expect(tiles[0].textContent).toContain('Pixel Forge');
    expect(tiles[1].textContent).toContain('Prompt Lab');
  });

  test('the header offers the store at /apps/store', async () => {
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByRole('heading', { name: 'My apps' })).toBeVisible();
    expect(page.getByTestId('apps-home-browse').element().getAttribute('href')).toBe('/apps/store');
  });

  test('the tile menu links to the permissions tab and to the store page', async () => {
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge')).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'More options for Pixel Forge' }));

    const perms = page.getByRole('menuitem', { name: 'Manage permissions' });
    await expect.element(perms).toBeVisible();
    expect(perms.element().getAttribute('href')).toBe('/apps/activity?tab=permissions');
    expect(
      page.getByRole('menuitem', { name: 'View in store' }).element().getAttribute('href')
    ).toBe('/apps/store-preview/pixel-forge');
  });

  test('"Manage permissions" is withheld where the permissions tab would not render', async () => {
    // `appBlocks` is the slot flag the Activity page's permissions tab is gated on.
    mocks.flags = { appBlocksPages: true, appListings: true };
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge')).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'More options for Pixel Forge' }));
    // Positive control: the menu is open.
    await expect.element(page.getByRole('menuitem', { name: 'View in store' })).toBeVisible();
    expect(page.getByRole('menuitem', { name: 'Manage permissions' }).elements()).toHaveLength(0);
  });
});

describe('the empty state', () => {
  test('🔴 no apps → friendly copy and a store CTA to /apps/store, and NO popular strip or store read', async () => {
    mocks.myApps = { data: served([]), isLoading: false, isError: false };
    // Seeded so a store read, if one were made, WOULD have cards to render: the absence
    // assertions below then observe the strip's removal, not an empty response.
    mocks.listAvailableItems = [listingCard('p1', 'Neon Sketch'), listingCard('p2', 'Tag Wizard')];
    renderWithProviders(<AppsHomeBody />);

    await expect.element(page.getByTestId('apps-home-empty')).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'No apps yet' })).toBeVisible();
    await expect
      .element(page.getByText('Apps you open, connect or buy show up here', { exact: false }))
      .toBeVisible();
    const cta = page.getByTestId('apps-home-empty-browse');
    await expect.element(cta).toHaveTextContent('Browse the store');
    expect(cta.element().getAttribute('href')).toBe('/apps/store');

    // The "Popular apps" strip and its second `listAvailable` read are gone.
    expect(page.getByTestId('apps-home-popular').elements()).toHaveLength(0);
    expect(page.getByRole('heading', { name: 'Popular apps' }).elements()).toHaveLength(0);
    expect(page.getByText('Neon Sketch').elements()).toHaveLength(0);
    expect(mocks.listAvailableInputs).toHaveLength(0);
    expect(page.getByTestId('apps-home-tile').elements()).toHaveLength(0);
  });

  test('with apps, there is no empty state', async () => {
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge')).toBeVisible();
    expect(page.getByTestId('apps-home-empty').elements()).toHaveLength(0);
  });
});

describe('loading', () => {
  test('shows the skeleton grid while the list loads', async () => {
    mocks.myApps = { data: undefined, isLoading: true, isError: false };
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByTestId('apps-home-skeleton')).toBeInTheDocument();
    expect(page.getByTestId('apps-home-tile').elements()).toHaveLength(0);
  });
});

describe('recents on the home', () => {
  /** Which of `names` each tile shows, in DOM order. */
  const tileOrder = (names: string[]) =>
    page
      .getByTestId('apps-home-tile')
      .elements()
      .map((t) => names.find((n) => (t.textContent ?? '').includes(n)) ?? '?');

  test('🔴 this account’s recents lead the grid, deduped against the server list', async () => {
    // Recorded oldest-first, so the store holds [Prompt Lab, Neon Sketch] newest-first.
    recordRecentlyOpenedApp(
      {
        id: 'ab_neon',
        slug: 'neon-sketch',
        blockId: 'neon-sketch',
        kind: 'onsite',
        hasPage: true,
        name: 'Neon Sketch',
      },
      41
    );
    recordRecentlyOpenedApp(
      {
        id: 'apl_off1',
        slug: 'prompt-lab',
        kind: 'offsite',
        name: 'Prompt Lab',
        externalUrl: 'https://promptlab.example.org/app',
      },
      41
    );
    mocks.detailIcons = { 'neon-sketch': 'https://img.invalid/neon.png' };
    renderWithProviders(<AppsHomeBody />);

    await expect.element(page.getByText('Neon Sketch')).toBeVisible();
    // Prompt Lab is BOTH a recent and a server row → one tile, placed by recents order;
    // Pixel Forge (server only) follows.
    expect(tileOrder(['Prompt Lab', 'Neon Sketch', 'Pixel Forge'])).toEqual([
      'Prompt Lab',
      'Neon Sketch',
      'Pixel Forge',
    ]);
    // The recents-only tile launches from its stored fields and resolves its icon LIVE.
    expect(launch('Neon Sketch').getAttribute('href')).toBe('/apps/run/neon-sketch?from=home');
    const neonTile = launch('Neon Sketch').closest('[data-testid="apps-home-tile"]')!;
    expect(neonTile.getAttribute('data-source')).toBe('recent');
    expect(
      neonTile.querySelector('[data-testid="apps-home-tile-icon"]')?.getAttribute('data-icon-src')
    ).toBe('https://img.invalid/neon.png');
  });

  test('🔴 another account’s recents never appear', async () => {
    recordRecentlyOpenedApp(
      {
        id: 'ab_neon',
        slug: 'neon-sketch',
        blockId: 'neon-sketch',
        kind: 'onsite',
        hasPage: true,
        name: 'Neon Sketch',
      },
      73
    );
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge')).toBeVisible();
    expect(page.getByText('Neon Sketch').elements()).toHaveLength(0);
  });

  test('🔴 recents alone keep the home out of its empty state', async () => {
    mocks.myApps = { data: served([]), isLoading: false, isError: false };
    recordRecentlyOpenedApp(
      {
        id: 'ab_neon',
        slug: 'neon-sketch',
        blockId: 'neon-sketch',
        kind: 'onsite',
        hasPage: true,
        name: 'Neon Sketch',
      },
      41
    );
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Neon Sketch')).toBeVisible();
    expect(page.getByTestId('apps-home-empty').elements()).toHaveLength(0);
  });
});

describe('the launcher tile', () => {
  test('🔴 icon + one-line name; the full name is the hover title and in the accessible name', async () => {
    const LONG = 'Pixel Forge Ultra Deluxe Background Remover And Upscaler Studio';
    mocks.myApps = {
      data: served([{ ...PAGE_APP, name: LONG }]),
      isLoading: false,
      isError: false,
    };
    renderWithProviders(<AppsHomeBody />);
    const link = page.getByRole('link', { name: `Open ${LONG}` });
    await expect.element(link).toBeVisible();
    const a = link.element() as HTMLAnchorElement;
    expect(a.getAttribute('title')).toBe(LONG);
    // The icon (letter avatar here: no icon url) is inside the launch link.
    const icon = a.querySelector('[data-testid="apps-home-tile-icon"]') as HTMLElement;
    expect(icon).toBeTruthy();
    expect(icon.textContent).toBe('P');
    // The name renders as ONE line, ellipsised, not wrapped and not overflowing its tile.
    const name = a.querySelector('[data-testid="apps-home-tile-name"]') as HTMLElement;
    const css = getComputedStyle(name);
    expect(css.whiteSpace).toBe('nowrap');
    expect(css.textOverflow).toBe('ellipsis');
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth); // it IS truncated
    const tile = a.closest('[data-testid="apps-home-tile"]') as HTMLElement;
    expect(name.getBoundingClientRect().right).toBeLessThanOrEqual(
      tile.getBoundingClientRect().right + 0.5
    );
  });

  test('🔴 an off-site tile opens a new tab with noopener noreferrer, and says so to AT', async () => {
    renderWithProviders(<AppsHomeBody />);
    const link = page.getByRole('link', { name: 'Open Prompt Lab (opens in a new tab)' });
    await expect.element(link).toBeVisible();
    const a = link.element() as HTMLAnchorElement;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.getAttribute('title')).toBe('Prompt Lab');
    expect(a.querySelector('[data-testid="apps-home-tile-external"]')).toBeTruthy();
  });

  test('🔴 at 390px: 4 columns, every tile inside the viewport, no horizontal scroll', async () => {
    await page.viewport(390, 844);
    try {
      await assertPhoneGrid();
    } finally {
      // Back to the harness default, so later tests are not silently at phone width.
      await page.viewport(414, 896);
    }
  });

  async function assertPhoneGrid() {
    const many = Array.from({ length: 9 }, (_, i) => ({
      ...PAGE_APP,
      listingId: `apl_${i}`,
      slug: `app-${i}`,
      name: `A rather long application name number ${i}`,
    }));
    mocks.myApps = { data: served(many), isLoading: false, isError: false };
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('A rather long application name number 8')).toBeVisible();
    const tiles = page.getByTestId('apps-home-tile').elements();
    const firstRowTop = tiles[0].getBoundingClientRect().top;
    const firstRow = tiles.filter((t) => Math.abs(t.getBoundingClientRect().top - firstRowTop) < 2);
    expect(firstRow, '390px: tiles in the first row').toHaveLength(4);
    for (const t of tiles) expect(t.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    // The ⋮ is reachable on a touch-width screen: present for every tile.
    expect(page.getByTestId('apps-home-tile-menu').elements()).toHaveLength(9);
  }

  test('the ⋮ is keyboard-reachable: Tab from the launch link lands on it', async () => {
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge')).toBeVisible();
    launch('Pixel Forge').focus();
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('More options for Pixel Forge');
  });
});

describe('the empty state after removing everything', () => {
  test('🔴 every app removed → says so (not "No apps yet") and still offers the store', async () => {
    mocks.myApps = {
      data: served([{ ...PAGE_APP, lastUsedAt: new Date('2019-12-01T00:00:00.000Z') }], {
        'pixel-forge': '2020-01-05T00:00:00.000Z',
      }),
      isLoading: false,
      isError: false,
    };
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByTestId('apps-home-empty')).toBeVisible();
    await expect
      .element(page.getByRole('heading', { name: "You've removed all your apps from this page" }))
      .toBeVisible();
    await expect.element(page.getByText('Apps you open again will come back here.')).toBeVisible();
    expect(page.getByRole('heading', { name: 'No apps yet' }).elements()).toHaveLength(0);
    expect(page.getByTestId('apps-home-empty-browse').element().getAttribute('href')).toBe(
      '/apps/store'
    );
  });

  test('🔴 the server already dropped every app (no rows, removedCount 1) → still "removed", not "No apps yet"', async () => {
    mocks.myApps = {
      data: served([], { 'pixel-forge': '2020-01-05T00:00:00.000Z' }, 1),
      isLoading: false,
      isError: false,
    };
    renderWithProviders(<AppsHomeBody />);
    await expect
      .element(page.getByRole('heading', { name: "You've removed all your apps from this page" }))
      .toBeVisible();
    expect(page.getByRole('heading', { name: 'No apps yet' }).elements()).toHaveLength(0);
  });
});

describe('Remove from My apps', () => {
  async function removeViaMenu(name: string) {
    await userEvent.click(page.getByRole('button', { name: `More options for ${name}` }));
    const item = page.getByRole('menuitem', { name: 'Remove from My apps' });
    await expect.element(item).toBeVisible();
    await userEvent.click(item);
  }

  test('🔴 the menu item calls the mutation with the slug, and the tile disappears', async () => {
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge')).toBeVisible();
    await removeViaMenu('Pixel Forge');
    await expect
      .poll(() => page.getByText('Pixel Forge', { exact: true }).elements())
      .toHaveLength(0);
    expect(mocks.hide).toHaveBeenCalledTimes(1);
    expect(mocks.hide.mock.calls[0][0]).toEqual({ slug: 'pixel-forge' });
    // The other tile stays.
    expect(page.getByTestId('apps-home-tile').elements()).toHaveLength(1);
    await expect
      .element(page.getByTestId('apps-home-removed'))
      .toHaveTextContent('Removed Pixel Forge from My apps');
  });

  test('🔴 Undo restores the tile and calls unhide for the same slug', async () => {
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge')).toBeVisible();
    await removeViaMenu('Pixel Forge');
    await expect.poll(() => page.getByTestId('apps-home-tile').elements().length).toBe(1);
    await userEvent.click(page.getByTestId('apps-home-undo'));
    await expect.poll(() => page.getByTestId('apps-home-tile').elements().length).toBe(2);
    expect(mocks.unhide).toHaveBeenCalledTimes(1);
    expect(mocks.unhide.mock.calls[0][0]).toEqual({ slug: 'pixel-forge' });
    expect(page.getByTestId('apps-home-removed').elements()).toHaveLength(0);
  });

  test('🔴 the status region is mounted while idle, so the removal is announced into it', async () => {
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge')).toBeVisible();
    const region = page.getByTestId('apps-home-removed-status');
    // Present and EMPTY before anything is removed — a live region inserted together with its
    // message is not reliably announced.
    expect(region.element().getAttribute('role')).toBe('status');
    expect(region.element().textContent).toBe('');
    const before = region.element();
    await removeViaMenu('Pixel Forge');
    await expect.element(region).toHaveTextContent('Removed Pixel Forge from My apps');
    // The SAME element carries the message (not a new region mounted with it).
    expect(region.element()).toBe(before);
    expect(region.element().contains(page.getByTestId('apps-home-removed').element())).toBe(true);
  });

  test('Undo names what it undoes', async () => {
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge')).toBeVisible();
    await removeViaMenu('Pixel Forge');
    await expect
      .element(page.getByRole('button', { name: 'Undo removing Pixel Forge' }))
      .toBeVisible();
  });

  test('🔴 Undo returns focus to the page heading, not <body>', async () => {
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge')).toBeVisible();
    await removeViaMenu('Pixel Forge');
    const undo = page.getByTestId('apps-home-undo');
    await expect.poll(() => document.activeElement).toBe(undo.element());
    await userEvent.click(undo);
    const heading = page.getByRole('heading', { name: 'My apps' }).element();
    await expect.poll(() => document.activeElement).toBe(heading);
  });

  test('Dismiss with focus inside also returns focus to the heading', async () => {
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge')).toBeVisible();
    await removeViaMenu('Pixel Forge');
    await userEvent.click(page.getByRole('button', { name: 'Dismiss' }));
    await expect.poll(() => page.getByTestId('apps-home-removed').elements().length).toBe(0);
    const heading = page.getByRole('heading', { name: 'My apps' }).element();
    await expect.poll(() => document.activeElement).toBe(heading);
  });

  describe('auto-dismiss pauses while the bar is focused or hovered', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Remove Pixel Forge and wait for the bar, with focus on its Undo (set on appear). */
    async function removeAndWaitForBar() {
      renderWithProviders(<AppsHomeBody />);
      await expect.element(page.getByText('Pixel Forge')).toBeVisible();
      await removeViaMenu('Pixel Forge');
      const undo = page.getByTestId('apps-home-undo');
      await expect.poll(() => document.activeElement).toBe(undo.element());
      // Fake timers only from here, so the menu interaction above ran on real time. Advances
      // below are far past any plausible dismiss delay, so they do not restate the constant.
      // `shouldAdvanceTime` keeps the test runner's own timers alive; it cannot dismiss a
      // paused bar, because a paused bar has no timer at all.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
      return undo;
    }
    const barCount = () => page.getByTestId('apps-home-removed').elements().length;
    /** Yield a frame (rAF is not faked) so React commits whatever the last event queued. */
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

    test('🔴 focused: the bar stays; once focus leaves it, the timer dismisses it', async () => {
      const undo = await removeAndWaitForBar();
      vi.advanceTimersByTime(60_000);
      await frame();
      expect(barCount()).toBe(1);
      (undo.element() as HTMLElement).blur();
      // The blur re-arms the timer in an effect; advance until it has fired.
      await expect
        .poll(() => {
          vi.advanceTimersByTime(60_000);
          return barCount();
        })
        .toBe(0);
    });

    test('🔴 hovered: the bar stays; leaving it lets the timer dismiss it', async () => {
      const undo = await removeAndWaitForBar();
      await userEvent.hover(page.getByTestId('apps-home-removed'));
      (undo.element() as HTMLElement).blur();
      // Let React commit the blur, then prove the hover alone holds the bar.
      await expect.poll(() => document.activeElement === undo.element()).toBe(false);
      for (let i = 0; i < 3; i++) {
        await frame();
        vi.advanceTimersByTime(60_000);
      }
      await frame();
      expect(barCount()).toBe(1);
      await userEvent.unhover(page.getByTestId('apps-home-removed'));
      await expect
        .poll(() => {
          vi.advanceTimersByTime(60_000);
          return barCount();
        })
        .toBe(0);
    });
  });

  test('🔴 a failed remove rolls back: the tile comes back', async () => {
    mocks.hide = vi.fn(async () => {
      throw new Error('nope');
    });
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge')).toBeVisible();
    await removeViaMenu('Pixel Forge');
    await expect.poll(() => mocks.hide.mock.calls.length).toBe(1);
    await expect.poll(() => page.getByTestId('apps-home-tile').elements().length).toBe(2);
    expect(page.getByTestId('apps-home-removed').elements()).toHaveLength(0);
  });

  test('🔴 an app the server reports hidden (no later use) does not render; a later open shows it', async () => {
    mocks.myApps = {
      // Both instants long before the real clock, so the open recorded below (stamped with
      // `Date.now()`) is certainly after the hide.
      data: served(
        [{ ...PAGE_APP, lastUsedAt: new Date('2019-12-01T00:00:00.000Z') }, OFFSITE_APP],
        {
          'pixel-forge': '2020-01-05T00:00:00.000Z',
        }
      ),
      isLoading: false,
      isError: false,
    };
    const { unmount } = await renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Prompt Lab')).toBeVisible();
    expect(page.getByText('Pixel Forge', { exact: true }).elements()).toHaveLength(0);
    await unmount();

    // Opening it in this browser now (after the hide) brings it back.
    recordRecentlyOpenedApp(
      {
        id: 'ab_page1',
        slug: 'pixel-forge',
        blockId: 'pixel-forge',
        kind: 'onsite',
        hasPage: true,
        name: 'Pixel Forge',
      },
      41
    );
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge', { exact: true })).toBeVisible();
  });

  /**
   * The list refetch waits for the Undo window. Each test runs against a SERVER MODEL that
   * behaves like the real `listMyApps`: a refetch (the stable `invalidate` spy) re-reads the
   * server, which DROPS hidden rows and fills the freed slot from below its cap. So a refetch
   * that fired at remove time is visible two ways: the spy's count, and the removed row
   * leaving the cache (with Third App, the next app past the cap, arriving in its place).
   */
  describe('the list refetch waits until the Undo window closes', () => {
    const CAP = 2;
    function serveFromServer(rows: MyAppRow[]) {
      const hidden: Record<string, string> = {};
      const publish = () => {
        const visible = rows.filter((r) => !(r.slug in hidden));
        mocks.myApps = {
          data: served(visible.slice(0, CAP), { ...hidden }, rows.length - visible.length),
          isLoading: false,
          isError: false,
        };
      };
      publish();
      mocks.hide = vi.fn(async ({ slug }: { slug: string }) => {
        hidden[slug] = new Date().toISOString();
        return { slug, hiddenAt: hidden[slug] };
      });
      mocks.unhide = vi.fn(async ({ slug }: { slug: string }) => {
        delete hidden[slug];
        return { slug };
      });
      mocks.invalidate = vi.fn(async () => {
        publish();
        mocks.listeners.forEach((l) => l());
      });
    }
    const names = () =>
      page
        .getByTestId('apps-home-tile-name')
        .elements()
        .map((e) => e.textContent);
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    /** Move focus off the bar (Undo takes it on appear, which pauses the timer). */
    async function blurBar() {
      (document.activeElement as HTMLElement | null)?.blur();
      await frame();
    }
    /** Advance fake time, yielding a frame each second so React commits as it goes. */
    async function advance(ms: number) {
      for (let t = 0; t < ms; t += 1000) {
        vi.advanceTimersByTime(Math.min(1000, ms - t));
        await frame();
      }
    }
    function deferred<T>() {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    beforeEach(() => {
      serveFromServer([PAGE_APP, OFFSITE_APP, THIRD_APP]);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function renderAndRemove(name: string) {
      renderWithProviders(<AppsHomeBody />);
      await expect.element(page.getByText(name)).toBeVisible();
      await removeViaMenu(name);
      await expect.poll(() => mocks.hide.mock.calls.length).toBe(1);
      await expect.poll(names).not.toContain(name);
    }
    const fakeTimers = () =>
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });

    test('🔴 remove → no listMyApps refetch while the window is open', async () => {
      await renderAndRemove('Pixel Forge');
      fakeTimers();
      await blurBar();
      // Well inside the window (real time also ticks the fake clock, so stay clear of it).
      await advance(5000);
      expect(page.getByTestId('apps-home-removed').elements()).toHaveLength(1);
      expect(mocks.invalidate).not.toHaveBeenCalled();
      // The removed row is still cached: the cap's next app has not been pulled in.
      expect(names()).toEqual(['Prompt Lab']);
    });

    test('🔴 Undo inside the window → the tile is back AT ONCE, in its old place, never twice', async () => {
      const unhide = deferred<{ slug: string }>();
      const serverUnhide = mocks.unhide;
      mocks.unhide = vi.fn(async (input: { slug: string }) => {
        await unhide.promise;
        return serverUnhide(input);
      });
      await renderAndRemove('Pixel Forge');
      await userEvent.click(page.getByTestId('apps-home-undo'));
      // The unhide has NOT settled: only the still-cached row can put the tile back.
      await expect.poll(names).toEqual(['Pixel Forge', 'Prompt Lab']);
      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(mocks.unhide.mock.calls[0][0]).toEqual({ slug: 'pixel-forge' });
      // Once it settles, the one refetch reads the server's (unhidden) list: no duplicate.
      unhide.resolve({ slug: 'pixel-forge' });
      await expect.poll(() => mocks.invalidate.mock.calls.length).toBe(1);
      await frame();
      expect(names()).toEqual(['Pixel Forge', 'Prompt Lab']);
    });

    test('🔴 no Undo → exactly one refetch, after the window, bringing in the next app', async () => {
      await renderAndRemove('Pixel Forge');
      fakeTimers();
      await blurBar();
      await advance(5000);
      expect(mocks.invalidate).not.toHaveBeenCalled();
      await expect
        .poll(async () => {
          await advance(1000);
          return page.getByTestId('apps-home-removed').elements().length;
        })
        .toBe(0);
      await expect.poll(() => mocks.invalidate.mock.calls.length).toBe(1);
      await expect.poll(names).toEqual(['Prompt Lab', 'Third App']);
      await advance(60_000);
      expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    });

    /** Remove Pixel Forge, then Prompt Lab ~3s later (fake time), with the bar's timer live. */
    async function removeTwoApart() {
      await renderAndRemove('Pixel Forge');
      fakeTimers();
      await blurBar();
      await advance(3000);
      // The first removal is still undoable, and nothing has refetched.
      await expect
        .element(page.getByRole('button', { name: 'Undo removing Pixel Forge' }))
        .toBeVisible();
      expect(mocks.invalidate).not.toHaveBeenCalled();
      await removeViaMenu('Prompt Lab');
      await expect.poll(() => mocks.hide.mock.calls.length).toBe(2);
      await expect
        .element(page.getByRole('button', { name: 'Undo removing Prompt Lab' }))
        .toBeVisible();
      await blurBar();
      // Past the FIRST removal's window, inside the second's.
      await advance(5500);
      expect(page.getByTestId('apps-home-removed').elements()).toHaveLength(1);
      expect(mocks.invalidate).not.toHaveBeenCalled();
    }

    test('🔴 two removes 3s apart: the later one stays undoable past the earlier window', async () => {
      mocks.unhide = vi.fn(() => new Promise<never>(() => undefined));
      await removeTwoApart();
      await userEvent.click(page.getByRole('button', { name: 'Undo removing Prompt Lab' }));
      // Its row is still cached (the earlier window's close did not refetch), so it is back
      // at once although the unhide never settles. The earlier removal stays removed.
      await expect.poll(names).toEqual(['Prompt Lab']);
      expect(mocks.invalidate).not.toHaveBeenCalled();
    });

    test('🔴 two removes 3s apart, no Undo: ONE refetch, after the later window', async () => {
      await removeTwoApart();
      await expect
        .poll(async () => {
          await advance(1000);
          return page.getByTestId('apps-home-removed').elements().length;
        })
        .toBe(0);
      await expect.poll(() => mocks.invalidate.mock.calls.length).toBe(1);
      await expect.poll(names).toEqual(['Third App']);
      await advance(60_000);
      expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    });

    test('🔴 a failed hide rolls back its tile; an earlier removal stays removed, unrefetched meanwhile', async () => {
      await renderAndRemove('Pixel Forge');
      const failing = deferred<never>();
      mocks.hide = vi.fn(() => failing.promise);
      await removeViaMenu('Prompt Lab');
      await expect.poll(() => mocks.hide.mock.calls.length).toBe(1);
      // Both hidden, and nothing refetched while the bar is up: the cap has not pulled in
      // Third App.
      await expect.poll(names).toEqual([]);
      expect(mocks.invalidate).not.toHaveBeenCalled();
      failing.reject(new Error('nope'));
      await expect.poll(() => names().includes('Prompt Lab')).toBe(true);
      expect(names()).not.toContain('Pixel Forge');
      expect(page.getByTestId('apps-home-removed').elements()).toHaveLength(0);
      // The bar closed, so the owed refetch runs once and reads the server's real state.
      await expect.poll(() => mocks.invalidate.mock.calls.length).toBe(1);
      await expect.poll(names).toEqual(['Prompt Lab', 'Third App']);
    });
  });
});
