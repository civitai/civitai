import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import { StorylinePage } from '~/components/Storyline/StorylinePage';

/**
 * The storyline page as a stranger sees it: chapter 1 with its continuations in the order the
 * server gives, a continuation they may not see shown as unavailable rather than dropped, the
 * creator and endorsed collaborators, and chapter 1's thread as the discussion.
 */

const STORYLINE = {
  id: 2,
  title: 'The Patch',
  status: 'Ongoing',
  maxNsfwLevel: 2,
  userId: 10,
  user: { id: 10, username: 'Sillycat83' },
  rootChapterId: 100,
  collaborators: [{ id: 11, username: 'tehalex86' }],
};
const ROOT_CHAPTER = {
  chapterId: 100,
  depth: 0,
  tombstone: null as string | null,
  post: { id: 501, title: 'The cat patch', userId: 10, username: 'Sillycat83' } as Record<
    string,
    unknown
  > | null,
};

const mocks = vi.hoisted(() => ({
  storyline: undefined as Record<string, unknown> | undefined,
  root: undefined as Record<string, unknown> | undefined,
  commentsPostId: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'storyline.getById': { useQuery: () => ({ data: mocks.storyline, isLoading: false }) },
      'storyline.getPath': {
        useQuery: () => ({ data: { chapters: [mocks.root] }, isLoading: false }),
      },
      // Deliberately in neither chapter id nor rank order: the page must keep the server's order.
      'storyline.getChildren': {
        useQuery: () => ({
          data: [
            {
              chapterId: 109,
              depth: 1,
              tombstone: null,
              rank: 'canon',
              post: { id: 502, title: 'A painting', userId: 10, username: 'Sillycat83' },
            },
            { chapterId: 101, depth: 1, tombstone: 'browsingLevel', rank: 'community', post: null },
            {
              chapterId: 105,
              depth: 1,
              tombstone: null,
              rank: 'endorsed',
              post: { id: 503, title: 'A T-shirt', userId: 11, username: 'tehalex86' },
            },
          ],
          isLoading: false,
        }),
      },
    }),
  };
});

vi.mock('~/components/Storyline/StorylineCover', () => ({
  StorylineCover: ({ title, postId }: { title: string; postId: number | null }) => (
    <h1 data-cover-post={String(postId)}>{title}</h1>
  ),
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

beforeEach(() => {
  mocks.storyline = { ...STORYLINE };
  mocks.root = { ...ROOT_CHAPTER };
  mocks.commentsPostId.mockReset();
});

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
    const rows = page.getByRole('listitem').nth(1).element().querySelectorAll(':scope > div');
    expect([...rows].map((row) => row.textContent)).toEqual([
      '2. A painting by Sillycat83Main path',
      "2. This chapter isn't availableCommunity",
      '2. A T-shirt by tehalex86Endorsed',
    ]);

    const contributors = page.getByRole('region', { name: 'Contributors' });
    expect(contributors.element().textContent).toBe(
      'ContributorsSillycat83Creatortehalex86Endorsed'
    );
    await expect.element(page.getByText('Comments for post 501')).toBeVisible();
    expect(mocks.commentsPostId).toHaveBeenCalledWith(501);
  });

  // Chapter 1 hidden from this viewer (taken down, or outside their level): its post, its cover
  // and its thread must not be reached through the storyline.
  test('a hidden chapter 1 shows no link, cover post or thread', async () => {
    mocks.root = { ...ROOT_CHAPTER, tombstone: 'browsingLevel', post: null };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(page.getByText("1. This chapter isn't available")).toBeVisible();
    await expect
      .element(page.getByRole('heading', { name: 'The Patch' }))
      .toHaveAttribute('data-cover-post', 'null');
    await expect.element(page.getByText('Read from the start')).not.toBeInTheDocument();
    expect(mocks.commentsPostId).not.toHaveBeenCalled();
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
