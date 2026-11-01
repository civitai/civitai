import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as QueriesMod from '~/components/Storyline/storyline.queries';
import type * as TrpcMod from '~/utils/trpc';
import StorylineContinueModal from '~/components/Storyline/continue/StorylineContinueModal';

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  addOwn: vi.fn(),
  refusal: null as string | null,
  invalidate: vi.fn(),
  currentUser: { id: 10, username: 'owner' } as {
    id: number;
    username: string;
    isModerator?: boolean;
  },
  postsOf: undefined as string | undefined,
}));

const { forPosts } = vi.hoisted(() => ({
  forPosts: (input: { postIds: number[] }) => ({
    data: input.postIds.includes(502) ? { 502: { storylineId: 2, depth: 1 } } : {},
    isLoading: false,
  }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  const { useState } = await import('react');
  const mutation = (spy: (input: unknown) => void) => ({
    useMutation: () => {
      const [error, setError] = useState<{ message: string } | null>(null);
      return {
        isPending: false,
        error,
        mutate: (input: unknown, options?: { onSuccess?: () => void }) => {
          spy(input);
          if (mocks.refusal) setError({ message: mocks.refusal });
          else options?.onSuccess?.();
        },
      };
    },
  });
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        // The parent chapter's membership, then which of the owner's posts are chapters already.
        'storyline.getById': {
          useQuery: () => ({
            data: {
              id: 2,
              userId: 10,
              user: { id: 10, username: 'owner' },
              status: 'Ongoing',
              maxNsfwLevel: 4,
              collaborators: [],
              coverImage: null,
              title: 'The Patch',
            },
            isLoading: false,
          }),
        },
        'storyline.getForPosts': { useQuery: forPosts },
        'post.getInfinite': {
          useInfiniteQuery: (input: { username?: string }) => {
            mocks.postsOf = input.username;
            return {
              data: {
                pages: [
                  {
                    nextCursor: undefined,
                    items: [
                      {
                        id: 900,
                        title: 'My new post',
                        nsfwLevel: 1,
                        publishedAt: new Date(),
                        imageCount: 1,
                        user: { id: 10 },
                        images: [],
                      },
                    ],
                  },
                ],
              },
              isLoading: false,
              isError: false,
            };
          },
        },
        'post.get': {
          useQuery: () => ({
            data: { id: 502, title: 'Chapter two', user: { id: 10, username: 'owner' } },
          }),
        },
        'storyline.insertChapter': mutation(mocks.insert),
        'storyline.addChapter': mutation(mocks.addOwn),
      },
      {
        useUtils: () => ({ storyline: { invalidate: mocks.invalidate } }),
        useQueries: (build: (t: unknown) => unknown[]) =>
          build({ storyline: { getForPosts: forPosts } }),
      }
    ),
  };
});
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: vi.fn(), zIndex: 300 }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser,
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ storylines: true }),
}));
vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesMod>()),
  useStorylineContinueTerms: () => ({
    data: { open: false, closedReason: null, price: 0 },
    isLoading: false,
    unavailable: false,
  }),
}));
vi.mock('~/components/Storyline/StorylineThumb', () => ({ StorylineThumb: () => <div /> }));

beforeEach(() => {
  for (const fn of [mocks.insert, mocks.addOwn, mocks.invalidate]) fn.mockReset();
  mocks.refusal = null;
  mocks.currentUser = { id: 10, username: 'owner' };
});

const open = (insertBeforeChapterId?: number) =>
  renderWithProviders(
    <StorylineContinueModal
      parentPostId={502}
      parentChapterId={104}
      insertBeforeChapterId={insertBeforeChapterId}
    />
  );

describe('inserting a chapter from the map', () => {
  test('picking a post inserts it between the two chapters', async () => {
    open(121);
    await page.getByRole('radio', { name: /My new post/ }).click();
    await page.getByRole('button', { name: 'Insert chapter' }).click();

    expect(mocks.insert).toHaveBeenCalledWith({
      storylineId: 2,
      parentChapterId: 104,
      childChapterId: 121,
      postId: 900,
    });
    expect(mocks.addOwn).not.toHaveBeenCalled();
    await expect.element(page.getByText('Inserted into your storyline.')).toBeVisible();
  });

  test("a moderator inserts one of the owner's posts, not their own", async () => {
    mocks.currentUser = { id: 99, username: 'mod', isModerator: true };
    open(121);
    const ownersPost = page.getByRole('radio', { name: /My new post/ });
    await expect.element(ownersPost).toBeVisible();
    await ownersPost.click();
    await page.getByRole('button', { name: 'Insert chapter' }).click();

    expect(mocks.postsOf).toBe('owner');
    expect(mocks.insert).toHaveBeenCalledWith({
      storylineId: 2,
      parentChapterId: 104,
      childChapterId: 121,
      postId: 900,
    });
  });

  test("the server's refusal is shown and the dialog stays", async () => {
    mocks.refusal = "A chapter cannot be inserted before a contributor's chapter";
    open(121);
    await page.getByRole('radio', { name: /My new post/ }).click();
    await page.getByRole('button', { name: 'Insert chapter' }).click();

    await expect
      .element(page.getByText("A chapter cannot be inserted before a contributor's chapter"))
      .toBeVisible();
    expect(page.getByText('Inserted into your storyline.').query()).toBeNull();
    await expect.element(page.getByRole('button', { name: 'Insert chapter' })).toBeVisible();
  });

  test('without an insert point it still adds after the parent', async () => {
    open();
    await page.getByRole('radio', { name: /My new post/ }).click();
    await page.getByRole('button', { name: 'Add chapter' }).click();

    expect(mocks.addOwn).toHaveBeenCalledWith({ parentChapterId: 104, postId: 900 });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
