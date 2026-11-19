import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as TrpcModule from '~/utils/trpc';
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';

/**
 * The review page's store-listing media with the moderator's per-image facts: an above-SFW image
 * is held behind the click-to-reveal on civitai.com, every image says where it shows, and the
 * civitai.red icon / cover overrides appear as their own tiles labelled civitai.red only.
 *
 * Image ids 301 (PG icon) / 302 (R cover) / 303 (PG red icon) / 304 (XXX red cover).
 */

/**
 * The review page's per-image RE-RATE: a moderator's rating picker beside each listing image
 * (icon, cover, screenshots, civitai.red tiles) that calls the EXISTING moderator re-rate,
 * `image.updateImageNsfwLevel`, after which the badges AND the approve bar's "approving raises
 * the rating" warning show the new level before approve.
 *
 * 🔴 THE FAKE SERVER MODELS A LAGGING READ REPLICA, AND THAT IS WHAT MAKES "REFRESHES" HONEST.
 * The re-rate writes the PRIMARY (`server.primary`); every query read comes from the REPLICA
 * (`server.replica`), which this file never advances. So a picker that only invalidated and
 * refetched would read the OLD level back and leave the warning up (red) — the behaviour the
 * round-1 audit found. The level must reach the cached answers from the mutation itself.
 * Each query keeps what it last fetched; only `setData`, or an invalidate that refetches, moves it.
 *
 * Image ids: 101 icon (PG) · 102 cover (R) · 103 screenshot (PG-13) · 104 civitai.red icon
 * (PG-13). The app declares `pg13`, so the R cover alone is what raises the rating.
 */

