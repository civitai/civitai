import Router from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as TrpcMod from '~/utils/trpc';
import type * as NotificationsMod from '~/utils/notifications';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * FORKABLE APPS, PR 3 — the Fork action, mounted where users meet it: the store page
 * (`AppListingDetailBody`'s "Use this app" card) and the running app's ⋮ menu (`AppBlockChrome`).
 *
 * Claims: Fork shows ONLY with App Assistant + the `app-blocks-fork` flag + a forkable, publicly
 * visible, on-site listing + a signed-in viewer; it is hidden on the dev tunnel and the review
 * preview; a click calls `appListings.startFork` with the listing id and nothing else, then opens
 * App Assistant on the new fork.
 *
 * The listing read is synchronous in this file, so an absence asserted right after the menu
 * opens is measured against a listing that has already rendered (not the empty first frame).
 */

const FORK_SLUG = 'pixel-garden-fork-7a8b';
const LISTING_ID = 'apl_ui_fork_9001';

const m = vi.hoisted(() => ({
  features: {} as Record<string, boolean>,
  user: null as unknown,
  detail: null as unknown,
  starts: [] as unknown[],
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => m.user }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => m.features,
  useOptionalFeatureFlags: () => m.features,
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsMod>()),
  showErrorNotification: vi.fn(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'appListings.startFork': {
        useMutation: (opts?: { onSuccess?: (data: unknown, vars: unknown) => unknown }) => ({
          mutate: (input: unknown) => {
            m.starts.push(input);
            void opts?.onSuccess?.(
              {
                forkSlug: FORK_SLUG,
                parentName: 'Pixel Garden',
                parentListingId: LISTING_ID,
                seed: { url: 'https://seeds.ui.test/x.zip', sha256: 'e'.repeat(64), bytes: 10 },
              },
              input
            );
          },
          isPending: false,
        }),
      },
      'appListings.getAppDetail': {
        useQuery: () => ({ data: m.detail, isLoading: false, error: null }),
      },
    }),
  };
});
vi.mock('~/components/Apps/AppListingReviews', () => ({
  AppListingReviews: () => <div data-testid="mock-reviews" />,
}));
vi.mock('~/components/Apps/AppListingComments', () => ({
  AppListingComments: () => <div data-testid="mock-comments" />,
}));

const { AppListingDetailBody } = await import('./AppListingDetailBody');
const { AppBlockChrome } = await import('~/components/AppBlocks/IframeHost');

const ACCESS = { appBlocks: true, appListings: true, appAssistant: true, appBlocksFork: true };
const SIGNED_IN = { id: 9101, username: 'forker', isModerator: false };

function detail(over: Partial<ListingDetail> = {}): ListingDetail {
  return {
    id: LISTING_ID,
    serialId: 9002,
    slug: 'pixel-garden',
    kind: 'onsite',
    collaborators: [],
    name: 'Pixel Garden',
    tagline: 'Grow pixels',
    description: null,
    category: 'utility',
    contentRating: null,
    isBeta: false,
    betaMessage: null,
    forkable: true,
    forkOf: null,
    restrictedAudience: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    installCount: 3,
    sourceRepoUrl: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
    screenshots: [],
    scopes: [],
    connectScopes: [],
    kindData: {
      kind: 'onsite',
      appBlockId: 'ab_ui_fork_9003',
      hasPage: true,
      liveUrl: 'https://pixel-garden.civit.ai',
    },
    ...over,
  } as ListingDetail;
}

beforeEach(async () => {
  await page.viewport(1440, 900);
  m.features = { ...ACCESS };
  m.user = SIGNED_IN;
  m.detail = detail();
  m.starts = [];
  vi.mocked(Router.push).mockClear();
});

async function renderStorePage(d: ListingDetail) {
  const { container } = await renderWithProviders(<AppListingDetailBody detail={d} />);
  await expect.element(page.getByTestId('apps-listing-action-card')).toBeInTheDocument();
  return container;
}

describe('the store page — Fork in the "Use this app" card', () => {
  test('shown to a viewer with access, on a forkable public listing; a click forks and opens App Assistant', async () => {
    await renderStorePage(detail());
    const fork = page.getByTestId('apps-listing-fork');
    await expect.element(fork).toBeInTheDocument();
    expect(fork.element().textContent).toBe('Fork');
    await userEvent.click(fork);
    expect(m.starts).toEqual([{ listingId: LISTING_ID }]);
    expect(vi.mocked(Router.push)).toHaveBeenCalledWith(`/apps/build?fork=${FORK_SLUG}`);
  });

  const noFork = (): void => {
    m.features = { ...ACCESS, appBlocksFork: false };
  };
  const noAssistant = (): void => {
    m.features = { ...ACCESS, appAssistant: false };
  };
  const signedOut = (): void => {
    m.user = null;
  };
  const nothing = (): void => undefined;
  test.each([
    ['the fork flag is off', noFork, {}],
    ['the viewer has no App Assistant', noAssistant, {}],
    ['the viewer is signed out', signedOut, {}],
    ['the author has not opted in', nothing, { forkable: false }],
    ['the listing is restricted to a cohort', nothing, { restrictedAudience: 'testers' }],
  ] as const)('hidden when %s', async (_why, arrange, over) => {
    arrange();
    await renderStorePage(detail(over as Partial<ListingDetail>));
    expect(page.getByTestId('apps-listing-fork').elements()).toHaveLength(0);
  });
});

async function openOverflow() {
  await page.getByTestId('app-block-menu-trigger').click();
  await expect.element(page.getByTestId('app-block-menu-dropdown')).toBeInTheDocument();
  await expect.element(page.getByText('Manage apps')).toBeInTheDocument();
}

function renderChrome(hostSurface: string) {
  return renderWithProviders(
    <AppBlockChrome
      blockInstanceId="inst-fork"
      appName="Pixel Garden"
      slug="pixel-garden"
      slotId="app.page"
      hostSurface={hostSurface as never}
    />
  );
}

describe('the running app’s ⋮ menu — Fork', () => {
  test('offered on the run page; a click forks and opens App Assistant', async () => {
    await renderChrome('page-run');
    await openOverflow();
    const item = page.getByTestId('app-block-fork-menu-item');
    await expect.element(item).toBeInTheDocument();
    expect(item.element().textContent).toBe('Fork');
    await userEvent.click(item);
    expect(m.starts).toEqual([{ listingId: LISTING_ID }]);
    expect(vi.mocked(Router.push)).toHaveBeenCalledWith(`/apps/build?fork=${FORK_SLUG}`);
  });

  test.each(['dev-tunnel', 'review-preview'])('hidden on the %s surface', async (surface) => {
    await renderChrome(surface);
    await openOverflow();
    expect(page.getByTestId('app-block-fork-menu-item').elements()).toHaveLength(0);
  });

  test('hidden when the listing is not forkable (positive control: same surface as the offered case)', async () => {
    m.detail = detail({ forkable: false });
    await renderChrome('page-run');
    await openOverflow();
    expect(page.getByTestId('app-block-fork-menu-item').elements()).toHaveLength(0);
  });

  test('hidden with the fork flag off', async () => {
    m.features = { ...ACCESS, appBlocksFork: false };
    await renderChrome('page-run');
    await openOverflow();
    expect(page.getByTestId('app-block-fork-menu-item').elements()).toHaveLength(0);
  });
});
