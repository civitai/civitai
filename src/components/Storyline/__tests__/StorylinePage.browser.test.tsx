import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as QueriesMod from '~/components/Storyline/storyline.queries';
import type * as RoutedDialogLinkMod from '~/components/Dialog/RoutedDialogLink';
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
  post: postId
    ? {
        id: postId,
        title: title ?? null,
        userId,
        username: AUTHORS[userId],
        user: { id: userId, username: AUTHORS[userId] },
      }
    : null,
  childCount,
  firstImage: postId ? image(postId) : null,
});
/** The first image the server picked for a chapter's post. */
const image = (postId: number) => ({ id: postId * 10, url: `first-of-${postId}`, type: 'image' });

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
  coverImage: { id: 9001, url: 'cover-pick', type: 'image', nsfwLevel: 1 },
  heroImage: { id: 9001, url: 'cover-pick', type: 'image', nsfwLevel: 1 },
  heroIsBanner: false,
  heroImagePosition: 30,
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
    { user: { id: 10, username: 'Sillycat83' }, role: 'creator', chapterCount: 1 },
    { user: { id: 11, username: 'tehalex86' }, role: 'endorsed', chapterCount: 3 },
    { user: { id: 12, username: 'Tar_Tarj' }, role: 'contributor', chapterCount: 0 },
  ],
};

const mocks = vi.hoisted(() => ({
  storyline: undefined as Record<string, unknown> | undefined,
  loading: false,
  terms: null as { open: boolean; closedReason: string | null; price: number } | null,
  termsFor: vi.fn(),
  commentsPostId: vi.fn(),
  openContinue: vi.fn(),
  openManage: vi.fn(),
  openDialog: vi.fn(),
  children: {} as Record<number, unknown[]>,
  shares: {} as Record<number, unknown>,
  graph: undefined as Record<string, unknown> | undefined,
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
  // Unmocked, it reads the feature flags, which this scaffold does not provide.
  useStorylineGraph: () => ({ data: mocks.graph, isLoading: false }),
}));
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkMod>()),
  triggerRoutedDialog: mocks.openDialog,
}));
vi.mock('~/components/Storyline/continue/openStorylineContinueModal', () => ({
  openStorylineContinueModal: mocks.openContinue,
}));
vi.mock('~/components/Storyline/manage/openStorylineManageModal', () => ({
  openStorylineManageModal: mocks.openManage,
}));
vi.mock('~/components/Storyline/StorylineCover', () => ({
  StorylineHero: ({
    image,
    position,
    backdrop,
  }: {
    image: { url: string } | null;
    position?: number;
    backdrop?: boolean;
  }) => (
    <div
      data-testid="storyline-hero"
      data-image={image?.url ?? 'none'}
      data-position={String(position)}
      data-backdrop={String(!!backdrop)}
    />
  ),
}));
vi.mock('~/components/Storyline/StorylineThumb', () => ({
  StorylineThumb: ({
    image,
    ratio,
    children,
  }: {
    image: { url: string } | null;
    ratio?: string;
    children?: React.ReactNode;
  }) => (
    <div
      data-testid="storyline-thumb"
      data-image={image?.url ?? 'none'}
      data-ratio={ratio ?? '3/4'}
    >
      {children}
    </div>
  ),
}));
vi.mock('~/components/Post/Detail/PostComments', () => ({
  PostComments: ({ postId }: { postId: number }) => {
    mocks.commentsPostId(postId);
    return <div>Comments for post {postId}</div>;
  },
}));
// The header's report menu reads the session, which this scaffold does not mount: unmocked,
// `useCurrentUser` throws and the whole page renders nothing. A signed-out reader.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user, subText }: { user: { username: string }; subText?: string }) => (
    <span>
      {user.username}
      {subText}
    </span>
  ),
}));

