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
  popularItems: [] as unknown[],
  popularInputs: [] as Record<string, unknown>[],
  flags: {} as Record<string, boolean>,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'appListings.listMyApps': {
      useQuery: () => ({ ...mocks.myApps, refetch: vi.fn() }),
    },
    'appListings.listAvailable': {
      useQuery: (input: Record<string, unknown>) => {
        mocks.popularInputs.push(input);
        return { data: { items: mocks.popularItems }, isPending: false };
      },
    },
  }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => mocks.flags,
  useOptionalFeatureFlags: () => mocks.flags,
}));

const { AppsHomeBody } = await import('./AppsHomeBody');

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

function popularCard(id: string, name: string): ListingCard {
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
    kindData: { kind: 'onsite', appBlockId: `ab_${id}`, hasPage: true, liveUrl: 'https://x.civit.ai' },
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

beforeEach(() => {
  mocks.myApps = { data: [PAGE_APP, OFFSITE_APP], isLoading: false, isError: false };
  mocks.popularItems = [];
  mocks.popularInputs = [];
  mocks.flags = { appBlocks: true, appBlocksPages: true, appListings: true };
});

describe('the My apps grid', () => {
  test('🔴 a page app launches IN-SITE; an off-site app opens in a NEW TAB with noopener', async () => {
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge')).toBeVisible();
    await expect.element(page.getByText('Prompt Lab')).toBeVisible();

    const pageLaunch = launch('Pixel Forge');
    expect(pageLaunch.getAttribute('href')).toBe('/apps/run/pixel-forge');
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
  test('🔴 no apps → friendly copy, a store CTA, and a strip of popular apps', async () => {
    mocks.myApps = { data: [], isLoading: false, isError: false };
    mocks.popularItems = [popularCard('p1', 'Neon Sketch'), popularCard('p2', 'Tag Wizard')];
    renderWithProviders(<AppsHomeBody />);

    await expect.element(page.getByTestId('apps-home-empty')).toBeVisible();
    expect(page.getByTestId('apps-home-empty-browse').element().getAttribute('href')).toBe(
      '/apps/store'
    );
    await expect.element(page.getByText('Neon Sketch')).toBeVisible();
    await expect.element(page.getByText('Tag Wizard')).toBeVisible();
    // The strip reuses the store's own read, popular-first and small.
    expect(mocks.popularInputs[0]).toEqual({ sort: 'popular', limit: 3 });
    expect(page.getByTestId('apps-home-tile').elements()).toHaveLength(0);
  });

  test('with apps, there is no empty state and no popular strip', async () => {
    mocks.popularItems = [popularCard('p1', 'Neon Sketch')];
    renderWithProviders(<AppsHomeBody />);
    await expect.element(page.getByText('Pixel Forge')).toBeVisible();
    expect(page.getByTestId('apps-home-empty').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-home-popular').elements()).toHaveLength(0);
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
