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

const AUTHORS = {
  10: 'Sillycat83',
  11: 'tehalex86',
  12: 'Tar_Tarj',
} as const;
const chapter = (
  depth: number,
  postId: number | null,
  childCount = 1,
  title?: string,
  // The owner wrote chapter 1, a collaborator the rest, unless a test says otherwise.
  userId: keyof typeof AUTHORS = depth ? 11 : 10
) => ({
  // Ids deliberately out of order: the page must keep the server's order, not sort.
  chapterId: [130, 104, 121, 102, 150][depth],
  depth,
  tombstone: postId ? null : 'browsingLevel',
  post: postId ? { id: postId, title: title ?? null, userId, username: AUTHORS[userId] } : null,
  childCount,
});

// The ways on from chapter 2 (chapter id 104), in the order the end of the chapter ranks them.
const FORK_104 = [
  { ...chapter(2, 503, 1, undefined, 10), chapterId: 121, rank: 'canon' },
  { ...chapter(2, 560, 1, 'Rest in pieces', 11), chapterId: 160, rank: 'endorsed' },
  { ...chapter(2, null), chapterId: 161, tombstone: 'aboveStoryRating', rank: 'community' },
];

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
  children: {} as Record<number, unknown[]>,
  shares: {} as Record<number, unknown>,
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
  useStorylineChildren: (chapterId: number) => ({ data: mocks.children[chapterId] }),
  useStorylineForkShares: (chapterId: number) => ({ data: mocks.shares[chapterId] }),
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
  StorylineHero: ({ image, backdrop }: { image: { url: string } | null; backdrop?: boolean }) => (
    <div
      data-testid="storyline-hero"
      data-image={image?.url ?? 'none'}
      data-backdrop={String(!!backdrop)}
    />
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
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) => <span>{user.username}</span>,
}));

beforeEach(() => {
  mocks.storyline = { ...STORYLINE };
  mocks.loading = false;
  mocks.terms = null;
  mocks.children = { 104: FORK_104 };
  mocks.shares = { 104: { total: 20, shares: { 121: 0.62, 160: 0.29, 161: 0.09 } } };
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
const stopElements = () =>
  page.getByRole('region', { name: 'Chapters' }).getByTestId('storyline-chapter').elements();
/** Each stop's own text, without the fork block under it. */
const stops = () =>
  stopElements().map((li) => {
    const own = li.cloneNode(true) as HTMLElement;
    own.querySelector('[data-testid="storyline-fork"]')?.remove();
    return own.textContent;
  });
/** Per stop, the ways on listed under it, or null where the story does not fork. */
const forks = () =>
  stopElements().map((li) => {
    const fork = li.querySelector('[data-testid="storyline-fork"]');
    if (!fork) return null;
    return [...fork.querySelectorAll('[data-testid="storyline-fork-path"]')].map((row) => ({
      text: row.textContent,
      href: row.querySelector('a')?.getAttribute('href') ?? null,
    }));
  });
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
    // No banner can be picked yet, so chapter 1's portrait is a backdrop, never a wide crop.
    expect(page.getByTestId('storyline-hero').element().getAttribute('data-backdrop')).toBe('true');
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
      '2Chapter 2by tehalex86Endorsed',
      '3This chapter is hidden by your browsing level',
      '4Chapter 4Framedby tehalex86Endorsed',
    ]);
    // Each way on from a fork, ranked, named, linked to its post, with its share; a hidden one
    // keeps its place without a link.
    expect(forks()).toEqual([
      null,
      [
        { text: 'CanonChapter 3by Sillycat8362%', href: '/posts/503' },
        { text: 'EndorsedRest in piecesby tehalex8629%', href: '/posts/560' },
        { text: "This chapter is rated above the storyline's maximum9%", href: null },
      ],
      null,
      // Its ways on have not arrived: the note alone.
      [],
    ]);
    expect(
      stopElements()
        .map(
          (li) => li.querySelector('[data-testid="storyline-fork"]')?.firstElementChild?.textContent
        )
        .filter(Boolean)
    ).toEqual(['The story forks here · 3 paths', 'The story forks here · 2 paths']);

    expect(page.getByRole('region', { name: 'Contributors' }).element().textContent).toBe(
      'ContributorsSillycat83Creatortehalex86EndorsedTar_Tarj'
    );
    await expect.element(page.getByText('Comments for post 501')).toBeVisible();
    expect(mocks.commentsPostId).toHaveBeenCalledWith(501);
  });

  test('only collaborators are marked Endorsed: the owner and other contributors are not', async () => {
    mocks.storyline = {
      ...STORYLINE,
      mainPath: [
        chapter(0, 501, 1, 'The cat patch', 10),
        chapter(1, 502, 1, 'By a stranger', 12),
        chapter(2, 503, 1, 'By a collaborator', 11),
      ],
    };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(
      stopElements().map((li) => !!li.querySelector('[data-testid="storyline-role-chip"]'))
    ).toEqual([false, false, true]);
  });

  test('a ceiling with no label shows no ceiling chip', async () => {
    mocks.storyline = { ...STORYLINE, maxNsfwLevel: 0 };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(testIds('storyline-ceiling-chip')).toEqual([]);
  });

  test('a Complete storyline offers no Continue and no price, whatever the terms say', async () => {
    mocks.storyline = { ...STORYLINE, status: 'Complete' };
    mocks.terms = { open: true, closedReason: null, price: 0 };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(page.getByRole('button', { name: /Continue the story/ }).elements()).toHaveLength(0);
    expect(testIds('storyline-price-chip')).toEqual([]);
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
      { whoCanContinue: 'Collaborators' },
      { open: false, closedReason: 'collaboratorsOnly', price: 0 },
      "Only Sillycat83's collaborators can continue it.",
    ],
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

  // The server answers the owner "closed" because they never continue their own storyline; the
  // page must not tell them their storyline is closed.
  test('the owner is not told their open storyline is closed', async () => {
    mocks.storyline = { ...STORYLINE, viewerRole: 'owner' };
    mocks.terms = { open: false, closedReason: 'closed', price: 0 };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(testIds('storyline-closed-chip')).toEqual([]);
    expect(page.getByRole('region', { name: 'About continuing' }).element().textContent).toContain(
      'Anyone can continue.'
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