beforeEach(() => {
  mocks.storyline = { ...STORYLINE };
  mocks.loading = false;
  mocks.terms = null;
  mocks.children = { 104: FORK_104 };
  mocks.shares = { 104: { total: 20, shares: { 121: 0.62, 160: 0.29, 161: 0.09 } } };
  mocks.graph = undefined;
  for (const fn of [
    mocks.termsFor,
    mocks.commentsPostId,
    mocks.openContinue,
    mocks.openManage,
    mocks.openDialog,
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
/** The image each thumb under `root` shows, in order. */
const thumbs = (root: Element) =>
  [...root.querySelectorAll('[data-testid="storyline-thumb"]')].map((n) => ({
    image: n.getAttribute('data-image'),
    ratio: n.getAttribute('data-ratio'),
  }));
const cardCover = () => thumbs(page.getByRole('banner').element());
const hero = () => {
  const el = page.getByTestId('storyline-hero').element();
  return {
    image: el.getAttribute('data-image'),
    backdrop: el.getAttribute('data-backdrop'),
    position: el.getAttribute('data-position'),
  };
};
const testIds = (id: string) =>
  [...document.querySelectorAll(`[data-testid="${id}"]`)].map((n) => n.textContent);

describe('StorylinePage', () => {
  test('shows the canon path with its forks, the cast and the discussion', async () => {
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    // No banner picked: the server's hero is a portrait, so it is a backdrop, never a wide crop.
    expect(hero()).toEqual({ image: 'cover-pick', backdrop: 'true', position: '30' });
    expect(cardCover()).toEqual([{ image: 'cover-pick', ratio: '3/4' }]);
    expect(testIds('storyline-ceiling-chip')).toContain('Up to PG-13');
    await expect
      .element(page.getByRole('link', { name: 'Start reading' }))
      .toHaveAttribute('href', '/images/5010?storylineChapter=130');

    expect(stops()).toEqual([
      '1Chapter 1The cat patchSillycat83',
      // Untitled: named by its number once, not as an eyebrow and a name. A collaborator's
      // chapter carries the Endorsed chip.
      '2Chapter 2tehalex86Endorsed',
      '3This chapter is hidden by your browsing level',
      '4Chapter 4Framedtehalex86Endorsed',
    ]);
    // Each chapter shows its own first image as a 4:5 thumb; a hidden chapter shows none.
    expect(
      stopElements().map((li) => {
        const own = li.cloneNode(true) as HTMLElement;
        own.querySelector('[data-testid="storyline-fork"]')?.remove();
        return thumbs(own);
      })
    ).toEqual([
      [{ image: 'first-of-501', ratio: '4/5' }],
      [{ image: 'first-of-502', ratio: '4/5' }],
      [],
      [{ image: 'first-of-504', ratio: '4/5' }],
    ]);
    // Each way on from a fork, ranked, named, opening the reader, with its share; a hidden one
    // keeps its place without a link.
    expect(forks()).toEqual([
      null,
      [
        { text: 'Canon62%Chapter 3Sillycat83', href: '/images/5030?storylineChapter=121' },
        {
          text: 'Endorsed29%Rest in piecestehalex86',
          href: '/images/5600?storylineChapter=160',
        },
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
    // Each way on shows its own first image as a 3:4 cover; the hidden one shows none.
    expect(thumbs(stopElements()[1].querySelector('[data-testid="storyline-fork"]')!)).toEqual([
      { image: 'first-of-503', ratio: '3/4' },
      { image: 'first-of-560', ratio: '3/4' },
    ]);

    expect(page.getByRole('region', { name: 'Contributors' }).element().textContent).toBe(
      'ContributorsSillycat831 chapterCreatortehalex863 chaptersEndorsedTar_Tarj0 chapters'
    );
    await expect.element(page.getByText('Comments for post 501')).toBeVisible();
    expect(mocks.commentsPostId).toHaveBeenCalledWith(501);
  });

  test('a picked banner shows sharp at its focus', async () => {
    mocks.storyline = {
      ...STORYLINE,
      heroImage: { id: 77, url: 'banner-pick', type: 'image', nsfwLevel: 1 },
      heroIsBanner: true,
      heroImagePosition: 80,
    };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(hero()).toEqual({ image: 'banner-pick', backdrop: 'false', position: '80' });
    // The card keeps the cover, not the banner.
    expect(cardCover()).toEqual([{ image: 'cover-pick', ratio: '3/4' }]);
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
      // The server drops chapter 1's image from the hero and cover when it is hidden.
      heroImage: null,
      coverImage: null,
      mainPath: [chapter(0, null), ...STORYLINE.mainPath.slice(1)],
    };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(hero().image).toBe('none');
    expect(cardCover()).toEqual([{ image: 'none', ratio: '3/4' }]);
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

  test('a chapter past a rejoin opens the reader on the canon route, over the page', async () => {
    // Chapter 4 has two parents: its link must say it is reached through chapter 3 (id 121).
    mocks.storyline = {
      ...STORYLINE,
      mainPath: [
        ...STORYLINE.mainPath.slice(0, 2),
        chapter(2, 503),
        { ...chapter(3, 504, 1, 'Framed'), parentCount: 2 },
      ],
    };
    renderWithProviders(<StorylinePage id={2} />);

    const framed = page.getByRole('link', { name: 'Framed' });
    await expect
      .element(framed)
      .toHaveAttribute('href', '/images/5040?storylineChapter=102&storylineVia=121');
    await framed.click();
    expect(mocks.openDialog).toHaveBeenCalledWith({
      name: 'imageDetail',
      state: { imageId: 5040, storylineChapterId: 102, storylineVia: [121] },
    });
    await page.getByRole('link', { name: 'Start reading' }).click();
    expect(mocks.openDialog).toHaveBeenLastCalledWith({
      name: 'imageDetail',
      state: { imageId: 5010, storylineChapterId: 130, storylineVia: [] },
    });
  });

  test('a fork path is numbered on the route its link opens, not by its stored depth', async () => {
    // Stored depth 7, from an older parent: under chapter 2 it is chapter 3 here and in the reader.
    mocks.children = { 104: [{ ...FORK_104[0], depth: 7 }] };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(forks()[1]).toEqual([
      { text: 'Canon62%Chapter 3Sillycat83', href: '/images/5030?storylineChapter=121' },
    ]);
  });

  test('a Story map chapter opens the reader over the page too', async () => {
    const graphChapter = (chapterId: number, postId: number, title: string | null = null) => ({
      ...chapter(0, postId, 1, title ?? undefined),
      chapterId,
    });
    mocks.graph = {
      rootChapterId: 130,
      chapters: [
        graphChapter(130, 501, 'The cat patch'),
        graphChapter(104, 502),
        graphChapter(121, 503),
        graphChapter(160, 560, 'Rest in pieces'),
      ],
      edges: [
        { chapterId: 104, parentChapterId: 130, canon: true },
        { chapterId: 121, parentChapterId: 104, canon: true },
        { chapterId: 160, parentChapterId: 104, canon: false },
      ],
      truncated: false,
    };
    renderWithProviders(<StorylinePage id={2} />);

    const node = page.getByRole('list', { name: 'Story map' }).getByRole('link', {
      name: /Rest in pieces/,
    });
    await expect.element(node).toHaveAttribute('href', '/images/5600?storylineChapter=160');
    // The mocked thumb has no size, so the tile has nothing to click by pointer.
    (node.element() as HTMLElement).click();
    expect(mocks.openDialog).toHaveBeenCalledWith({
      name: 'imageDetail',
      state: { imageId: 5600, storylineChapterId: 160, storylineVia: [] },
    });
  });
});
