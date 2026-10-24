import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as StepMod from '~/components/Apps/ListingAssetStep';
import type * as TrpcMod from '~/utils/trpc';
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * The media editor's rating wiring: the declared rating comes from the listing read, the
 * per-asset levels from the asset read of the EDIT TARGET, and both reach the asset step.
 * The step's own rendering is covered in `ListingAssetStep.browser.test.tsx`.
 */

type StepProps = Parameters<typeof StepMod.ListingAssetStep>[0];

const mocks = vi.hoisted(() => ({
  listing: undefined as unknown,
  assets: undefined as unknown,
  assetsError: false,
  assetsInputs: [] as { input: unknown; enabled: boolean | undefined }[],
  invalidateAssets: vi.fn(async () => undefined),
  invalidateListing: vi.fn(async () => undefined),
  stepProps: undefined as unknown,
  isModerator: false,
  setRedMedia: vi.fn(async (input: { slot: string }) => ({ status: 'cleared', slot: input.slot })),
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 7, isModerator: mocks.isModerator }),
}));
vi.mock('~/hooks/useCFImageUpload', () => ({
  useCFImageUpload: () => ({ uploadToCF: vi.fn(), files: [], resetFiles: vi.fn() }),
}));
// The real step, with its props recorded so a test can fire the editor's callbacks.
vi.mock('~/components/Apps/ListingAssetStep', async (importOriginal) => {
  const actual = await importOriginal<typeof StepMod>();
  return {
    ...actual,
    ListingAssetStep: (props: StepProps) => {
      mocks.stepProps = props;
      return createElement(actual.ListingAssetStep, props);
    },
  };
});
vi.mock('~/utils/trpc', async (importOriginal) => {
  const utils = {
    appListings: {
      getAssets: { invalidate: mocks.invalidateAssets },
      getMyListingForApp: { invalidate: mocks.invalidateListing },
    },
  };
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'appListings.getMyListingForApp': {
          useQuery: () => ({ data: mocks.listing, isLoading: !mocks.listing, error: null }),
        },
        'appListings.setRedMedia': {
          useMutation: () => ({
            mutate: vi.fn(),
            mutateAsync: mocks.setRedMedia,
            isPending: false,
          }),
        },
        'appListings.getAssets': {
          useQuery: (input: unknown, opts?: { enabled?: boolean }) => {
            mocks.assetsInputs.push({ input, enabled: opts?.enabled });
            const live = opts?.enabled !== false;
            return {
              data: live && !mocks.assetsError ? mocks.assets : undefined,
              isError: live && mocks.assetsError,
            };
          },
        },
      },
      { useUtils: () => utils }
    ),
  };
});

const { ListingMediaEditor } = await import('./ListingMediaEditor');

const listing = (over: Record<string, unknown> = {}) => ({
  appListingId: 'apl_live',
  status: 'approved',
  role: 'owner',
  contentRating: 'r',
  declaredContentRating: 'g',
  hasPendingRevision: false,
  shadowId: null,
  editTargetId: 'apl_live',
  editBlockedReason: null,
  assets: {
    icon: { imageId: 41, url: LOADABLE_IMAGE_DATA_URI },
    cover: { imageId: 53, url: LOADABLE_IMAGE_DATA_URI },
    screenshots: [
      { id: 'row-1', imageId: 61, url: LOADABLE_IMAGE_DATA_URI, caption: null, order: 0 },
    ],
  },
  ...over,
});
// NsfwLevel bits: PG 1, PG-13 2, R 4.
const assets = {
  iconId: 41,
  coverId: 53,
  iconNsfwLevel: 1,
  coverNsfwLevel: 1,
  screenshots: [{ imageId: 61, nsfwLevel: 4 }],
};
const stepProps = () => mocks.stepProps as StepProps;

beforeEach(() => {
  mocks.listing = listing();
  mocks.assets = assets;
  mocks.assetsError = false;
  mocks.assetsInputs.length = 0;
  mocks.invalidateAssets.mockClear();
  mocks.invalidateListing.mockClear();
  mocks.stepProps = undefined;
  mocks.isModerator = false;
  mocks.setRedMedia.mockClear();
});

