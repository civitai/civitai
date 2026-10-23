import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as IsMobileMod from '~/hooks/useIsMobile';
import type * as BrowsingLevelMod from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { StorylinesFeed } from '~/components/Storyline/StorylinesFeed';

/**
 * The filter and sort are passed through to the server rather than applied here: the server is what
 * applies the reader's browsing level.
 */

const mocks = vi.hoisted(() => ({
  feedInput: vi.fn(),
  items: [] as Record<string, unknown>[],
  loading: false,
  safe: true,
  failed: false,
  refetch: vi.fn(),
  mobile: false,
  user: null as { id: number } | null,
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'storyline.getInfinite': {
        useInfiniteQuery: (input: unknown) => {
          mocks.feedInput(input);
          return {
            data: mocks.failed
              ? undefined
              : { pages: [{ items: mocks.items, nextCursor: undefined }] },
            isError: mocks.failed,
            refetch: mocks.refetch,
            isLoading: mocks.loading,
            hasNextPage: false,
            fetchNextPage: vi.fn(),
            isFetching: false,
          };
        },
      },
    }),
  };
});
// A level no default produces, so the assertion below can only pass if this one is what is sent.
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelMod>()),
  useViewerBrowsingLevelDebounced: () => 12,
}));
// Picks popover or drawer from the layout container, which the harness does not mount.
vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof IsMobileMod>()),
  useIsMobile: () => mocks.mobile,
}));
vi.mock('~/components/ImageGuard/ImageGuard2', () => ({
  ImageGuard2: ({ children }: { children: (safe: boolean) => React.ReactNode }) => (
    <>{children(mocks.safe)}</>
  ),
}));
vi.mock('~/components/ImageHash/ImageHash', () => ({
  MediaHash: () => <span>blurred cover</span>,
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src }: { src: string }) => <img alt="cover" src={`https://cdn.test/${src}`} />,
}));

const cover = (id: number, url: string) => ({
  id,
  url,
  type: 'image',
  nsfwLevel: 1,
  hash: null,
  width: 832,
  height: 1216,
  userId: 1,
  minor: false,
  poi: false,
});
const card = (id: number, coverImage: ReturnType<typeof cover> | null, extra = {}) => ({
  id,
  title: `Story ${id}`,
  status: 'Ongoing',
  whoCanContinue: 'Anyone',
  rootPostId: id * 10,
  coverImage,
  open: true,
  continuePrice: null,
  chapterCount: 4,
  contributorCount: 2,
  createdAt: new Date('2026-10-01'),
  user: { id: 10 + id, username: `author${id}` },
  ...extra,
});

beforeEach(() => {
  mocks.safe = true;
  mocks.mobile = false;
  mocks.user = null;
  mocks.failed = false;
  mocks.refetch.mockReset();
  mocks.feedInput.mockReset();
  mocks.loading = false;
  mocks.items = [
    card(7, cover(701, 'cover-of-7')),
    card(3, cover(301, 'cover-of-3'), {
      status: 'Complete',
      open: false,
      chapterCount: 1,
      contributorCount: 1,
    }),
    // The server sends no cover when chapter 1's images are all hidden from this reader.
    card(5, null),
  ];
});

const cardFor = (id: number) =>
  page
    .getByRole('link')
    .elements()
    .find((a) => a.getAttribute('href') === `/storylines/${id}`)!;
const testIds = (el: Element, id: string) =>
  [...el.querySelectorAll(`[data-testid="${id}"]`)].map((n) => n.textContent);

