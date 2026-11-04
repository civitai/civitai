// The tile's layout (grid columns, one-line truncation) comes from Mantine's stylesheet, which
// the shared scaffold omits; without it every geometry assertion below measures nothing.
// Browser mode gives each file its own iframe, so this does not leak into sibling suites.
import '@mantine/core/styles.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
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
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'appListings.listMyApps': {
      useQuery: () => ({ ...mocks.myApps, refetch: vi.fn() }),
    },
    'appListings.hideMyApp': { useMutation: () => ({ mutateAsync: mocks.hide }) },
    'appListings.unhideMyApp': { useMutation: () => ({ mutateAsync: mocks.unhide }) },
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
  }),
}));
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
const served = (apps: MyAppRow[], hidden: Record<string, string> = {}) => ({ apps, hidden });

beforeEach(() => {
  mocks.myApps = { data: served([PAGE_APP, OFFSITE_APP]), isLoading: false, isError: false };
  mocks.hide = vi.fn(async (input: { slug: string }) => ({
    slug: input.slug,
    hiddenAt: new Date().toISOString(),
  }));
  mocks.unhide = vi.fn(async (input: { slug: string }) => ({ slug: input.slug }));
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
});
