import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as TrpcModule from '~/utils/trpc';
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';

/**
 * The review page's per-image RE-RATE: a moderator's rating picker beside each listing image
 * (icon, cover, screenshots, civitai.red tiles) that calls the EXISTING moderator re-rate,
 * `image.updateImageNsfwLevel`, and then re-reads the two queries that show the level — so the
 * badges AND the approve bar's "approving raises the rating" warning refresh before approve.
 *
 * 🔴 THE FAKE SERVER IS STATEFUL, AND THAT IS WHAT MAKES "REFRESHES" OBSERVABLE. Each query hook
 * keeps the answer it last FETCHED; only an `invalidate` of THAT procedure re-reads the server.
 * So a picker that wrote but did not invalidate leaves the warning on screen (red), and one that
 * invalidated only `getListingPreviewForReview` leaves it too — the warning reads `getAssets`.
 *
 * Image ids: 101 icon (PG) · 102 cover (R) · 103 screenshot (PG-13) · 104 civitai.red icon
 * (PG-13). The app declares `pg13`, so the R cover alone is what raises the rating.
 */

const server = vi.hoisted(() => ({
  levels: new Map<number, number>(),
  /** Set to make the next re-rate fail with this message. */
  fail: null as string | null,
  rerates: [] as Array<{ id: number; nsfwLevel: number }>,
  reads: { assets: 0, preview: 0 },
  refetch: { assets: new Set<() => void>(), preview: new Set<() => void>() },
  invalidated: { assets: 0, preview: 0 },
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
  const lv = (id: number) => server.levels.get(id) ?? null;
  const assetsView = () => ({
    listingId: 'lst_rerate_1',
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
  });
  const previewView = () => ({
    media: {
      screenshots: [
        { imageId: 103, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: lv(103), caption: 'Main screen' },
      ],
    },
  });
  /** A query that keeps what it last fetched, and re-fetches only when its procedure is invalidated. */
  const fetched = (key: 'assets' | 'preview', read: () => unknown) => () => {
    const fetchNow = () => {
      server.reads[key] += 1;
      return read();
    };
    const [data, setData] = React.useState(fetchNow);
    React.useEffect(() => {
      const again = () => setData(fetchNow());
      server.refetch[key].add(again);
      return () => {
        server.refetch[key].delete(again);
      };
    }, []);
    return { data, isLoading: false, isError: false, error: null };
  };
  const invalidate = (key: 'assets' | 'preview') => async () => {
    server.invalidated[key] += 1;
    for (const again of [...server.refetch[key]]) again();
  };
  const utils = {
    appListings: {
      getAssets: { invalidate: invalidate('assets') },
      getListingPreviewForReview: { invalidate: invalidate('preview') },
    },
  };
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy(
      {
        'appListings.getAssets': { useQuery: fetched('assets', assetsView) },
        'appListings.getListingPreviewForReview': { useQuery: fetched('preview', previewView) },
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
                server.levels.set(vars.id, vars.nsfwLevel);
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

/** What the page's request carried at load: the levels as they were then. */
const REQUEST_MEDIA = {
  icon: { imageId: 101, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 1 },
  cover: { imageId: 102, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 4 },
  redIcon: { imageId: 104, url: LOADABLE_IMAGE_DATA_URI, nsfwLevel: 2 },
  redCover: null,
};

beforeEach(() => {
  server.levels = new Map([
    [101, 1],
    [102, 4],
    [103, 2],
    [104, 2],
  ]);
  server.fail = null;
  server.rerates = [];
  server.reads = { assets: 0, preview: 0 };
  server.invalidated = { assets: 0, preview: 0 };
  server.moderator = true;
});

function mount() {
  renderWithProviders(
    <>
      <ReviewListingMediaLive
        listingId="lst_rerate_1"
        slug="gen-matrix"
        name="Gen Matrix"
        iconUrl={REQUEST_MEDIA.icon.url}
        coverUrl={REQUEST_MEDIA.cover.url}
        reviewMedia={REQUEST_MEDIA}
        rating="pg13"
      />
      <OnsiteApproveRatingWarning listingId="lst_rerate_1" declaredRating="pg13" />
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
    // The screenshot row is the listing's own, read for this page.
    await expect
      .element(page.getByTestId('apps-review-listing-screenshot-gen-matrix-1'))
      .toBeInTheDocument();
  });

  test('🔴 choosing a rating calls the moderator re-rate, and the approve warning refreshes', async () => {
    mount();
    // Positive control: the R cover raises the pg13 app's rating, so the warning is up.
    await expect.element(page.getByTestId('apps-onsite-rating-mismatch')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-onsite-rating-mismatch-assets'))
      .toHaveTextContent('Cover (R)');

    await picker('Cover').selectOptions('2');

    // The existing procedure, with the image id and the chosen level — nothing else.
    expect(server.rerates).toEqual([{ id: 102, nsfwLevel: 2 }]);
    // The warning is gone because getAssets was RE-READ, not because of local state.
    await expect.element(page.getByTestId('apps-onsite-rating-mismatch')).not.toBeInTheDocument();
    expect(server.invalidated).toEqual({ assets: 1, preview: 1 });
    // And the picker shows the level the server now holds.
    await vi.waitFor(() => expect(value('Cover')).toBe('2'));
  });

  test('a screenshot re-rate goes through the same procedure with ITS image id', async () => {
    mount();
    await expect.element(picker('Screenshot 1')).toBeInTheDocument();
    await picker('Screenshot 1').selectOptions('8');
    expect(server.rerates).toEqual([{ id: 103, nsfwLevel: 8 }]);
    await expect
      .element(page.getByTestId('apps-onsite-rating-mismatch-assets'))
      .toHaveTextContent('Screenshot 1 (X)');
  });

  test('🔴 a refused re-rate shows the server’s message, and nothing moves', async () => {
    server.fail = 'Only moderators can lock an image rating';
    mount();
    await expect.element(picker('Cover')).toBeInTheDocument();
    await picker('Cover').selectOptions('2');
    await expect
      .element(page.getByTestId('apps-review-listing-cover-rate-gen-matrix-error'))
      .toHaveTextContent('Only moderators can lock an image rating');
    expect(server.invalidated).toEqual({ assets: 0, preview: 0 });
    await expect.element(page.getByTestId('apps-onsite-rating-mismatch')).toBeInTheDocument();
  });

  test('a viewer who is not a moderator gets no picker and no extra reads', async () => {
    server.moderator = false;
    mount();
    await expect.element(page.getByTestId('apps-review-listing-media')).toBeInTheDocument();
    expect(page.getByRole('combobox').elements()).toHaveLength(0);
    // The warning's own read is the only one.
    expect(server.reads.preview).toBe(0);
  });
});
