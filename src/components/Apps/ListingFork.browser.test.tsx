import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';
import type * as NotificationsModule from '~/utils/notifications';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

/**
 * Forkable apps — the three UI pieces, rendered for real:
 *   1. `ListingForkSetting`  — the author's "Let others fork this app's source" checkbox (Details
 *      tab): consent copy present, a click saves through `updateListing` as a `{ forkable }`
 *      patch, an unapplied migration shows a note instead of a control, flag off shows nothing.
 *   2. `ListingForkAttribution` — "Forked from …" on a fork's store page: the parent named and
 *      linked when the server says it is visible, the generic sentence (and no link) otherwise.
 *   3. `ListingForksSection` — "N forks" and the list on a parent's store page, behind the flag.
 *
 * WHOLE visible strings are pinned (`textContent` equality), not substrings, so a reworded or
 * truncated sentence fails here.
 *
 * Mock-shadowed: tRPC and the feature flags. The server's gates (who may set it, what counts as a
 * published fork, when a parent may be named) are pinned in the unit tier.
 */

const mocks = vi.hoisted(() => ({
  features: { appBlocksFork: true } as Record<string, boolean>,
  /** `[procedureName, input]` for every mutation fired. */
  calls: [] as Array<[string, unknown]>,
  mutationFails: false,
  invalidated: [] as unknown[],
  forkPages: [] as unknown[],
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  infiniteQueryCalls: 0,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => mocks.features,
}));

vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showErrorNotification: vi.fn(),
  showSuccessNotification: vi.fn(),
}));

type MutationOpts = {
  onSuccess?: (data: unknown, vars: unknown) => unknown;
  onError?: (err: unknown, vars: unknown) => unknown;
};

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    // A proxy: only the two procedures this file measures are overridden, so any other hook a
    // component reaches answers inertly instead of crashing the render.
    trpc: makeTrpcProxy(
      {
        'appListings.updateListing': {
          useMutation: (opts?: MutationOpts) => ({
            mutate: (input: unknown) => {
              mocks.calls.push(['updateListing', input]);
              if (mocks.mutationFails) void opts?.onError?.({ message: 'nope' }, input);
              else void opts?.onSuccess?.({}, input);
            },
            isPending: false,
          }),
        },
        'appListings.listForks': {
          useInfiniteQuery: () => {
            mocks.infiniteQueryCalls += 1;
            return {
              data: { pages: mocks.forkPages },
              hasNextPage: mocks.hasNextPage,
              isFetchingNextPage: false,
              fetchNextPage: mocks.fetchNextPage,
            };
          },
        },
      },
      {
        // A stable recorder, so the invalidate assertion measures this component's call.
        useUtils: () => ({
          appListings: {
            getAuthoringContext: {
              invalidate: (input: unknown) => mocks.invalidated.push(input),
            },
          },
        }),
      }
    ),
  };
});

const { ListingForkSetting, FORK_SETTING_SAVED_ON, FORK_SETTING_SAVED_OFF } = await import(
  './ListingForkSetting'
);
const { ListingForkAttribution } = await import('./ListingForkAttribution');
const { ListingForksSection } = await import('./ListingForksSection');

const LISTING_ID = 'apl_ui_8001';

beforeEach(() => {
  mocks.features = { appBlocksFork: true };
  mocks.calls = [];
  mocks.mutationFails = false;
  mocks.invalidated = [];
  mocks.forkPages = [];
  mocks.hasNextPage = false;
  mocks.fetchNextPage.mockReset();
  mocks.infiniteQueryCalls = 0;
  vi.mocked(showSuccessNotification).mockReset();
  vi.mocked(showErrorNotification).mockReset();
});