describe('StorylinesFeed', () => {
  test('lists storylines in the order given, with the covers and counts the server sends', async () => {
    renderWithProviders(<StorylinesFeed />);

    const links = page.getByRole('link');
    await expect.element(links.first()).toBeVisible();
    expect(links.elements().map((a) => a.getAttribute('href'))).toEqual([
      '/storylines/7',
      '/storylines/3',
      '/storylines/5',
    ]);
    expect(
      links.elements().map((a) => a.querySelector('img')?.getAttribute('src') ?? null)
    ).toEqual(['https://cdn.test/cover-of-7', 'https://cdn.test/cover-of-3', null]);
    expect(links.elements().map((a) => testIds(a, 'storyline-status-chip'))).toEqual([
      ['Ongoing'],
      ['Complete'],
      ['Ongoing'],
    ]);
    expect(cardFor(7).textContent).toMatch(/4 chapters.*2 creators/);
    expect(cardFor(3).textContent).toMatch(/1 chapter.*1 creator/);
    expect(mocks.feedInput.mock.lastCall?.[0].browsingLevel).toBe(12);
  });

  test('a lock chip says why a still-going storyline is not open to this reader', async () => {
    mocks.items = [
      card(1, null, { open: false, whoCanContinue: 'Collaborators' }),
      card(2, null, { open: false }),
      card(3, null),
      // Complete says so in its status chip; no lock on top.
      card(4, null, { open: false, status: 'Complete' }),
    ];
    renderWithProviders(<StorylinesFeed />);
    await expect.element(page.getByRole('link').first()).toBeVisible();

    expect([1, 2, 3, 4].map((id) => testIds(cardFor(id), 'storyline-closed-chip'))).toEqual([
      ['Collaborators only'],
      ['Closed'],
      [],
      [],
    ]);
  });

  test('a collaborators-only storyline closed to its own owner says Closed, not Collaborators only', async () => {
    // card(1) is owned by user 11.
    mocks.user = { id: 11 };
    mocks.items = [
      card(1, null, { open: false, whoCanContinue: 'Collaborators' }),
      card(2, null, { open: false, whoCanContinue: 'Collaborators' }),
    ];
    renderWithProviders(<StorylinesFeed />);
    await expect.element(page.getByRole('link').first()).toBeVisible();

    expect([1, 2].map((id) => testIds(cardFor(id), 'storyline-closed-chip'))).toEqual([
      ['Closed'],
      ['Collaborators only'],
    ]);
  });

  test('the continue price shows only on a card this reader can continue', async () => {
    mocks.items = [
      card(1, null, { continuePrice: 0 }),
      card(2, null, { continuePrice: 1500 }),
      card(3, null, { continuePrice: null }),
      card(4, null, { open: false, continuePrice: 50 }),
    ];
    renderWithProviders(<StorylinesFeed />);
    await expect.element(page.getByRole('link').first()).toBeVisible();

    expect([1, 2, 3, 4].map((id) => testIds(cardFor(id), 'storyline-price-chip'))).toEqual([
      ['Free'],
      ['1,500'],
      [],
      [],
    ]);
  });

  test('loading shows card skeletons, not a spinner', async () => {
    mocks.loading = true;
    renderWithProviders(<StorylinesFeed />);

    await expect.element(page.getByTestId('storylines-feed-skeleton')).toBeVisible();
    expect(
      page.getByTestId('storylines-feed-skeleton').element().querySelectorAll('li')
    ).toHaveLength(6);
  });

  test.each([
    ['Ongoing', 'ongoing'],
    ['Open for continuations', 'open'],
    ['Complete', 'complete'],
  ])('the %s filter is sent to the server as %s once applied', async (label, filter) => {
    renderWithProviders(<StorylinesFeed />);
    await expect.element(page.getByRole('link').first()).toBeVisible();
    expect(mocks.feedInput.mock.lastCall?.[0]).toEqual(expect.objectContaining({ filter: 'all' }));

    await page.getByRole('button', { name: 'Filters' }).click();
    await expect.element(page.getByRole('dialog')).toBeVisible();
    expect(page.getByRole('dialog').element().closest('.mantine-Popover-dropdown')).not.toBeNull();
    await page.getByRole('dialog').getByText(label, { exact: true }).click();
    // Staged: picking a chip alone fetches nothing.
    expect(mocks.feedInput.mock.lastCall?.[0]).toEqual(expect.objectContaining({ filter: 'all' }));

    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect
      .poll(() => mocks.feedInput.mock.lastCall?.[0])
      .toEqual(expect.objectContaining({ filter, sort: 'newest' }));
  });

  test('on a phone the filters open in a drawer and apply the same way', async () => {
    mocks.mobile = true;
    renderWithProviders(<StorylinesFeed />);
    await expect.element(page.getByRole('link').first()).toBeVisible();

    await page.getByRole('button', { name: 'Filters' }).click();
    await expect.element(page.getByRole('dialog')).toBeVisible();
    // Mantine gives the popover dropdown role="dialog" too; this is what makes it the drawer.
    expect(document.querySelector('.mantine-Drawer-content')).not.toBeNull();
    expect(document.querySelector('.mantine-Popover-dropdown')).toBeNull();
    await page.getByRole('dialog').getByText('Complete', { exact: true }).click();
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect
      .poll(() => mocks.feedInput.mock.lastCall?.[0])
      .toEqual(expect.objectContaining({ filter: 'complete', browsingLevel: 12 }));
  });

  test('the Filters button counts an active filter, and "All" counts none', async () => {
    renderWithProviders(<StorylinesFeed />);
    const filters = page.getByRole('button', { name: 'Filters' });
    await expect.element(filters).toBeVisible();
    const badge = () =>
      filters
        .element()
        .closest('.mantine-Indicator-root')
        ?.querySelector('.mantine-Indicator-indicator');
    expect(badge()).toBeFalsy();

    await filters.click();
    await page.getByRole('dialog').getByText('Complete', { exact: true }).click();
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect.poll(() => badge()?.textContent).toBe('1');
  });

  test('passes the sort to the server', async () => {
    renderWithProviders(<StorylinesFeed />);
    await expect.element(page.getByRole('link').first()).toBeVisible();
    expect(mocks.feedInput.mock.lastCall?.[0]).toEqual(expect.objectContaining({ sort: 'newest' }));

    await page.getByRole('button', { name: 'Newest' }).click();
    await page.getByRole('menuitem', { name: 'Most chapters' }).click();
    await expect
      .poll(() => mocks.feedInput.mock.lastCall?.[0])
      .toEqual(expect.objectContaining({ filter: 'all', sort: 'mostChapters' }));
    await expect.element(page.getByRole('button', { name: 'Most chapters' })).toBeVisible();
  });

  test('an unsafe cover stays blurred', async () => {
    mocks.safe = false;
    renderWithProviders(<StorylinesFeed />);

    await expect.element(page.getByRole('link').first()).toBeVisible();
    expect(page.getByRole('img', { name: 'cover' }).elements()).toHaveLength(0);
    expect(page.getByText('blurred cover').elements()).toHaveLength(2);
  });

  test('a failed load says so and offers a retry, not an empty feed', async () => {
    mocks.failed = true;
    renderWithProviders(<StorylinesFeed />);

    await expect.element(page.getByText("Couldn't load storylines")).toBeVisible();
    expect(page.getByText('No storylines match.').elements()).toHaveLength(0);
    await page.getByRole('button', { name: 'Try again' }).click();
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  test('says so when nothing matches', async () => {
    mocks.items = [];
    renderWithProviders(<StorylinesFeed />);

    await expect.element(page.getByText('No storylines match.')).toBeVisible();
  });
});
