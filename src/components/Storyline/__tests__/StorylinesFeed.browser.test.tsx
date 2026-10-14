import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as ImageUtilsMod from '~/components/Image/image.utils';
import type * as IsMobileMod from '~/hooks/useIsMobile';
import { StorylinesFeed } from '~/components/Storyline/StorylinesFeed';

/**
 * The storylines feed: what the server lists, in its order, each card showing chapter 1's first
 * image as its cover, and the filter and sort passed through to the server rather than applied
 * here (the server is what applies the reader's browsing level).
 */

const mocks = vi.hoisted(() => ({
  feedInput: vi.fn(),
  imagesInput: vi.fn(),
  items: [] as Record<string, unknown>[],
  images: [] as Record<string, unknown>[],
  safe: true,
  failed: false,
  refetch: vi.fn(),
  mobile: false,
}));

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
            isLoading: false,
            hasNextPage: false,
            fetchNextPage: vi.fn(),
            isFetching: false,
          };
        },
      },
    }),
  };
});
vi.mock('~/components/Image/image.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUtilsMod>()),
  useQueryImages: (input: unknown) => {
    mocks.imagesInput(input);
    return { images: mocks.images };
  },
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

const card = (id: number, rootPostId: number | null, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Story ${id}`,
  status: 'Ongoing',
  rootPostId,
  chapterCount: 4,
  contributorCount: 2,
  createdAt: new Date('2026-10-01'),
  user: { id: 10 + id, username: `author${id}` },
  ...extra,
});

beforeEach(() => {
  mocks.safe = true;
  mocks.mobile = false;
  mocks.failed = false;
  mocks.refetch.mockReset();
  mocks.feedInput.mockReset();
  mocks.imagesInput.mockReset();
  mocks.items = [
    card(7, 70),
    card(3, 30, { status: 'Complete', chapterCount: 1, contributorCount: 1 }),
    card(5, null),
  ];
  mocks.images = [
    // The cover is the lowest index, wherever the read returns it: one before it and one after.
    { id: 703, postId: 70, index: 2, url: 'third-of-70' },
    { id: 701, postId: 70, index: 0, url: 'first-of-70' },
    { id: 702, postId: 70, index: 1, url: 'second-of-70' },
    { id: 301, postId: 30, index: 0, url: 'first-of-30' },
  ];
});

describe('StorylinesFeed', () => {
  test('lists storylines in the order given, with chapter 1 covers and counts', async () => {
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
    ).toEqual(['https://cdn.test/first-of-70', 'https://cdn.test/first-of-30', null]);
    await expect.element(page.getByText('4 chapters · 2 creators').first()).toBeVisible();
    await expect.element(page.getByText('1 chapter · 1 creator')).toBeVisible();
    expect(
      links.elements().map((a) => a.querySelector('.mantine-Badge-label')?.textContent)
    ).toEqual(['Ongoing', 'Complete', 'Ongoing']);

    // One image read for the whole page, for the chapter-1 posts it has, at the list's own level.
    const level = mocks.feedInput.mock.lastCall?.[0].browsingLevel;
    expect(level).toEqual(expect.any(Number));
    expect(mocks.imagesInput).toHaveBeenLastCalledWith(
      expect.objectContaining({ postIds: [70, 30], browsingLevel: level })
    );
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
    await page.getByRole('dialog').getByText('Complete', { exact: true }).click();
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect
      .poll(() => mocks.feedInput.mock.lastCall?.[0])
      .toEqual(expect.objectContaining({ filter: 'complete' }));
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
