import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as QueriesMod from '~/components/Storyline/storyline.queries';
import { StorylinePage } from '~/components/Storyline/StorylinePage';

/**
 * The storyline page: the main path in the server's order with its forks, a chapter the reader
 * may not see shown as unavailable rather than dropped, the cast, chapter 1's thread as the
 * discussion, and Continue offered from the end of the path at the price this reader would pay.
 */

const chapter = (depth: number, postId: number | null, childCount = 1, title?: string) => ({
  chapterId: 100 + depth,
  depth,
  tombstone: postId ? null : 'browsingLevel',
  post: postId
    ? { id: postId, title: title ?? null, userId: 10, username: depth ? 'tehalex86' : 'Sillycat83' }
    : null,
  childCount,
});

const STORYLINE = {
  id: 2,
  title: 'The Patch',
  status: 'Ongoing',
  maxNsfwLevel: 2,
  userId: 10,
  user: { id: 10, username: 'Sillycat83' },
  rootChapterId: 100,
  rootPostId: 501,
  chapterCount: 7,
  contributorCount: 3,
  viewerRole: null as string | null,
  mainPath: [
    chapter(0, 501, 1, 'The cat patch'),
    chapter(1, 502, 3),
    chapter(2, null, 1),
    chapter(3, 504, 2, 'Framed'),
  ],
  contributors: [
    { user: { id: 10, username: 'Sillycat83' }, role: 'creator' },
    { user: { id: 11, username: 'tehalex86' }, role: 'endorsed' },
    { user: { id: 12, username: 'Tar_Tarj' }, role: 'contributor' },
  ],
};

const mocks = vi.hoisted(() => ({
  storyline: undefined as Record<string, unknown> | undefined,
  terms: null as { open: boolean; closedReason: string | null; price: number } | null,
  termsFor: vi.fn(),
  commentsPostId: vi.fn(),
  openContinue: vi.fn(),
  openManage: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'storyline.getById': { useQuery: () => ({ data: mocks.storyline, isLoading: false }) },
    }),
  };
});
vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesMod>()),
  useStorylineContinueTerms: (parentPostId: number | undefined) => {
    mocks.termsFor(parentPostId);
    return mocks.terms;
  },
}));
vi.mock('~/components/Storyline/continue/openStorylineContinueModal', () => ({
  openStorylineContinueModal: mocks.openContinue,
}));
vi.mock('~/components/Storyline/manage/openStorylineManageModal', () => ({
  openStorylineManageModal: mocks.openManage,
}));
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
  mocks.terms = null;
  for (const fn of [mocks.termsFor, mocks.commentsPostId, mocks.openContinue, mocks.openManage])
    fn.mockReset();
});

const heading = () => page.getByRole('heading', { name: 'The Patch' });

describe('StorylinePage', () => {
  test('shows the main path with its forks, the cast and the discussion', async () => {
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toHaveAttribute('data-cover-post', '501');
    await expect.element(page.getByText('7 chapters · 3 creators')).toBeVisible();
    await expect.element(page.getByText('Rated up to PG-13')).toBeVisible();
    await expect
      .element(page.getByRole('link', { name: 'Read from the start' }))
      .toHaveAttribute('href', '/posts/501');

    const path = page.getByRole('region', { name: 'Main path' }).getByRole('listitem');
    expect(path.elements().map((li) => li.textContent)).toEqual([
      '1. The cat patch by Sillycat83',
      '2. Chapter 2 by tehalex863 ways to continue',
      "3. This chapter isn't available",
      '4. Framed by tehalex862 ways to continue',
    ]);

    expect(page.getByRole('region', { name: 'Contributors' }).element().textContent).toBe(
      'ContributorsSillycat83Creatortehalex86EndorsedTar_TarjContributor'
    );
    await expect.element(page.getByText('Comments for post 501')).toBeVisible();
    expect(mocks.commentsPostId).toHaveBeenCalledWith(501);
  });

  test('continues from the last chapter the reader can see, at their price', async () => {
    mocks.storyline = { ...STORYLINE, mainPath: [...STORYLINE.mainPath, chapter(4, null, 0)] };
    mocks.terms = { open: true, closedReason: null, price: 0 };
    renderWithProviders(<StorylinePage id={2} />);

    await page.getByRole('button', { name: 'Continue the story · Free' }).click();
    expect(mocks.openContinue).toHaveBeenCalledWith({ parentPostId: 504 });
    expect(mocks.termsFor).toHaveBeenLastCalledWith(504);
    await expect.element(page.getByText('Open for continuations')).toBeVisible();
  });

  test('a priced storyline shows its price on Continue', async () => {
    mocks.terms = { open: true, closedReason: null, price: 150 };
    renderWithProviders(<StorylinePage id={2} />);

    await expect
      .element(page.getByRole('button', { name: 'Continue the story · 150 Buzz' }))
      .toBeVisible();
  });

  test.each([
    ['closed', { open: false, closedReason: 'closed', price: 0 }],
    ['unknown', null],
  ])('a storyline %s to this reader offers no Continue', async (_label, terms) => {
    mocks.terms = terms;
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(page.getByRole('button', { name: /Continue the story/ }).elements()).toHaveLength(0);
    expect(page.getByText('Open for continuations').elements()).toHaveLength(0);
  });

  // Chapter 1 hidden from this reader: its post, cover and thread must not be reached through
  // the storyline, even though getById carries rootPostId.
  test('a hidden chapter 1 shows no link, cover post or thread', async () => {
    mocks.storyline = {
      ...STORYLINE,
      mainPath: [chapter(0, null), ...STORYLINE.mainPath.slice(1)],
    };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toHaveAttribute('data-cover-post', 'null');
    await expect.element(page.getByText("1. This chapter isn't available")).toBeVisible();
    expect(page.getByText('Read from the start').elements()).toHaveLength(0);
    expect(mocks.commentsPostId).not.toHaveBeenCalled();
  });

  test('a storyline the viewer cannot open says so instead of rendering a shell', async () => {
    mocks.storyline = undefined;
    renderWithProviders(<StorylinePage id={2} />);

    await expect
      .element(page.getByText("This storyline doesn't exist or isn't available to you."))
      .toBeVisible();
    expect(page.getByText('Read from the start').elements()).toHaveLength(0);
  });

  // Manage is the only way into the storyline's settings, and only its owner may use them.
  test('the owner can open Manage', async () => {
    mocks.storyline = { ...STORYLINE, viewerRole: 'owner' };
    renderWithProviders(<StorylinePage id={2} />);

    await page.getByRole('button', { name: 'Manage' }).click();
    expect(mocks.openManage).toHaveBeenCalledWith({ storylineId: 2 });
  });

  test.each([null, 'collaborator'])('a %s viewer sees no Manage button', async (viewerRole) => {
    mocks.storyline = { ...STORYLINE, viewerRole };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(page.getByRole('button', { name: 'Manage' }).elements()).toHaveLength(0);
  });
});