const server = vi.hoisted(() => ({
  replica: new Map<number, number>(),
  primary: new Map<number, number>(),
  /** Set to make the next re-rate fail with this message. */
  fail: null as string | null,
  rerates: [] as Array<{ id: number; nsfwLevel: number }>,
  reads: { assets: 0, preview: 0 },
  cache: new Map<string, unknown>(),
  subscribers: new Map<string, Set<() => void>>(),
  invalidations: [] as Array<{ path: string; refetchType?: string }>,
  moderator: true,
}));

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: 1, isModerator: server.moderator }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, canViewNsfw: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, canViewNsfw: false }),
  useFeatureFlagsReady: () => true,
  FeatureFlagsProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsProvider>()),
  useBrowsingSettings: () => false,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const React = await import('react');
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  const lv = (id: number) => server.replica.get(id) ?? null;
  const reads = {
    assets: (input: { listingId: string }) => ({
      listingId: input.listingId,
      iconId: 101,
      coverId: 102,
      iconNsfwLevel: lv(101),
      coverNsfwLevel: lv(102),
      iconScanStatus: 'scanned',
      coverScanStatus: 'scanned',
      screenshots: [
        {
          id: 'shot_1',
          imageId: 103,
          order: 0,
          caption: null,
          nsfwLevel: lv(103),
          scanStatus: 'scanned',
        },
      ],
      hasBlockedAsset: false,
      hasPendingScan: false,
      mediaSplitApproved: false,
      redIconId: 104,
      redCoverId: null,
      redIconNsfwLevel: lv(104),
      redCoverNsfwLevel: null,
      redIconScanStatus: 'scanned',
      redCoverScanStatus: null,
      redSlotsAvailable: true,
    }),
    preview: () => ({
      media: {
        icon: null,
        cover: null,
        redIcon: null,
        redCover: null,
        screenshots: [
          { imageId: 103, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: lv(103), caption: 'Main' },
        ],
      },
    }),
  };
  type Kind = keyof typeof reads;
  const keyOf = (kind: Kind, input: { listingId: string }) => `${kind}:${input.listingId}`;
  const notify = (key: string) => {
    for (const fn of [...(server.subscribers.get(key) ?? [])]) fn();
  };
  const fetchInto = (kind: Kind, input: { listingId: string }) => {
    server.reads[kind] += 1;
    server.cache.set(keyOf(kind, input), reads[kind](input));
  };
  /** A query that keeps what it last fetched (react-query's cache, reduced to what is measured). */
  const query = (kind: Kind) => (input: { listingId: string }) => {
    const key = keyOf(kind, input);
    if (!server.cache.has(key)) fetchInto(kind, input);
    const [, rerender] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
      const set = server.subscribers.get(key) ?? new Set<() => void>();
      set.add(rerender);
      server.subscribers.set(key, set);
      return () => {
        set.delete(rerender);
      };
    }, [key]);
    return { data: server.cache.get(key), isLoading: false, isError: false, error: null };
  };
  const procedureUtils = (kind: Kind, path: string) => ({
    setData: (input: { listingId: string }, updater: (old: unknown) => unknown) => {
      const key = keyOf(kind, input);
      if (!server.cache.has(key)) return; // react-query: nothing cached, nothing to update
      server.cache.set(key, updater(server.cache.get(key)));
      notify(key);
    },
    invalidate: async (_input?: unknown, filters?: { refetchType?: string }) => {
      server.invalidations.push({ path, refetchType: filters?.refetchType });
      if (filters?.refetchType === 'none') return;
      for (const key of [...server.cache.keys()].filter((k) => k.startsWith(`${kind}:`))) {
        fetchInto(kind, { listingId: key.slice(kind.length + 1) });
        notify(key);
      }
    },
  });
  const utils = {
    appListings: {
      getAssets: procedureUtils('assets', 'appListings.getAssets'),
      getListingPreviewForReview: procedureUtils(
        'preview',
        'appListings.getListingPreviewForReview'
      ),
    },
  };
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy(
      {
        'appListings.getAssets': { useQuery: query('assets') },
        'appListings.getListingPreviewForReview': { useQuery: query('preview') },
        'image.updateImageNsfwLevel': {
          useMutation: (opts?: { onSuccess?: (data: unknown, vars: unknown) => unknown }) => {
            const [state, setState] = React.useState<{
              isPending: boolean;
              isError: boolean;
              error: { message: string } | null;
            }>({ isPending: false, isError: false, error: null });
            return {
              ...state,
              mutate: (vars: { id: number; nsfwLevel: number }) => {
                server.rerates.push(vars);
                if (server.fail) {
                  setState({ isPending: false, isError: true, error: { message: server.fail } });
                  return;
                }
                // The PRIMARY only: the replica every read uses has not caught up.
                server.primary.set(vars.id, vars.nsfwLevel);
                void opts?.onSuccess?.({ nsfwLevel: vars.nsfwLevel, applied: true }, vars);
              },
            };
          },
        },
      },
      { useUtils: () => utils }
    ),
  };
});

import { OnsiteApproveRatingWarning } from '~/components/Apps/ListingRatingNotices';
import { ReviewListingMediaLive } from '~/components/Apps/ReviewListingMediaLive';
import { ReviewListingMedia } from '~/components/Apps/ReviewListingMedia';

/** What the page's request carried at load: the levels as they were then. */
const REQUEST_MEDIA = {
  icon: { imageId: 101, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 1 },
  cover: { imageId: 102, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 4 },
  redIcon: { imageId: 104, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 2 },
  redCover: null,
};

beforeEach(() => {
  server.replica = new Map([
    [101, 1],
    [102, 4],
    [103, 2],
    [104, 2],
  ]);
  server.primary = new Map(server.replica);
  server.fail = null;
  server.rerates = [];
  server.reads = { assets: 0, preview: 0 };
  server.cache = new Map();
  server.subscribers = new Map();
  server.invalidations = [];
  server.moderator = true;
});

/**
 * The media card reads listing `lst_media_1`; the approve warning reads the listing the approve
 * publishes, `lst_approve_2` — distinct, so a re-rate that updated only the card's cache would
 * leave the warning up.
 */
