import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as DialogProviderMod from '~/components/Dialog/DialogProvider';
import type * as NotificationsMod from '~/utils/notifications';
import { AddToStorylineModal } from '~/components/Storyline/AddToStorylineModal';
import { NsfwLevel } from '~/server/common/enums';

/**
 * A published post's menu adds it to one of the owner's storylines: chapter 1 of an empty one,
 * else after the end of the main path. The server's refusals are covered with the add paths.
 */

const mocks = vi.hoisted(() => ({
  feedInput: null as unknown,
  storylines: [] as Record<string, unknown>[],
  addAtEnd: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  const mutation = (spy: (input: unknown) => unknown) => ({
    useMutation: () => ({ mutateAsync: async (input: unknown) => spy(input) }),
  });
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'storyline.getInfinite': {
          useInfiniteQuery: (input: unknown) => {
            mocks.feedInput = input;
            return {
              data: { pages: [{ items: mocks.storylines, nextCursor: undefined }] },
              isLoading: false,
              isError: false,
              hasNextPage: false,
            };
          },
        },
        'storyline.addChapterAtEnd': mutation(mocks.addAtEnd),
      },
      {
        useUtils: () => ({
          storyline: { invalidate: async () => undefined },
        }),
      }
    ),
  };
});
vi.mock('~/components/Dialog/DialogProvider', async (orig) => ({
  ...(await orig<typeof DialogProviderMod>()),
  useDialogContext: () => ({ opened: true, onClose: mocks.onClose, zIndex: 200 }),
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsMod>()),
  showSuccessNotification: () => undefined,
}));

const post = { id: 41, title: 'Cat patch', nsfwLevel: NsfwLevel.R, publishedAt: new Date() };
const storyline = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  title: `Story ${id}`,
  status: 'Ongoing',
  chapterCount: 3,
  maxNsfwLevel: NsfwLevel.R,
  coverImage: null,
  ...overrides,
});
const option = (id: number) => page.getByRole('radio', { name: new RegExp(`Story ${id}`) });
const add = () => page.getByRole('button', { name: 'Add chapter' });

beforeEach(() => {
  mocks.storylines = [];
  mocks.addAtEnd.mockReset();
  mocks.onClose.mockReset();
  vi.mocked(useRouter().push).mockClear();
});

describe('AddToStorylineModal', () => {
  test("lists the viewer's own storylines", async () => {
    mocks.storylines = [storyline(1)];
    renderWithProviders(<AddToStorylineModal post={post} />);

    await expect.element(option(1)).toBeVisible();
    expect(mocks.feedInput).toMatchObject({ filter: 'mine' });
  });

  // The server finds the end of the main path; the client's own read could be capped or stale.
  test('asks the server to add the post at the end, then opens the storyline', async () => {
    mocks.storylines = [storyline(1)];
    renderWithProviders(<AddToStorylineModal post={post} />);

    await option(1).click();
    await add().click();
    await expect.poll(() => mocks.addAtEnd.mock.calls).toEqual([[{ storylineId: 1, postId: 41 }]]);
    await expect.poll(() => vi.mocked(useRouter().push).mock.calls).toEqual([['/storylines/1']]);
  });

  test('offers an empty storyline whatever its rating: chapter 1 raises it to fit', async () => {
    mocks.storylines = [storyline(2, { chapterCount: 0, maxNsfwLevel: NsfwLevel.PG })];
    renderWithProviders(<AddToStorylineModal post={post} />);

    await expect.element(option(2)).toBeEnabled();
    await expect.element(option(2)).toHaveTextContent('this post becomes chapter 1');
  });

  test('a storyline the post is rated above, or a complete one, cannot be picked', async () => {
    mocks.storylines = [
      storyline(3, { maxNsfwLevel: NsfwLevel.PG13 }),
      storyline(4, { status: 'Complete' }),
    ];
    renderWithProviders(<AddToStorylineModal post={post} />);

    await expect.element(option(3)).toBeDisabled();
    await expect.element(option(3)).toHaveTextContent('Allows up to PG-13');
    await expect.element(option(4)).toBeDisabled();
    await expect.element(add()).toBeDisabled();
  });

  test("shows the server's refusal and stays open", async () => {
    mocks.storylines = [storyline(1)];
    mocks.addAtEnd.mockRejectedValue(new Error('This post is already in a storyline'));
    renderWithProviders(<AddToStorylineModal post={post} />);

    await option(1).click();
    await add().click();
    await expect.element(page.getByText('This post is already in a storyline')).toBeVisible();
    expect(mocks.onClose).not.toHaveBeenCalled();
  });
});