describe('ListingMediaEditor — rating visibility', () => {
  test('a live listing raised to R by one screenshot: the badge and the callout both render', async () => {
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    const callout = page.getByTestId('apps-listing-rating-callout');
    await expect.element(callout).toBeInTheDocument();
    await expect
      .element(callout)
      .toHaveTextContent('Screenshot 1 (R) is rated above the G you declared');
    await expect
      .element(callout)
      .toHaveTextContent('That is why this listing is rated R and is hidden on civitai.com');
    expect(page.getByTestId('apps-asset-rating-screenshot-0').element().textContent).toBe(
      'Rated R'
    );
    expect(page.getByTestId('apps-listing-media-ratings-unavailable').elements()).toHaveLength(0);
  });

  test('the levels are read for the EDIT TARGET — the shadow once one exists, not the live parent', async () => {
    mocks.listing = listing({ shadowId: 'apl_shadow', editTargetId: 'apl_shadow' });
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect.element(page.getByTestId('apps-listing-rating-callout')).toBeInTheDocument();
    expect(mocks.assetsInputs.at(-1)).toEqual({
      input: { listingId: 'apl_shadow' },
      enabled: true,
    });
  });

  test('the DECLARED rating decides: the same imagery under a declared R raises nothing', async () => {
    mocks.listing = listing({ declaredContentRating: 'r' });
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect.element(page.getByTestId('apps-asset-rating-screenshot-0')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-rating-callout').elements()).toHaveLength(0);
  });

  test('an owner’s edit of a LIVE listing is a revision: an unapplied raise will be sent back', async () => {
    mocks.listing = listing({ contentRating: 'g' });
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect
      .element(page.getByTestId('apps-listing-rating-callout'))
      .toHaveTextContent('a moderator will send back a change that includes this image');
  });

  test('a moderator editing the live listing directly has no review to wait for', async () => {
    mocks.isModerator = true;
    mocks.listing = listing({ contentRating: 'g' });
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect
      .element(page.getByTestId('apps-listing-rating-callout'))
      .toHaveTextContent('This listing is live and still rated G, below this image.');
  });

  test('a moderator with a staged shadow is in a revision like anyone else', async () => {
    mocks.isModerator = true;
    mocks.listing = listing({
      contentRating: 'g',
      shadowId: 'apl_shadow',
      editTargetId: 'apl_shadow',
    });
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect
      .element(page.getByTestId('apps-listing-rating-callout'))
      .toHaveTextContent('a moderator will send back a change that includes this image');
  });

  test('an unpublished listing is edited in place: approval will rate it, not send it back', async () => {
    mocks.listing = listing({ status: 'removed', contentRating: 'g' });
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect
      .element(page.getByTestId('apps-listing-rating-callout'))
      .toHaveTextContent('When this listing goes live it will be rated R');
  });

  test('a moderator on an unpublished listing is not told it is live', async () => {
    mocks.isModerator = true;
    mocks.listing = listing({ status: 'removed', contentRating: 'g' });
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect
      .element(page.getByTestId('apps-listing-rating-callout'))
      .toHaveTextContent('When this listing goes live it will be rated R');
  });

  test.each(['pending', 'removed'] as const)(
    'a %s listing that was live keeps its rating: replacing the image alone does not lower it',
    async (status) => {
      mocks.listing = listing({ status });
      renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
      await expect
        .element(page.getByTestId('apps-listing-rating-callout'))
        .toHaveTextContent(
          'Replacing that image alone will not lower the listing’s rating; ask a moderator to review that image’s rating.'
        );
    }
  );

  test('a draft that has never been live is re-rated on approve: replacing the image avoids it', async () => {
    mocks.listing = listing({ status: 'draft' });
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect
      .element(page.getByTestId('apps-listing-rating-callout'))
      .toHaveTextContent('once it is live. Replacing that image avoids this.');
  });

  test('a listing whose editing is blocked never asks for asset levels', async () => {
    mocks.listing = listing({ editBlockedReason: 'A moderator removed this listing.' });
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect.element(page.getByTestId('apps-listing-media-begin-error')).toBeInTheDocument();
    expect(mocks.assetsInputs.length).toBeGreaterThan(0);
    expect(mocks.assetsInputs.every((c) => c.enabled === false)).toBe(true);
  });

  test('while the listing itself is loading there is no edit target to read levels for', async () => {
    mocks.listing = undefined;
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await vi.waitFor(() => expect(mocks.assetsInputs.length).toBeGreaterThan(0));
    expect(mocks.assetsInputs.every((c) => c.enabled === false)).toBe(true);
  });

  test('a failed level read is said out loud instead of silently dropping the badges', async () => {
    mocks.assetsError = true;
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect
      .element(page.getByTestId('apps-listing-media-ratings-unavailable'))
      .toBeInTheDocument();
    expect(page.getByTestId('apps-listing-rating-callout').elements()).toHaveLength(0);
  });
});

describe('ListingMediaEditor — the levels are re-read when they can have changed', () => {
  test('nothing is invalidated on mount', async () => {
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect.element(page.getByTestId('apps-listing-rating-callout')).toBeInTheDocument();
    expect(mocks.invalidateAssets).not.toHaveBeenCalled();
  });

  test('an asset mutation re-reads the edit target’s levels and the listing', async () => {
    mocks.listing = listing({ shadowId: 'apl_shadow', editTargetId: 'apl_shadow' });
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect.element(page.getByTestId('apps-listing-rating-callout')).toBeInTheDocument();
    stepProps().onAssetMutated?.();
    expect(mocks.invalidateAssets).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateAssets).toHaveBeenCalledWith({ listingId: 'apl_shadow' });
    expect(mocks.invalidateListing).toHaveBeenCalledWith({ appBlockId: 'ab_1' });
  });

  test('a landed scan re-reads the levels at once, without re-reading the listing', async () => {
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect.element(page.getByTestId('apps-listing-rating-callout')).toBeInTheDocument();
    stepProps().onScanSettled?.();
    expect(mocks.invalidateAssets).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateAssets).toHaveBeenCalledWith({ listingId: 'apl_live' });
    expect(mocks.invalidateListing).not.toHaveBeenCalled();
  });

  test('a scan poll started before the shadow existed still refreshes the SHADOW', async () => {
    // The step's poll keeps the callback from the render the upload started in.
    const { rerender } = await renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect.element(page.getByTestId('apps-listing-rating-callout')).toBeInTheDocument();
    const settledAtUploadStart = stepProps().onScanSettled;
    mocks.listing = listing({ shadowId: 'apl_shadow', editTargetId: 'apl_shadow' });
    await rerender(<ListingMediaEditor appBlockId="ab_1" />);
    await vi.waitFor(() =>
      expect(mocks.assetsInputs.at(-1)?.input).toEqual({ listingId: 'apl_shadow' })
    );
    settledAtUploadStart?.();
    expect(mocks.invalidateAssets).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateAssets).toHaveBeenCalledWith({ listingId: 'apl_shadow' });
  });

  describe('the delayed second re-read', () => {
    // Fake timers go in only once the editor has rendered, so locator polling is not starved.
    const settleWithFakeTimers = async () => {
      const view = await renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
      await expect.element(page.getByTestId('apps-listing-rating-callout')).toBeInTheDocument();
      vi.useFakeTimers();
      return view;
    };
    afterEach(() => {
      vi.useRealTimers();
    });

    test('fires once, 3 s after the scan settles', async () => {
      await settleWithFakeTimers();
      stepProps().onScanSettled?.();
      expect(mocks.invalidateAssets).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2999);
      expect(mocks.invalidateAssets).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(mocks.invalidateAssets).toHaveBeenCalledTimes(2);
      expect(mocks.invalidateAssets).toHaveBeenLastCalledWith({ listingId: 'apl_live' });
      vi.advanceTimersByTime(10_000);
      expect(mocks.invalidateAssets).toHaveBeenCalledTimes(2);
    });

    test('two settles close together share one delayed re-read', async () => {
      await settleWithFakeTimers();
      stepProps().onScanSettled?.();
      vi.advanceTimersByTime(1000);
      stepProps().onScanSettled?.();
      vi.advanceTimersByTime(10_000);
      expect(mocks.invalidateAssets).toHaveBeenCalledTimes(3);
    });

    test('leaving the editor cancels it', async () => {
      const view = await settleWithFakeTimers();
      stepProps().onScanSettled?.();
      await view.unmount();
      vi.advanceTimersByTime(10_000);
      expect(mocks.invalidateAssets).toHaveBeenCalledTimes(1);
    });
  });
});

