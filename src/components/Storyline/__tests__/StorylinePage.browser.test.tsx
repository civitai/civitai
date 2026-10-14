import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as QueriesMod from '~/components/Storyline/storyline.queries';
import { StorylinePage } from '~/components/Storyline/StorylinePage';

/**
 * The storyline page: the canon path in the server's order with its forks, a chapter the reader
 * may not see shown as unavailable rather than dropped, the cast, chapter 1's thread as the
 * discussion, and Continue offered from the end of the path, with the price this reader would pay
 * said in a chip before they press it.
 */

const chapter = (depth: number, postId: number | null, childCount = 1, title?: string) => ({
  // Ids deliberately out of order: the page must keep the server's order, not sort.
  chapterId: [130, 104, 121, 102, 150][depth],
  depth,
  tombstone: postId ? null : 'browsingLevel',
  post: postId
    ? {
        id: postId,
        title: title ?? null,
        userId: depth ? 11 : 10,
        username: depth ? 'tehalex86' : 'Sillycat83',
      }
    : null,
  childCount,
});

const STORYLINE = {
  id: 2,
  title: 'The Patch',
  status: 'Ongoing',
  whoCanContinue: 'Anyone',
  maxNsfwLevel: 2,
  userId: 10,
  user: { id: 10, username: 'Sillycat83' },
  rootChapterId: 100,
  rootPostId: 501,
  chapterCount: 7,
  contributorCount: 3,
  viewerRole: null as string | null,
  collaborators: [{ id: 11, username: 'tehalex86' }],
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

const COVER = { id: 9001, url: 'cover-of-501', type: 'image', nsfwLevel: 1, userId: 10 };

const mocks = vi.hoisted(() => ({
  storyline: undefined as Record<string, unknown> | undefined,
  loading: false,
  terms: null as { open: boolean; closedReason: string | null; price: number } | null,
  termsFor: vi.fn(),
  coverFor: vi.fn(),
  commentsPostId: vi.fn(),
  openContinue: vi.fn(),
  openManage: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'storyline.getById': {
        useQuery: () => ({ data: mocks.storyline, isLoading: mocks.loading }),
      },
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
// Chapter 1's first image, read per post: the hero and the card cover both show what it returns.
vi.mock('~/components/Storyline/StorylineCover', () => ({
  useStorylineFirstImage: (postId: number | null) => {
    mocks.coverFor(postId);
    return postId ? COVER : null;
  },
  StorylineHero: ({ image }: { image: { url: string } | null }) => (
    <div data-testid="storyline-hero" data-image={image?.url ?? 'none'} />
  ),
}));
vi.mock('~/components/Storyline/StorylineThumb', () => ({
  StorylineThumb: ({ image }: { image: { url: string } | null }) => (
    <div data-testid="storyline-card-cover" data-image={image?.url ?? 'none'} />
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
  mocks.loading = false;
  mocks.terms = null;
  for (const fn of [
    mocks.termsFor,
    mocks.coverFor,
    mocks.commentsPostId,
    mocks.openContinue,
    mocks.openManage,
  ])
    fn.mockReset();
});

const heading = () => page.getByRole('heading', { name: 'The Patch', level: 1 });
const stops = () =>
  page
    .getByRole('region', { name: 'Chapters' })
    .getByTestId('storyline-chapter')
    .elements()
    .map((li) => li.textContent);
const testIds = (id: string) =>
  [...document.querySelectorAll(`[data-testid="${id}"]`)].map((n) => n.textContent);

describe('StorylinePage', () => {
  test('shows the canon path with its forks, the cast and the discussion', async () => {
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    // The hero and the card cover are chapter 1's first image, read for chapter 1's post.
    expect(mocks.coverFor).toHaveBeenLastCalledWith(501);
    expect(page.getByTestId('storyline-hero').element().getAttribute('data-image')).toBe(
      'cover-of-501'
    );
    expect(page.getByTestId('storyline-card-cover').element().getAttribute('data-image')).toBe(
      'cover-of-501'
    );
    expect(testIds('storyline-ceiling-chip')).toContain('Up to PG-13');
    await expect
      .element(page.getByRole('link', { name: 'Start reading' }))
      .toHaveAttribute('href', '/posts/501');

    expect(stops()).toEqual([
      '1Chapter 1The cat patchby Sillycat83',
      // Untitled: named by its number once, not as an eyebrow and a name. A collaborator's
      // chapter carries the Endorsed chip.
      '2Chapter 2by tehalex86EndorsedThe story forks here · 3 paths',
      '3This chapter is hidden by your browsing level',
      '4Chapter 4Framedby tehalex86EndorsedThe story forks here · 2 paths',
    ]);

    expect(page.getByRole('region', { name: 'Contributors' }).element().textContent).toBe(
      'ContributorsSillycat83Creatortehalex86EndorsedTar_Tarj'
    );
    await expect.element(page.getByText('Comments for post 501')).toBeVisible();
    expect(mocks.commentsPostId).toHaveBeenCalledWith(501);
  });

  test('continues from the end of the canon path, and says the price before you press', async () => {
    mocks.terms = { open: true, closedReason: null, price: 0 };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(testIds('storyline-price-chip')).toEqual(['Free to continue', 'Free to continue']);
    await page.getByRole('button', { name: 'Continue the story' }).click();
    expect(mocks.openContinue).toHaveBeenCalledWith({ parentPostId: 504 });
    expect(mocks.termsFor).toHaveBeenLastCalledWith(504);
  });

  test('a priced storyline shows its price in Buzz', async () => {
    mocks.terms = { open: true, closedReason: null, price: 1500 };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(testIds('storyline-price-chip')).toEqual(['1,500 to continue', '1,500 to continue']);
  });

  test.each([
    ['closed', { open: false, closedReason: 'closed', price: 0 }, ['Closed']],
    [
      'collaborators only',
      { open: false, closedReason: 'collaboratorsOnly', price: 0 },
      ['Collaborators only'],
    ],
    ['unknown', null, []],
  ])('a storyline %s to this reader offers no Continue', async (_label, terms, closed) => {
    mocks.terms = terms;
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(page.getByRole('button', { name: /Continue the story/ }).elements()).toHaveLength(0);
    expect(testIds('storyline-price-chip')).toEqual([]);
    expect(testIds('storyline-closed-chip')).toEqual(closed);
  });

  test.each([
    [
      {},
      null,
      'Anyone can continue. Sillycat83 reviews each one; endorsed collaborators skip review.',
    ],
    [{ whoCanContinue: 'Collaborators' }, null, "Only Sillycat83's collaborators can continue it."],
    [
      {},
      { open: false, closedReason: 'closed', price: 0 },
      'This storyline is not taking new chapters right now.',
    ],
    [{ status: 'Complete' }, null, 'This storyline is complete and takes no more chapters.'],
  ])('About continuing says who may continue (%o)', async (extra, terms, sentence) => {
    mocks.storyline = { ...STORYLINE, ...extra };
    mocks.terms = terms;
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(page.getByRole('region', { name: 'About continuing' }).element().textContent).toContain(
      sentence
    );
  });

  // Chapter 1 hidden from this reader: its post, cover and thread must not be reached through
  // the storyline, even though getById carries rootPostId.
  test('a hidden chapter 1 shows no link, cover or thread', async () => {
    mocks.storyline = {
      ...STORYLINE,
      mainPath: [chapter(0, null), ...STORYLINE.mainPath.slice(1)],
    };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(mocks.coverFor).not.toHaveBeenCalledWith(501);
    expect(page.getByTestId('storyline-hero').element().getAttribute('data-image')).toBe('none');
    expect(stops()[0]).toBe('1This chapter is hidden by your browsing level');
    expect(page.getByText('Start reading').elements()).toHaveLength(0);
    expect(mocks.commentsPostId).not.toHaveBeenCalled();
  });

  test('a storyline the viewer cannot open says so instead of rendering a shell', async () => {
    mocks.storyline = undefined;
    renderWithProviders(<StorylinePage id={2} />);

    await expect
      .element(page.getByText("This storyline doesn't exist or isn't available to you."))
      .toBeVisible();
    expect(page.getByText('Start reading').elements()).toHaveLength(0);
  });

  test('loading shows the page skeleton, not the unavailable message', async () => {
    mocks.loading = true;
    mocks.storyline = undefined;
    renderWithProviders(<StorylinePage id={2} />);

    // The harness loads no stylesheet, so the skeleton has no height to be "visible" with.
    await expect.element(page.getByTestId('storyline-page-skeleton')).toBeInTheDocument();
    expect(
      page.getByText("This storyline doesn't exist or isn't available to you.").elements()
    ).toHaveLength(0);
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

  test('counts of one read as one', async () => {
    mocks.storyline = { ...STORYLINE, chapterCount: 1, contributorCount: 1 };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    const header = page.getByRole('banner').element().textContent;
    expect(header).toContain('1 chapter');
    expect(header).not.toContain('1 chapters');
    expect(header).toContain('1 creator');
    expect(header).not.toContain('1 creators');
  });

  test('offers no Continue when the end of the canon path is hidden from this reader', async () => {
    mocks.storyline = { ...STORYLINE, mainPath: [...STORYLINE.mainPath, chapter(4, null, 0)] };
    mocks.terms = { open: true, closedReason: null, price: 0 };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(page.getByRole('button', { name: /Continue the story/ }).elements()).toHaveLength(0);
    expect(mocks.termsFor).toHaveBeenLastCalledWith(undefined);
  });
});
