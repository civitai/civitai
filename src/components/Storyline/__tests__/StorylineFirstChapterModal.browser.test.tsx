import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as DialogProviderMod from '~/components/Dialog/DialogProvider';
import type * as NotificationsMod from '~/utils/notifications';
import { NsfwLevel } from '~/server/common/enums';
import StorylineFirstChapterModal from '~/components/Storyline/StorylineFirstChapterModal';

/**
 * The owner of an empty storyline picks one of their published posts as its chapter 1 (see
 * StorylineFirstChapterModal.tsx). The server's refusals are in storyline-first-chapter.sql.
 */

const OWNER = 5;
const DAY = 86_400_000;

const mocks = vi.hoisted(() => ({
  items: [] as Record<string, unknown>[],
  olderItems: null as Record<string, unknown>[] | null,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  queries: [] as (string | undefined)[],
  ownerMaxNsfwLevel: 0,
  chapters: {} as Record<number, unknown>,
  mutate: vi.fn(),
  error: null as { message: string } | null,
  options: {} as {
    onSuccess?: (data: { ceilingRaisedTo?: number }) => Promise<void>;
  },
  onClose: vi.fn(),
  invalidate: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'storyline.getById': {
          useQuery: () => ({
            data: {
              id: 3,
              title: 'The Patch',
              maxNsfwLevel: NsfwLevel.PG13,
              ownerMaxNsfwLevel: mocks.ownerMaxNsfwLevel,
            },
            isLoading: false,
          }),
        },
        'post.getInfinite': {
          useInfiniteQuery: (input: { query?: string }) => {
            mocks.queries.push(input.query);
            const pages = [{ items: mocks.items, nextCursor: undefined }];
            if (mocks.olderItems) pages.push({ items: mocks.olderItems, nextCursor: undefined });
            return {
              data: { pages },
              isLoading: false,
              isError: false,
              hasNextPage: mocks.hasNextPage,
              fetchNextPage: mocks.fetchNextPage,
              isFetchingNextPage: false,
            };
          },
        },
        'storyline.getForPosts': {
          useQuery: () => ({ data: mocks.chapters, isLoading: false }),
        },
        'storyline.setFirstChapter': {
          useMutation: (options: typeof mocks.options) => {
            mocks.options = options;
            return { mutate: mocks.mutate, isPending: false, error: mocks.error };
          },
        },
      },
      { useUtils: () => ({ storyline: { invalidate: mocks.invalidate } }) }
    ),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: OWNER, username: 'owner' }),
}));
vi.mock('~/components/Dialog/DialogProvider', async (orig) => ({
  ...(await orig<typeof DialogProviderMod>()),
  useDialogContext: () => ({ opened: true, onClose: mocks.onClose, zIndex: 200 }),
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsMod>()),
  showSuccessNotification: mocks.notify,
}));

const postItem = (
  id: number,
  { nsfwLevel = NsfwLevel.PG, publishedAt = new Date(Date.now() - DAY), userId = OWNER } = {}
) => ({
  id,
  title: `Post ${id}`,
  nsfwLevel,
  publishedAt,
  imageCount: 1,
  user: { id: userId },
  images: [],
});

const tile = (id: number) => page.getByRole('radio', { name: new RegExp(`^Post ${id},`) });
const submit = () => page.getByRole('button', { name: 'Make it chapter 1' });

beforeEach(() => {
  mocks.items = [];
  mocks.olderItems = null;
  mocks.hasNextPage = false;
  mocks.fetchNextPage.mockReset();
  mocks.queries = [];
  mocks.ownerMaxNsfwLevel = NsfwLevel.PG13;
  mocks.chapters = {};
  mocks.error = null;
  mocks.mutate.mockReset();
  mocks.onClose.mockReset();
  mocks.notify.mockReset();
  vi.mocked(useRouter().push).mockClear();
});