function mount() {
  renderWithProviders(
    <>
      <ReviewListingMediaLive
        listingId="lst_media_1"
        approveListingId="lst_approve_2"
        slug="gen-matrix"
        name="Gen Matrix"
        iconUrl={REQUEST_MEDIA.icon.url}
        coverUrl={REQUEST_MEDIA.cover.url}
        reviewMedia={REQUEST_MEDIA}
        rating="pg13"
      />
      <OnsiteApproveRatingWarning listingId="lst_approve_2" declaredRating="pg13" />
    </>
  );
}

const picker = (name: string) => page.getByRole('combobox', { name: `${name} rating` });
const value = (name: string) => (picker(name).element() as HTMLSelectElement).value;

describe('ReviewListingMediaLive — the moderator re-rate picker', () => {
  test('🔴 a picker beside the icon, the cover, each screenshot and the civitai.red tile, at the current level', async () => {
    mount();
    await expect.element(picker('Cover')).toBeInTheDocument();
    expect(value('Icon')).toBe('1');
    expect(value('Cover')).toBe('4');
    expect(value('Screenshot 1')).toBe('2');
    expect(value('civitai.red icon')).toBe('2');
    await expect
      .element(page.getByTestId('apps-review-listing-screenshot-gen-matrix-1'))
      .toBeInTheDocument();
  });

  test('🔴 choosing a rating calls the moderator re-rate, and the approve warning refreshes despite a lagging replica', async () => {
    mount();
    // Positive control: the R cover raises the pg13 app's rating, so the warning is up.
    await expect
      .element(page.getByTestId('apps-onsite-rating-mismatch-assets'))
      .toHaveTextContent('Cover (R)');

    await picker('Cover').selectOptions('2');

    // The existing procedure, with the image id and the chosen level, and nothing else.
    expect(server.rerates).toEqual([{ id: 102, nsfwLevel: 2 }]);
    // The replica still says R, and the warning is gone anyway: the level reached the
    // approve listing's cached answer from the mutation, not from a refetch.
    expect(server.replica.get(102)).toBe(4);
    await expect.element(page.getByTestId('apps-onsite-rating-mismatch')).not.toBeInTheDocument();
    await vi.waitFor(() => expect(value('Cover')).toBe('2'));
    // Both queries are marked stale for the next mount, and neither is refetched now.
    expect(server.invalidations).toEqual([
      { path: 'appListings.getAssets', refetchType: 'none' },
      { path: 'appListings.getListingPreviewForReview', refetchType: 'none' },
    ]);
  });

  test('a screenshot re-rate goes through the same procedure with ITS image id, and its badge moves', async () => {
    mount();
    await expect.element(picker('Screenshot 1')).toBeInTheDocument();
    await picker('Screenshot 1').selectOptions('8');
    expect(server.rerates).toEqual([{ id: 103, nsfwLevel: 8 }]);
    await expect
      .element(page.getByTestId('apps-onsite-rating-mismatch-assets'))
      .toHaveTextContent('Screenshot 1 (X)');
    await vi.waitFor(() => expect(value('Screenshot 1')).toBe('8'));
  });

  test('🔴 a refused re-rate shows the server’s message, and nothing moves', async () => {
    server.fail = 'Only moderators can lock an image rating';
    mount();
    await expect.element(picker('Cover')).toBeInTheDocument();
    await picker('Cover').selectOptions('2');
    await expect
      .element(page.getByTestId('apps-review-listing-cover-rate-gen-matrix-error'))
      .toHaveTextContent('Only moderators can lock an image rating');
    expect(server.invalidations).toEqual([]);
    await expect.element(page.getByTestId('apps-onsite-rating-mismatch')).toBeInTheDocument();
    expect(value('Cover')).toBe('4');
  });

  test('a viewer who is not a moderator gets no picker and no extra reads', async () => {
    server.moderator = false;
    mount();
    await expect.element(page.getByTestId('apps-review-listing-media')).toBeInTheDocument();
    expect(page.getByRole('combobox').elements()).toHaveLength(0);
    expect(server.reads.preview).toBe(0);
  });
});

const MEDIA = {
  icon: { imageId: 301, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 1 },
  cover: { imageId: 302, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 4 },
  redIcon: { imageId: 303, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 1 },
  redCover: { imageId: 304, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 16 },
};

