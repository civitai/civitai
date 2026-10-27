import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as QueriesMod from '~/components/Storyline/storyline.queries';
import type * as RoutedDialogLinkMod from '~/components/Dialog/RoutedDialogLink';
import { StorylinePage } from '~/components/Storyline/StorylinePage';

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
const image = (postId: number) => ({ id: postId * 10, url: `first-of-${postId}`, type: 'image' });

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
  discussion: vi.fn(),
  openContinue: vi.fn(),
  openManage: vi.fn(),
  openFirstChapter: vi.fn(),
  openDialog: vi.fn(),
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
vi.mock('~/components/Storyline/openStorylineFirstChapterModal', () => ({
  openStorylineFirstChapterModal: mocks.openFirstChapter,
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
vi.mock('~/components/CommentsV2/EntityDiscussion', () => ({
  EntityDiscussion: ({ entityType, entityId }: { entityType: string; entityId: number }) => {
    mocks.discussion(entityType, entityId);
    return (
      <div>
        Comments for {entityType} {entityId}
      </div>
    );
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
  mocks.shares = { 104: { total: 20, shares: { 121: 0.62, 160: 0.29, 161: 0.09 } } };
  mocks.graph = undefined;
  for (const fn of [
    mocks.termsFor,
    mocks.discussion,
    mocks.openContinue,
    mocks.openManage,
    mocks.openDialog,
  ])
    fn.mockReset();
});

const heading = () => page.getByRole('heading', { name: 'The Patch', level: 1 });
const stopElements = () =>
  page.getByRole('region', { name: 'Chapters' }).getByTestId('storyline-chapter').elements();
const stops = () => stopElements().map((li) => li.textContent);
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
    expect(testIds('storyline-ceiling-detail')).toEqual(['Up to PG-13']);
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
    expect(page.getByRole('region', { name: 'Contributors' }).element().textContent).toBe(
      'ContributorsSillycat831 chapterCreatortehalex863 chaptersEndorsedTar_Tarj0 chapters'
    );
    await expect.element(page.getByText('Comments for storyline 2')).toBeVisible();
    expect(mocks.discussion).toHaveBeenCalledWith('storyline', 2);
  });

  test('the header carries the title and its counts, and no price, rating or "Started by"', async () => {
    mocks.terms = { open: true, closedReason: null, price: 0 };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    const header = page.getByRole('banner').element();
    expect(header.textContent).toContain('chapters');
    expect(header.textContent).toContain('creators');
    expect(header.textContent).not.toContain('Started by');
    expect(header.textContent).not.toContain('Free to continue');
    expect(header.textContent).not.toContain('Up to');
    // Where they are now: the details under "About continuing".
    const about = page.getByRole('region', { name: 'About continuing' }).element();
    expect(about.textContent).toContain('Free to continue');
    expect(about.textContent).toContain('Up to PG-13');
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
    expect(testIds('storyline-ceiling-detail')).toEqual([]);
  });

  test('a Complete storyline offers no Continue and no price, whatever the terms say', async () => {
    mocks.storyline = { ...STORYLINE, status: 'Complete' };
    mocks.terms = { open: true, closedReason: null, price: 0 };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(page.getByRole('button', { name: /Continue the story/ }).elements()).toHaveLength(0);
    expect(testIds('storyline-price-detail')).toEqual([]);
  });

  test('continues from the end of the canon path, and says the price before you press', async () => {
    mocks.terms = { open: true, closedReason: null, price: 0 };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(testIds('storyline-price-detail')).toEqual(['Free to continue']);
    await page.getByRole('button', { name: 'Continue the story' }).click();
    expect(mocks.openContinue).toHaveBeenCalledWith({ parentPostId: 504 });
    expect(mocks.termsFor).toHaveBeenLastCalledWith(504);
  });

  test('a priced storyline shows its price in Buzz', async () => {
    mocks.terms = { open: true, closedReason: null, price: 1500 };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(testIds('storyline-price-detail')).toEqual(['1,500 Buzz to continue']);
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
    expect(testIds('storyline-price-detail')).toEqual([]);
    expect(testIds('storyline-closed-chip')).toEqual(closed);
  });

  test.each([
    [{}, null, 'Anyone can continueSillycat83 reviews each oneEndorsed collaborators skip review'],
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
      'Anyone can continue'
    );
  });

  // Chapter 1 hidden from this reader: its post and cover must not be reached through the
  // storyline, even though getById carries rootPostId. The storyline's own thread still shows.
  test('a hidden chapter 1 shows no link or cover, and the storyline thread', async () => {
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
    await expect.element(page.getByText('Comments for storyline 2')).toBeVisible();
  });

  test('a storyline with no chapter 1 yet shows no discussion', async () => {
    mocks.storyline = { ...STORYLINE, mainPath: [] };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(mocks.discussion).not.toHaveBeenCalled();
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

  test('the owner can open Manage', async () => {
    mocks.storyline = { ...STORYLINE, viewerRole: 'owner' };
    renderWithProviders(<StorylinePage id={2} />);

    await page.getByRole('button', { name: 'Manage' }).click();
    expect(mocks.openManage).toHaveBeenCalledWith({ storylineId: 2 });
  });

  test('an owner whose storyline has no chapter 1 yet is sent to write it', async () => {
    mocks.storyline = {
      ...STORYLINE,
      viewerRole: 'owner',
      chapterCount: 0,
      contributorCount: 0,
      rootPostId: null,
      mainPath: [],
      contributors: [],
    };
    renderWithProviders(<StorylinePage id={2} />);

    await expect
      .element(page.getByRole('link', { name: 'Write chapter 1' }))
      .toHaveAttribute('href', '/posts/create?storyline=2');
    expect(page.getByRole('link', { name: 'Start reading' }).elements()).toHaveLength(0);
  });

  test('an owner whose storyline has no chapter 1 yet can use a post already published', async () => {
    mocks.storyline = {
      ...STORYLINE,
      viewerRole: 'owner',
      chapterCount: 0,
      contributorCount: 0,
      rootPostId: null,
      mainPath: [],
      contributors: [],
    };
    renderWithProviders(<StorylinePage id={2} />);

    await page.getByRole('button', { name: "Use a post you've published" }).click();
    expect(mocks.openFirstChapter).toHaveBeenCalledWith({ storylineId: 2 });
  });

  test.each([
    ['a stranger, on an empty storyline', { viewerRole: null, chapterCount: 0, mainPath: [] }],
    [
      'a collaborator, on an empty storyline',
      { viewerRole: 'collaborator', chapterCount: 0, mainPath: [] },
    ],
    ['the owner, once chapter 1 exists', { viewerRole: 'owner' }],
  ])('%s is not offered a published post as chapter 1', async (_, overrides) => {
    mocks.storyline = { ...STORYLINE, contributors: [], ...overrides };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(
      page.getByRole('button', { name: "Use a post you've published" }).elements()
    ).toHaveLength(0);
  });

  test('no one else is offered "Write chapter 1"', async () => {
    mocks.storyline = {
      ...STORYLINE,
      viewerRole: null,
      chapterCount: 0,
      mainPath: [],
      contributors: [],
    };
    renderWithProviders(<StorylinePage id={2} />);

    await expect.element(heading()).toBeVisible();
    expect(page.getByRole('link', { name: 'Write chapter 1' }).elements()).toHaveLength(0);
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

  test('the chapters list draws the other paths in lanes, with labelled forks and joins', async () => {
    const graphChapter = (chapterId: number, postId: number, title?: string, userId?: 10 | 11) => ({
      ...chapter(0, postId, 1, title, userId),
      chapterId,
    });
    // Chapter 2 forks into the canon chapter 3 and tehalex86's branch, which joins back at 4.
    mocks.storyline = {
      ...STORYLINE,
      mainPath: [
        chapter(0, 501, 1, 'The cat patch'),
        chapter(1, 502, 2),
        chapter(2, 503, 1, undefined, 10),
        { ...chapter(3, 504, 1, 'Framed'), parentCount: 2 },
      ],
    };
    mocks.graph = {
      rootChapterId: 130,
      chapters: [
        graphChapter(130, 501, 'The cat patch', 10),
        graphChapter(104, 502),
        graphChapter(121, 503, undefined, 10),
        graphChapter(160, 560, 'Rest in pieces', 11),
        graphChapter(102, 504, 'Framed'),
      ],
      edges: [
        { chapterId: 104, parentChapterId: 130, canon: true },
        { chapterId: 121, parentChapterId: 104, canon: true },
        { chapterId: 160, parentChapterId: 104, canon: false },
        { chapterId: 102, parentChapterId: 121, canon: true },
        { chapterId: 102, parentChapterId: 160, canon: false },
      ],
      truncated: false,
    };
    renderWithProviders(<StorylinePage id={2} />);

    const branch = page.getByRole('list', { name: 'Chapters on other paths' }).getByRole('link', {
      name: 'Rest in pieces, 29% of readers',
    });
    await expect.element(branch).toHaveAttribute('href', '/images/5600?storylineChapter=160');
    // Each way on from the fork carries its own share of readers: canon chapter 3 its 62%.
    expect(stops()).toEqual([
      '1Chapter 1The cat patchSillycat83',
      '2Chapter 2tehalex86Endorsed',
      '362%Chapter 3, 62% of readersSillycat83',
      '4Chapter 4Framedtehalex86Endorsed',
    ]);
    expect(branch.element().textContent).toBe('29%');
    // The branch sits beside chapter 3, between the canon rows on either side of it.
    const rowTop = (el: Element) => (el as HTMLElement).style.top;
    const branchStop = branch.element().closest('[data-testid="storyline-lane-node"]')!;
    expect(parseFloat(rowTop(branchStop))).toBeGreaterThan(parseFloat(rowTop(stopElements()[1])));
    expect(parseFloat(rowTop(branchStop))).toBeLessThan(parseFloat(rowTop(stopElements()[3])));
    // The harness frame is phone width, so the fork band has its short copy.
    expect(testIds('storyline-fork')).toEqual(['Forks after ch 2 · 2 paths']);
    expect(testIds('storyline-rejoin')).toEqual(["tehalex86's path joins here"]);

    // Chapter 4 opens on the canon route, through chapter 3.
    (branch.element() as HTMLElement).click();
    expect(mocks.openDialog).toHaveBeenLastCalledWith({
      name: 'imageDetail',
      state: { imageId: 5600, storylineChapterId: 160, storylineVia: [] },
    });
    await page.getByRole('link', { name: 'Framed' }).click();
    expect(mocks.openDialog).toHaveBeenLastCalledWith({
      name: 'imageDetail',
      state: { imageId: 5040, storylineChapterId: 102, storylineVia: [121] },
    });
  });
});
