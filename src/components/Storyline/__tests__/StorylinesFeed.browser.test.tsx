import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
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
            data: { pages: [{ items: mocks.items, nextCursor: undefined }] },
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
vi.mock('~/components/Image/image.utils', () => ({
  useQueryImages: (input: unknown) => {
    mocks.imagesInput(input);
    return { images: mocks.images };
  },
}));
vi.mock('~/components/ImageGuard/ImageGuard2', () => ({
  ImageGuard2: ({ children }: { children: (safe: boolean) => React.ReactNode }) => (
    <>{children(true)}</>
  ),
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

    // One image read for the whole page, for the chapter-1 posts it has.
    expect(mocks.imagesInput).toHaveBeenLastCalledWith(
      expect.objectContaining({ postIds: [70, 30] })
    );
  });

  test('passes the filter and sort to the server', async () => {
    renderWithProviders(<StorylinesFeed />);
    await expect.element(page.getByRole('link').first()).toBeVisible();
    expect(mocks.feedInput).toHaveBeenLastCalledWith(
      expect.objectContaining({ filter: 'all', sort: 'newest' })
    );

    await page.getByText('Open for continuations').click();
    await expect
      .poll(() => mocks.feedInput.mock.lastCall?.[0])
      .toEqual(expect.objectContaining({ filter: 'open', sort: 'newest' }));

    await page.getByRole('textbox', { name: 'Sort' }).click();
    await page.getByRole('option', { name: 'Most chapters' }).click();
    await expect
      .poll(() => mocks.feedInput.mock.lastCall?.[0])
      .toEqual(expect.objectContaining({ filter: 'open', sort: 'mostChapters' }));
  });

  test('says so when nothing matches', async () => {
    mocks.items = [];
    renderWithProviders(<StorylinesFeed />);

    await expect.element(page.getByText('No storylines match.')).toBeVisible();
  });
});