const revealed = (testId: string) =>
  page
    .getByTestId(testId)
    .element()
    .querySelector('[data-revealed]')
    ?.getAttribute('data-revealed');

describe('ReviewListingMedia with review media', () => {
  test('🔴 an R cover is held behind the reveal on civitai.com; the PG icon is not', async () => {
    renderWithProviders(
      <ReviewListingMedia
        slug="app"
        name="App"
        iconUrl={MEDIA.icon.url}
        coverUrl={MEDIA.cover.url}
        reviewMedia={MEDIA}
        rating="g"
      />
    );
    await expect.element(page.getByTestId('apps-review-listing-cover-app')).toBeInTheDocument();
    expect(revealed('apps-review-listing-cover-reveal-app')).toBe('false');
    expect(page.getByTestId('apps-review-listing-icon-reveal-app').query()).toBeNull();
    await expect.element(page.getByTestId('apps-review-listing-icon-app')).toBeVisible();
  });

  test('🔴 each image says where it shows; the overrides are civitai.red only, whatever their level', async () => {
    renderWithProviders(
      <ReviewListingMedia
        slug="app"
        name="App"
        iconUrl={MEDIA.icon.url}
        coverUrl={MEDIA.cover.url}
        reviewMedia={MEDIA}
        rating="g"
      />
    );
    await expect
      .element(page.getByTestId('apps-review-listing-icon-audience-app'))
      .toHaveTextContent('civitai.com + civitai.red');
    await expect
      .element(page.getByTestId('apps-review-listing-cover-audience-app'))
      .toHaveTextContent('civitai.red only');
    // A PG override is still civitai.red only: civitai.com never reads it.
    await expect
      .element(page.getByTestId('apps-review-listing-red-icon-audience-app'))
      .toHaveTextContent('civitai.red only');
    await expect
      .element(page.getByTestId('apps-review-listing-red-cover-audience-app'))
      .toHaveTextContent('civitai.red only');
    await expect.element(page.getByTestId('apps-review-listing-red-icon-app')).toBeVisible();
    // The XXX override is held behind the reveal like any other mature image.
    expect(revealed('apps-review-listing-red-cover-reveal-app')).toBe('false');
  });

  test('🔴 the lightbox never offers an image the reveal is holding back', async () => {
    // The R cover is held back: its thumbnail opens nothing, so the viewer (a full-size surface
    // the reveal does not wrap) cannot be navigated to it from the SFW icon either.
    renderWithProviders(
      <ReviewListingMedia
        slug="app"
        name="App"
        iconUrl={MEDIA.icon.url}
        coverUrl={MEDIA.cover.url}
        reviewMedia={MEDIA}
        rating="g"
      />
    );
    await expect.element(page.getByTestId('apps-review-listing-icon-button-app')).toBeVisible();
    expect(page.getByTestId('apps-review-listing-cover-button-app').query()).toBeNull();
  });

  test('positive control: a SFW cover keeps its lightbox button', async () => {
    renderWithProviders(
      <ReviewListingMedia
        slug="app"
        name="App"
        iconUrl={MEDIA.icon.url}
        coverUrl={MEDIA.cover.url}
        reviewMedia={{ ...MEDIA, cover: { ...MEDIA.cover, nsfwLevel: 2 } }}
        rating="g"
      />
    );
    await expect.element(page.getByTestId('apps-review-listing-cover-button-app')).toBeVisible();
  });

  test('without review media it renders the two thumbnails exactly as before', async () => {
    renderWithProviders(
      <ReviewListingMedia
        slug="app"
        name="App"
        iconUrl={MEDIA.icon.url}
        coverUrl={MEDIA.cover.url}
      />
    );
    await expect.element(page.getByTestId('apps-review-listing-cover-app')).toBeVisible();
    expect(page.getByTestId('apps-review-listing-cover-reveal-app').query()).toBeNull();
    expect(page.getByTestId('apps-review-listing-red-icon-app').query()).toBeNull();
  });
});
