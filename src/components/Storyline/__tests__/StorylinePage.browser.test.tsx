import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import { StorylinePage } from '~/components/Storyline/StorylinePage';

/**
 * The storyline page as a stranger sees it: chapter 1 with its continuations in the order the
 * server gives, a continuation they may not see shown as unavailable rather than dropped, the
 * creator and endorsed collaborators, and chapter 1's thread as the discussion.
 */

const mocks = vi.hoisted(() => ({
  storyline: {
    id: 2,
    title: 'The Patch',
    status: 'Ongoing',
    maxNsfwLevel: 2,
    userId: 10,
    user: { id: 10, username: 'Sillycat83' },
    rootChapterId: 100,
    collaborators: [{ id: 11, username: 'tehalex86' }],
  } as Record<string, unknown> | undefined,
  commentsPostId: vi.fn(),
  query: (data: unknown) => ({ useQuery: () => ({ data, isLoading: false }) }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'storyline.getById': { useQuery: () => ({ data: mocks.storyline, isLoading: false }) },
      'storyline.getPath': mocks.query({
        chapters: [
          {
            chapterId: 100,
            depth: 0,
            tombstone: null,
            post: { id: 501, title: 'The cat patch', userId: 10, username: 'Sillycat83' },
          },
        ],
      }),
      'storyline.getChildren': mocks.query([
        {
          chapterId: 101,
          depth: 1,
          tombstone: null,
          rank: 'canon',
          post: {
            id: 502,
            title: 'The patch becomes a painting',
            userId: 10,
            username: 'Sillycat83',
          },
        },
        {
          chapterId: 102,
          depth: 1,
          tombstone: null,
          rank: 'endorsed',
          post: { id: 503, title: 'A T-shirt', userId: 11, username: 'tehalex86' },
        },
        { chapterId: 103, depth: 1, tombstone: 'browsingLevel', rank: 'community', post: null },
      ]),
    }),
  };
});

vi.mock('~/components/Storyline/StorylineCover', () => ({
  StorylineCover: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock('~/components/Post/Detail/PostComments', () => ({
  PostComments: ({ postId }: { postId: number }) => {
    mocks.commentsPostId(postId);
    return <div>Comments for post {postId}</div>;
  },
}));
vi.mock('~/components/UserAvatar/UserAvatarSimple', () => ({
  UserAvatarSimple: ({ username }: { username: string }) => <span>{username}</span>,
}));

describe('StorylinePage', () => {
  test('shows the story, its continuations in order, its contributors and its discussion', async () => {
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(page.getByRole('heading', { name: 'The Patch' })).toBeVisible();
    await expect.element(page.getByText('Ongoing', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Rated up to PG-13')).toBeVisible();
    await expect
      .element(page.getByRole('link', { name: 'Read from the start' }))
      .toHaveAttribute('href', '/posts/501');
    await expect
      .element(page.getByRole('link', { name: '1. The cat patch' }))
      .toHaveAttribute('href', '/posts/501');

    await expect.element(page.getByText('3 ways to continue')).toBeVisible();
    const continuations = page.getByRole('list').getByText(/^2\. /);
    expect(continuations.elements().map((el) => el.textContent)).toEqual([
      '2. The patch becomes a painting by Sillycat83',
      '2. A T-shirt by tehalex86',
      "2. This chapter isn't available",
    ]);

    const contributors = page.getByRole('region', { name: 'Contributors' });
    expect(contributors.element().textContent).toBe(
      'ContributorsSillycat83Creatortehalex86Endorsed'
    );
    await expect.element(page.getByText('Comments for post 501')).toBeVisible();
    expect(mocks.commentsPostId).toHaveBeenLastCalledWith(501);
  });

  test('a storyline the viewer cannot open says so instead of rendering a shell', async () => {
    mocks.storyline = undefined;
    renderWithProviders(<StorylinePage id={2} />);

    await expect
      .element(page.getByText("This storyline doesn't exist or isn't available to you."))
      .toBeVisible();
    await expect.element(page.getByText('Read from the start')).not.toBeInTheDocument();
  });
});