describe('ListingMediaEditor — civitai.red icon / cover overrides', () => {
  const redMedia = {
    available: true,
    icon: { imageId: null, url: null },
    cover: { imageId: 92, url: LOADABLE_IMAGE_DATA_URI },
  };

  test('🔴 the edit target’s overrides from the listing read reach the step, with the split', async () => {
    mocks.listing = listing({ redMedia });
    mocks.assets = { ...assets, mediaSplitApproved: true };
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect.element(page.getByTestId('apps-listing-red-media')).toBeInTheDocument();
    expect(stepProps().redMedia).toEqual(redMedia);
    expect(stepProps().rating?.mediaSplit).toBe(true);
  });

  test('🔴 an owner clears the live listing’s red cover: setRedMedia on the edit target, then the listing is re-read (the revision it opened)', async () => {
    mocks.listing = listing({ redMedia });
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await page.getByTestId('apps-offsite-remove-red-cover').click();
    await vi.waitFor(() =>
      expect(mocks.setRedMedia).toHaveBeenCalledWith({
        listingId: 'apl_live',
        slot: 'cover',
        imageId: null,
      })
    );
    await vi.waitFor(() =>
      expect(mocks.invalidateListing).toHaveBeenCalledWith({ appBlockId: 'ab_1' })
    );
  });

  test('🔴 an accepted collaborator gets the same picker (the server applies the icon / cover rules)', async () => {
    mocks.listing = listing({ role: 'editor', redMedia });
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect.element(page.getByTestId('apps-offsite-remove-red-cover')).toBeInTheDocument();
  });

  test('🔴 slots unavailable: the editor shows the note, no picker', async () => {
    mocks.listing = listing({ redMedia: { ...redMedia, available: false } });
    renderWithProviders(<ListingMediaEditor appBlockId="ab_1" />);
    await expect
      .element(page.getByTestId('apps-listing-red-media-unavailable'))
      .toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-remove-red-cover').elements()).toHaveLength(0);
  });
});