describe('ListingForkSetting — the author opt-in', () => {
  test('renders the label and the WHOLE consent copy', async () => {
    await renderWithProviders(
      <ListingForkSetting appListingId={LISTING_ID} forkable={false} forkableAvailable />
    );
    const card = page.getByTestId('apps-fork-setting');
    await expect.element(card).toBeInTheDocument();
    const text = card.element().textContent;
    expect(text).toBe(
      'Forking' +
        "Let others fork this app's source" +
        "Others can copy your app's source into their own App Assistant workspace and publish it as a new app. " +
        'Published forks usually show “Forked from” with a link back to your app. ' +
        'Forks don’t share your earnings, and a fork has to pass its own review before it can sell anything. ' +
        'Turning this off stops new forks; forks that already exist stay up.'
    );
  });

  test('ticking it saves a { forkable: true } patch for THIS listing and confirms', async () => {
    await renderWithProviders(
      <ListingForkSetting appListingId={LISTING_ID} forkable={false} forkableAvailable />
    );
    const box = page.getByRole('checkbox', { name: "Let others fork this app's source" });
    await expect.element(box).not.toBeChecked();
    await userEvent.click(box);

    expect(mocks.calls).toEqual([
      ['updateListing', { listingId: LISTING_ID, patch: { forkable: true } }],
    ]);
    await expect.element(box).toBeChecked();
    expect(vi.mocked(showSuccessNotification)).toHaveBeenCalledWith({
      title: 'Saved',
      message: FORK_SETTING_SAVED_ON,
    });
    expect(mocks.invalidated).toEqual([{ appListingId: LISTING_ID }]);
  });

  test('unticking saves { forkable: false }', async () => {
    await renderWithProviders(
      <ListingForkSetting appListingId={LISTING_ID} forkable forkableAvailable />
    );
    const box = page.getByRole('checkbox', { name: "Let others fork this app's source" });
    await expect.element(box).toBeChecked();
    await userEvent.click(box);
    expect(mocks.calls).toEqual([
      ['updateListing', { listingId: LISTING_ID, patch: { forkable: false } }],
    ]);
    expect(vi.mocked(showSuccessNotification)).toHaveBeenCalledWith({
      title: 'Saved',
      message: FORK_SETTING_SAVED_OFF,
    });
  });

  test('a failed save puts the box back and says so', async () => {
    mocks.mutationFails = true;
    await renderWithProviders(
      <ListingForkSetting appListingId={LISTING_ID} forkable={false} forkableAvailable />
    );
    const box = page.getByRole('checkbox', { name: "Let others fork this app's source" });
    await userEvent.click(box);
    await expect.element(box).not.toBeChecked();
    expect(vi.mocked(showErrorNotification)).toHaveBeenCalledTimes(1);
  });

  test('migration not applied → a note, and no control to click', async () => {
    await renderWithProviders(
      <ListingForkSetting appListingId={LISTING_ID} forkable={false} forkableAvailable={false} />
    );
    const note = page.getByTestId('apps-fork-setting-unavailable');
    await expect.element(note).toBeInTheDocument();
    expect(note.element().textContent).toBe(
      'Forking can’t be turned on here yet. Try again after the next update.'
    );
    expect(page.getByRole('checkbox').elements()).toHaveLength(0);
  });

  test('flag OFF → nothing at all', async () => {
    mocks.features = {};
    await renderWithProviders(
      <ListingForkSetting appListingId={LISTING_ID} forkable={false} forkableAvailable />
    );
    expect(page.getByTestId('apps-fork-setting').elements()).toHaveLength(0);
    expect(page.getByRole('checkbox').elements()).toHaveLength(0);
  });
});

describe('ListingForkSetting — after a rollback (flag OFF)', () => {
  test('an opted-in author can still withdraw: untick saves { forkable: false }, and cannot re-tick', async () => {
    mocks.features = {};
    await renderWithProviders(
      <ListingForkSetting appListingId={LISTING_ID} forkable forkableAvailable />
    );
    const box = page.getByRole('checkbox', { name: "Let others fork this app's source" });
    await expect.element(box).toBeChecked();
    await userEvent.click(box);
    expect(mocks.calls).toEqual([
      ['updateListing', { listingId: LISTING_ID, patch: { forkable: false } }],
    ]);
    await expect.element(box).not.toBeChecked();
    await expect.element(box).toBeDisabled();
  });
});