describe('StorylineFirstChapterModal', () => {
  test('makes the picked post chapter 1 of this storyline', async () => {
    mocks.items = [postItem(10), postItem(11)];
    renderWithProviders(<StorylineFirstChapterModal storylineId={3} />);

    await expect.element(submit()).toBeDisabled();
    await tile(11).click();
    await submit().click();

    expect(mocks.mutate).toHaveBeenCalledWith({ storylineId: 3, postId: 11 });
  });

  test('offers only published posts that are not chapters yet', async () => {
    mocks.items = [
      postItem(10),
      postItem(12, { publishedAt: new Date(Date.now() + DAY) }),
      postItem(13),
    ];
    mocks.chapters = { 13: { storylineId: 9, chapterId: 1, depth: 0 } };
    renderWithProviders(<StorylineFirstChapterModal storylineId={3} />);

    await expect.element(tile(10)).toBeVisible();
    expect(tile(12).elements()).toHaveLength(0);
    expect(tile(13).elements()).toHaveLength(0);
    await expect
      .element(page.getByText('1 of your posts is already a chapter, so it isn’t listed.'))
      .toBeVisible();
  });

  test('says the ceiling goes up for a post rated above it, and still lets it through', async () => {
    mocks.items = [postItem(10, { nsfwLevel: NsfwLevel.R })];
    renderWithProviders(<StorylineFirstChapterModal storylineId={3} />);

    await tile(10).click();
    await expect
      .element(page.getByText(/raises the maximum to fit it/))
      .toHaveTextContent(/rated R/);
    await expect.element(submit()).toBeEnabled();
  });

  // The owner set R, but a title held to safe for work caps it at PG-13, which no raise lifts.
  test('a post above a capped ceiling is marked and refused, not promised a raise', async () => {
    mocks.ownerMaxNsfwLevel = NsfwLevel.R;
    mocks.items = [postItem(10, { nsfwLevel: NsfwLevel.R })];
    renderWithProviders(<StorylineFirstChapterModal storylineId={3} />);

    await page.getByRole('radio', { name: /above this storyline's PG-13 limit/ }).click();
    await expect.element(page.getByText(/rated above this storyline's maximum/)).toBeVisible();
    expect(page.getByText(/raises the maximum/).elements()).toHaveLength(0);
    await expect.element(submit()).toBeDisabled();
  });

  // Blocked is a moderation verdict: never shown as the post's rating, nor promised a raise.
  test('a post with a Blocked image is refused as unusable, without naming Blocked', async () => {
    mocks.items = [postItem(10, { nsfwLevel: NsfwLevel.R | NsfwLevel.Blocked })];
    renderWithProviders(<StorylineFirstChapterModal storylineId={3} />);

    await tile(10).click();
    await expect.element(page.getByText(/can't be used in a storyline/)).toBeVisible();
    expect(page.getByText(/Blocked/).elements()).toHaveLength(0);
    expect(page.getByText(/raises the maximum/).elements()).toHaveLength(0);
    await expect.element(submit()).toBeDisabled();
  });

  // Only the newest 50 were offered, so an older post could never be picked.
  test('shows older posts a page at a time, and lists them once loaded', async () => {
    mocks.items = [postItem(10)];
    mocks.hasNextPage = true;
    const { rerender } = await renderWithProviders(<StorylineFirstChapterModal storylineId={3} />);

    await page.getByRole('button', { name: 'Show older posts' }).click();
    expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1);

    mocks.olderItems = [postItem(9)];
    mocks.hasNextPage = false;
    rerender(<StorylineFirstChapterModal storylineId={3} />);
    await expect.element(tile(9)).toBeVisible();
    expect(page.getByRole('button', { name: 'Show older posts' }).elements()).toHaveLength(0);
  });

  test('searches your posts by title', async () => {
    mocks.items = [postItem(10)];
    renderWithProviders(<StorylineFirstChapterModal storylineId={3} />);

    await page.getByRole('textbox', { name: 'Search your posts by title' }).fill('  Cat ');
    await expect.poll(() => mocks.queries.at(-1)).toBe('Cat');
  });

  test('says when no title matches the search', async () => {
    renderWithProviders(<StorylineFirstChapterModal storylineId={3} />);

    await page.getByRole('textbox', { name: 'Search your posts by title' }).fill('Zebra');
    await expect
      .element(page.getByText('None of your posts has a title starting with “Zebra”.'))
      .toBeVisible();
  });

  test('an unrated post cannot be picked yet', async () => {
    mocks.items = [postItem(10, { nsfwLevel: 0 })];
    renderWithProviders(<StorylineFirstChapterModal storylineId={3} />);

    await tile(10).click();
    await expect.element(page.getByText(/has not been rated yet/)).toBeVisible();
    await expect.element(submit()).toBeDisabled();
  });

  test("shows the server's refusal", async () => {
    mocks.items = [postItem(10)];
    mocks.error = { message: 'This storyline already has its first chapter' };
    renderWithProviders(<StorylineFirstChapterModal storylineId={3} />);

    await expect
      .element(page.getByText('This storyline already has its first chapter'))
      .toBeVisible();
  });

  test('once done, closes, says so, and opens the storyline', async () => {
    mocks.items = [postItem(10)];
    renderWithProviders(<StorylineFirstChapterModal storylineId={3} />);
    await expect.element(submit()).toBeVisible();

    await mocks.options.onSuccess?.({ ceilingRaisedTo: NsfwLevel.R });

    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.onClose).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('raised to R') })
    );
    expect(useRouter().push).toHaveBeenCalledWith('/storylines/3');
  });
});