describe('ListingForkAttribution — "Forked from …"', () => {
  test('a visible parent is named and linked to its store page', async () => {
    await renderWithProviders(
      <ListingForkAttribution forkOf={{ visible: true, slug: 'the-parent', name: 'The Parent' }} />
    );
    const line = page.getByTestId('apps-listing-forked-from');
    await expect.element(line).toBeInTheDocument();
    expect(line.element().textContent).toBe('Forked from The Parent');
    expect(page.getByTestId('apps-listing-forked-from-link').element().getAttribute('href')).toBe(
      '/apps/store-preview/the-parent'
    );
  });

  test('a hidden or deleted parent gets the generic sentence, and no link', async () => {
    await renderWithProviders(<ListingForkAttribution forkOf={{ visible: false }} />);
    const line = page.getByTestId('apps-listing-forked-from');
    await expect.element(line).toBeInTheDocument();
    expect(line.element().textContent).toBe('Forked from an app that is no longer available');
    expect(line.element().querySelector('a')).toBeNull();
  });

  test('not a fork → nothing', async () => {
    await renderWithProviders(<ListingForkAttribution forkOf={null} />);
    expect(page.getByTestId('apps-listing-forked-from').elements()).toHaveLength(0);
  });
});

describe('ListingForksSection — "N forks"', () => {
  const forks = [
    { id: 'apl_fork_8103', slug: 'fork-three', name: 'Fork Three' },
    { id: 'apl_fork_8102', slug: 'fork-two', name: 'Fork Two' },
  ];

  test('shows the count and the forks, each linked to its store page', async () => {
    mocks.forkPages = [{ totalCount: 3, items: forks, nextCursor: 'apl_fork_8102' }];
    mocks.hasNextPage = true;
    await renderWithProviders(<ListingForksSection listingId={LISTING_ID} />);
    await expect.element(page.getByTestId('apps-listing-forks')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-forks-count').element().textContent).toBe('3 forks');
    const links = [
      ...page.getByTestId('apps-listing-forks-list').element().querySelectorAll('a'),
    ].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['Fork Three', '/apps/store-preview/fork-three'],
      ['Fork Two', '/apps/store-preview/fork-two'],
    ]);
    const more = page.getByTestId('apps-listing-forks-more');
    expect(more.element().textContent).toBe('Show more forks');
    await userEvent.click(more);
    expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  test('one fork reads "1 fork", with no "show more" on the last page', async () => {
    mocks.forkPages = [{ totalCount: 1, items: forks.slice(0, 1), nextCursor: null }];
    await renderWithProviders(<ListingForksSection listingId={LISTING_ID} />);
    await expect.element(page.getByTestId('apps-listing-forks')).toBeInTheDocument();
    expect(page.getByTestId('apps-listing-forks-count').element().textContent).toBe('1 fork');
    expect(page.getByTestId('apps-listing-forks-more').elements()).toHaveLength(0);
  });

  test('no visible forks → nothing (no "0 forks")', async () => {
    mocks.forkPages = [{ totalCount: 0, items: [], nextCursor: null }];
    await renderWithProviders(<ListingForksSection listingId={LISTING_ID} />);
    expect(page.getByTestId('apps-listing-forks').elements()).toHaveLength(0);
  });

  test('the server answering null (its own flag check said no) → nothing', async () => {
    mocks.forkPages = [null];
    await renderWithProviders(<ListingForksSection listingId={LISTING_ID} />);
    expect(page.getByTestId('apps-listing-forks').elements()).toHaveLength(0);
  });

  test('flag OFF → nothing, and the query is never even created', async () => {
    mocks.features = {};
    mocks.forkPages = [{ totalCount: 3, items: forks, nextCursor: null }];
    await renderWithProviders(<ListingForksSection listingId={LISTING_ID} />);
    expect(page.getByTestId('apps-listing-forks').elements()).toHaveLength(0);
    expect(mocks.infiniteQueryCalls).toBe(0);
  });
});
